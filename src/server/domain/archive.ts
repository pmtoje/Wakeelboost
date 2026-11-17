/* eslint-disable @typescript-eslint/no-explicit-any -- facility record rows are read straight from SQL for reporting */
/**
 * Facility document repository and consolidated ZIP archive.
 *
 * - The repository (facility_archives row) opens when the facility receives its reference.
 * - Documents are stored against the facility as it progresses (documents table, versioned).
 * - When the facility closes, the archive is queued and generated automatically: every retained
 *   document (current versions by section, earlier versions kept under _previous-versions) plus a
 *   facility record workbook built from the system's own records (no placeholder documents), and a
 *   manifest with SHA-256 checksums. The ZIP is stored encrypted against the facility and opened
 *   through the facility record with the normal case access checks; generation and downloads are
 *   audited. Failures are retried safely and shown as "Generation failed".
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { sha256Hex } from "../crypto";
import { DomainError, forbidden, gate, notFound } from "../errors";
import { formatKobo } from "../money";
import { maskWithLast4 } from "../mask";
import { formatLagos } from "../time";
import { objectStore } from "../storage";
import { holdsRole } from "./access";
import { CATEGORY_LABEL, storeGeneratedDocument } from "./documents";
import { STAGE_LABELS, type Stage } from "./stages";
import { ROLE_LABELS, type Role } from "./roles";

export type ArchiveStatus = "IN_PROGRESS" | "QUEUED" | "COMPLETE" | "FAILED";
export interface ArchiveRow {
  id: string;
  application_id: string;
  status: ArchiveStatus;
  opened_at: Date;
  queued_at: Date | null;
  generated_at: Date | null;
  generation_no: number;
  document_id: string | null;
  filename: string | null;
  size_bytes: string | null;
  sha256: string | null;
  file_count: number | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
}

/** Archive sections, in order, and the document categories filed in each. */
export const ARCHIVE_SECTIONS: { folder: string; categories: string[] }[] = [
  { folder: "01-Financing-application", categories: ["APPLICATION_FORM", "CONSENT_FORM"] },
  { folder: "02-KYC", categories: ["KYC"] },
  { folder: "03-Business-documentation", categories: ["CAC_CERTIFICATE", "BANK_STATEMENT", "RENT_RECEIPT"] },
  { folder: "04-Supplier-invoice", categories: ["SUPPLIER_INVOICE"] },
  { folder: "05-Credit-assessment", categories: ["CREDIT_REPORT", "DSR_EXCEPTION_EVIDENCE"] },
  { folder: "06-Murabaha-offer-letter", categories: ["GENERATED_OFFER", "GENERATED_OFFER_PDF"] },
  { folder: "07-Signed-offer-letter", categories: ["SIGNED_OFFER"] },
  { folder: "08-Asset-purchase-and-sale", categories: ["PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED", "INSURANCE_EVIDENCE"] },
  { folder: "09-Supporting-correspondence", categories: ["SUPPORTING"] },
];
const RECORD_FOLDER = "00-Facility-record";

/** CUSTOMER_NAME_WB-2026-000123.zip: upper-case, safe characters only, reference keeps facilities distinct. */
export function archiveFilename(customerName: string | null, ref: string) {
  const name = (customerName || "CUSTOMER")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "CUSTOMER";
  return `${name}_${ref.replace(/[^A-Za-z0-9-]/g, "")}.zip`;
}
function safeEntry(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";
}

export async function archiveFor(q: Db, appId: string): Promise<ArchiveRow | null> {
  return (await q.query<ArchiveRow>("SELECT * FROM facility_archives WHERE application_id = $1", [appId])).rows[0] ?? null;
}

/** Open the facility's repository when it receives its reference (idempotent). */
export async function openRepository(tx: Tx, ctx: Ctx, appId: string) {
  const r = await tx.query("INSERT INTO facility_archives (application_id, status, opened_at) VALUES ($1,'IN_PROGRESS',$2) ON CONFLICT (application_id) DO NOTHING RETURNING id", [appId, ctx.now]);
  if (r.rowCount) await audit(tx, ctx, { action: "FACILITY_REPOSITORY_OPENED", applicationId: appId, details: { archiveId: r.rows[0].id } });
}

/** Facility completed: queue the consolidated archive (inside the closing transaction). */
export async function queueArchive(tx: Tx, ctx: Ctx, appId: string) {
  await openRepository(tx, ctx, appId);
  await tx.query("UPDATE facility_archives SET status = 'QUEUED', queued_at = $2, next_attempt_at = $2, last_error = NULL WHERE application_id = $1 AND status IN ('IN_PROGRESS','FAILED')", [appId, ctx.now]);
  await audit(tx, ctx, { action: "FACILITY_ARCHIVE_QUEUED", applicationId: appId });
}

interface DocRow {
  id: string;
  category: string;
  version_no: number;
  filename: string;
  mime_type: string;
  sha256: string;
  storage_key: string;
  scan_status: string;
  superseded_at: Date | null;
  purged_at: Date | null;
  uploaded_at: Date;
  uploaded_by: string;
  generated: boolean;
}

async function facilityRecord(q: Db, app: Record<string, any>, manifest: { path: string; sha256: string; category: string; version: number; note?: string }[]): Promise<Buffer> {
  const people = new Map<string, string>(
    (await q.query("SELECT s.id, s.full_name FROM staff s WHERE s.id IN (SELECT actor_id FROM decisions WHERE application_id = $1 UNION SELECT $2::uuid UNION SELECT recorded_by FROM disbursements WHERE application_id = $1)", [app.id, app.initiator_id])).rows.map((r) => [r.id, r.full_name]),
  );
  const who = (id: string | null) => (id ? people.get(id) ?? id : "");
  const version = app.current_version_id ? (await q.query("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0] : null;
  const data = (version?.data ?? {}) as Record<string, any>;
  const wb = new ExcelJS.Workbook();
  wb.creator = "WakeelBoost Work Desk · The Alternative Bank";
  wb.created = new Date();

  // Summary (with the bank's official logo)
  const sum = wb.addWorksheet("Summary");
  try {
    const logo = wb.addImage({ buffer: (await readFile(path.resolve(process.cwd(), "public/brand/altbank-logo-on-light.png"))) as unknown as ExcelJS.Buffer, extension: "png" });
    sum.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 190, height: 90 } });
  } catch {
    /* logo asset unavailable: the record is still produced */
  }
  sum.getColumn(1).width = 34;
  sum.getColumn(2).width = 70;
  const rows: [string, unknown][] = [
    ["Facility reference", app.ref],
    ["Customer", app.customer_name],
    ["Applicant type", app.applicant_type],
    ["BVN", maskWithLast4(version?.bvn_last4)],
    ["Business name", data.businessName || data.companyName || ""],
    ["Financing purpose / goods", (data.items ?? []).map((i: any) => `${i.quantity} × ${i.description}`).join("; ")],
    ["Supplier", [data.supplierName, data.supplierAddress, data.supplierPhone].filter(Boolean).join(", ")],
    ["Supplier invoice reference", data.invoiceRef ?? ""],
    ["Requested amount", app.requested_amount_kobo ? formatKobo(Number(app.requested_amount_kobo)) : ""],
    ["Credit route", app.route ? `Route ${app.route}` : ""],
    ["Initiator", `${who(app.initiator_id)} (${app.initiator_role})`],
    ["Credit check", app.credit_check_status],
    ["Status", `${app.status} · ${STAGE_LABELS[app.stage as Stage] ?? app.stage}`],
    ["Created", formatLagos(app.created_at)],
    ["Submitted", app.submitted_at ? formatLagos(app.submitted_at) : ""],
    ["Disbursed", app.disbursed_at ? formatLagos(app.disbursed_at) : ""],
    ["Completed (vendor confirmed)", app.vendor_confirmed_at ? formatLagos(app.vendor_confirmed_at) : ""],
    ["Archive generated", formatLagos(new Date())],
  ];
  sum.addRow([]);
  sum.addRow([]);
  sum.addRow([]);
  sum.addRow([]);
  sum.addRow(["WakeelBoost facility record", "Generated from the Work Desk records. Values are as recorded; nothing is inferred."]).font = { bold: true };
  for (const r of rows) sum.addRow(r);

  // Credit check
  const cc = wb.addWorksheet("Credit check");
  cc.addRow(["Attempt", "Requested", "Responded", "Status", "Outcome", "Overall Seed Score", "Reviewed Seed Score", "Credit history", "SeedFi reference", "Environment", "Reasons", "Rules version", "Consent", "Error"]).font = { bold: true };
  for (const c of (await q.query("SELECT * FROM credit_checks WHERE application_id = $1 ORDER BY attempt_no", [app.id])).rows) {
    cc.addRow([c.attempt_no, formatLagos(c.requested_at), c.responded_at ? formatLagos(c.responded_at) : "", c.status, c.outcome ?? "", c.overall_score ?? "", c.reviewed_score ?? "", c.has_credit_history ?? "", c.provider_reference ?? "", c.provider_environment, (c.outcome_reasons ?? []).join("; "), c.settings_version ?? "", `${c.consent_method} ${formatLagos(c.consent_at)}`, c.error_message ?? ""]);
  }
  if (app.credit_check_status === "NOT_REQUIRED") cc.addRow([app.credit_check_note ?? "Not required"]);

  // Decisions: Product Manager review and approvals
  const dec = (await q.query("SELECT * FROM decisions WHERE application_id = $1 ORDER BY seq", [app.id])).rows;
  const pm = wb.addWorksheet("Product Manager review");
  pm.addRow(["Time", "Stage", "Action", "By", "Role", "Reason"]).font = { bold: true };
  for (const d of dec.filter((x) => x.stage === "CREDIT_REVIEW" || x.stage === "CREDIT_CLARIFICATION")) pm.addRow([formatLagos(d.created_at), STAGE_LABELS[d.stage as Stage] ?? d.stage, d.action, who(d.actor_id), ROLE_LABELS[d.actor_role as Role] ?? d.actor_role, d.reason ?? ""]);
  const ap = wb.addWorksheet("Approvals");
  ap.addRow(["Time", "Stage", "Action", "By", "Role", "Reason", "Invalidated"]).font = { bold: true };
  for (const d of dec.filter((x) => x.stage !== "CREDIT_REVIEW" && x.stage !== "CREDIT_CLARIFICATION")) ap.addRow([formatLagos(d.created_at), STAGE_LABELS[d.stage as Stage] ?? d.stage, d.action, who(d.actor_id), ROLE_LABELS[d.actor_role as Role] ?? d.actor_role, d.reason ?? "", d.invalidated_at ? `${formatLagos(d.invalidated_at)} ${d.invalidated_reason ?? ""}` : ""]);

  // Assessment (approved)
  const as = wb.addWorksheet("Credit assessment");
  as.addRow(["Assessed", "Calculator", "Principal / cost", "Markup", "Total selling price", "APR %", "DSR %", "Threshold result", "Superseded"]).font = { bold: true };
  for (const a of (await q.query("SELECT * FROM credit_assessments WHERE application_id = $1 ORDER BY created_at", [app.id])).rows) {
    as.addRow([formatLagos(a.created_at), `${a.calculator_id}@${a.calculator_version}`, formatKobo(Number(a.outputs?.amountApprovedKobo ?? a.inputs?.principalKobo ?? 0)), formatKobo(Number(a.markup_kobo)), formatKobo(Number(a.cost_plus_markup_kobo)), Number(a.apr_percent), Number(a.dsr_percent), a.threshold_result ?? "", a.superseded_at ? formatLagos(a.superseded_at) : ""]);
  }

  // Offer letter lifecycle
  const ol = wb.addWorksheet("Offer letter");
  ol.addRow(["Issue", "Status", "Trigger", "Template version", "Issued / available", "Acceptance", "Signed", "Attempts", "Last error"]).font = { bold: true };
  for (const l of (await q.query("SELECT * FROM offer_letters WHERE application_id = $1 ORDER BY issue_no", [app.id])).rows) {
    ol.addRow([l.issue_no, l.status, l.trigger, l.template_version ?? "", l.issued_at ? formatLagos(l.issued_at) : "", l.acceptance_status, l.signed_at ? formatLagos(l.signed_at) : "", l.attempts, l.last_error ?? ""]);
  }

  // Disbursement and repayment schedule
  const ds = wb.addWorksheet("Disbursement");
  const d = (await q.query("SELECT * FROM disbursements WHERE application_id = $1", [app.id])).rows[0];
  ds.addRow(["Disbursed amount", "Approved amount", "Disbursement date", "Transaction reference", "Recorded by", "Recorded at"]).font = { bold: true };
  if (d) ds.addRow([formatKobo(Number(d.amount_kobo)), formatKobo(Number(d.approved_amount_kobo)), String(d.disbursed_on instanceof Date ? d.disbursed_on.toISOString().slice(0, 10) : d.disbursed_on), d.transaction_ref, who(d.recorded_by), formatLagos(d.recorded_at)]);
  const rs = wb.addWorksheet("Repayment schedule");
  rs.addRow(["Instalment", "Due date", "Amount"]).font = { bold: true };
  for (const r of (await q.query("SELECT * FROM repayment_instalments WHERE application_id = $1 ORDER BY seq", [app.id])).rows) rs.addRow([r.seq, String(r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : r.due_date), formatKobo(Number(r.amount_kobo))]);

  // Completion
  const cp = wb.addWorksheet("Completion");
  const ce = (await q.query("SELECT c.*, o.status AS delivery_status, o.sent_at FROM closure_events c LEFT JOIN notification_outbox o ON o.id = c.outbox_id WHERE c.application_id = $1", [app.id])).rows[0];
  cp.addRow(["Process completed", "By", "Closure email to", "Delivery", "Sent", "Vendor payment confirmed"]).font = { bold: true };
  if (ce) cp.addRow([formatLagos(ce.completed_at), who(ce.completed_by), (ce.groups ?? []).join(", "), `${ce.delivery_mode} · ${ce.delivery_status ?? ""}`, ce.sent_at ? formatLagos(ce.sent_at) : "", app.vendor_confirmed_at ? formatLagos(app.vendor_confirmed_at) : ""]);

  // Audit trail (already sanitised at write time: identifiers masked)
  const au = wb.addWorksheet("Audit trail");
  au.addRow(["Time", "Action", "Outcome", "Actor", "Role", "Stage", "Reason"]).font = { bold: true };
  for (const e of (await q.query("SELECT occurred_at, action, outcome, actor_email, actor_role, stage, reason FROM audit_events WHERE application_id = $1 ORDER BY id", [app.id])).rows) {
    au.addRow([formatLagos(e.occurred_at), e.action, e.outcome, e.actor_email ?? "system", e.actor_role ?? "", e.stage ?? "", e.reason ?? ""]);
  }

  // Manifest
  const mf = wb.addWorksheet("Document manifest");
  mf.addRow(["Path in archive", "Category", "Version", "SHA-256", "Note"]).font = { bold: true };
  for (const m of manifest) mf.addRow([m.path, CATEGORY_LABEL[m.category] ?? m.category, m.version, m.sha256, m.note ?? ""]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Build the ZIP for one facility (pure read; returns the archive buffer and its manifest). */
export async function buildArchive(q: Db, appId: string) {
  const app = (await q.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) throw notFound();
  const docs = (await q.query<DocRow>("SELECT * FROM documents WHERE application_id = $1 AND category <> 'FACILITY_ARCHIVE' ORDER BY category, version_no", [appId])).rows;
  const zip = new JSZip();
  const root = archiveFilename(app.customer_name, app.ref).replace(/\.zip$/, "");
  const manifest: { path: string; sha256: string; category: string; version: number; note?: string }[] = [];
  const used = new Set<string>();
  const sectionOf = (cat: string) => ARCHIVE_SECTIONS.find((s) => s.categories.includes(cat))?.folder ?? "09-Supporting-correspondence";
  for (const d of docs) {
    const folder = `${root}/${sectionOf(d.category)}${d.superseded_at ? "/_previous-versions" : ""}`;
    let entry = `${folder}/${safeEntry(`v${d.version_no}-${d.filename}`)}`;
    if (used.has(entry)) entry = `${folder}/${safeEntry(`v${d.version_no}-${d.id.slice(0, 8)}-${d.filename}`)}`;
    if (d.purged_at || d.scan_status !== "CLEAN") {
      manifest.push({ path: "(not included)", sha256: d.sha256, category: d.category, version: d.version_no, note: d.purged_at ? "Purged under the retention policy" : d.scan_status === "REJECTED" ? "Rejected by the malware scan" : "Still in quarantine" });
      continue;
    }
    const data = await objectStore().get(d.storage_key);
    if (sha256Hex(data) !== d.sha256) throw new Error(`Stored file for document ${d.id} does not match its recorded checksum.`);
    zip.file(entry, data);
    used.add(entry);
    manifest.push({ path: entry.slice(root.length + 1), sha256: d.sha256, category: d.category, version: d.version_no, note: d.superseded_at ? "Earlier version (superseded)" : undefined });
  }
  const record = await facilityRecord(q, app, manifest);
  zip.file(`${root}/${RECORD_FOLDER}/Facility-record-${app.ref}.xlsx`, record);
  const csv = ["path,category,version,sha256,note", ...manifest.map((m) => [m.path, m.category, m.version, m.sha256, m.note ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\r\n");
  zip.file(`${root}/${RECORD_FOLDER}/manifest.csv`, csv);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { app, buffer: buf, filename: archiveFilename(app.customer_name, app.ref), manifest, fileCount: manifest.filter((m) => m.path !== "(not included)").length + 2 };
}

const backoffMs = (n: number) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, n - 1));

/** Generate (or retry) one facility's archive. Safe to run repeatedly and concurrently. */
export async function processArchive(appId: string, now = new Date()): Promise<ArchiveStatus | "BUSY"> {
  const ctx = systemCtx(now);
  try {
    return await withTx(async (tx) => {
      const a = (await tx.query<ArchiveRow>("SELECT * FROM facility_archives WHERE application_id = $1 FOR UPDATE SKIP LOCKED", [appId])).rows[0];
      if (!a) return "BUSY";
      if (a.status !== "QUEUED" && a.status !== "FAILED") return a.status;
      const built = await buildArchive(tx, appId);
      if (built.app.status !== "CLOSED") throw gate("The facility is not complete.");
      const stored = await storeGeneratedDocument(tx, ctx, {
        appId,
        category: "FACILITY_ARCHIVE",
        filename: built.filename,
        mime: "application/zip",
        data: built.buffer,
        templateId: null,
        templateVersion: null,
        role: "SYSTEM",
        stage: built.app.stage,
        versionId: built.app.current_version_id,
        uploadedBy: built.app.initiator_id,
      });
      await tx.query(
        `UPDATE facility_archives SET status = 'COMPLETE', generated_at = $2, generation_no = generation_no + 1, document_id = $3, filename = $4, size_bytes = $5,
            sha256 = $6, file_count = $7, manifest = $8, attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL WHERE id = $1`,
        [a.id, now, stored.id, built.filename, built.buffer.length, sha256Hex(built.buffer), built.fileCount, JSON.stringify(built.manifest)],
      );
      await audit(tx, ctx, { action: "FACILITY_ARCHIVE_GENERATED", applicationId: appId, documentId: stored.id, documentVersion: stored.version, details: { filename: built.filename, files: built.fileCount, bytes: built.buffer.length, generation: a.generation_no + 1 } });
      return "COMPLETE" as const;
    });
  } catch (e) {
    const message = (e instanceof DomainError ? e.message : e instanceof Error ? `Generation error: ${e.message}` : "Generation error").slice(0, 400);
    if (!(e instanceof DomainError)) console.error("[archive] generation failed", appId, e);
    const cur = (await db.query<{ attempts: number }>("SELECT attempts FROM facility_archives WHERE application_id = $1 AND status IN ('QUEUED','FAILED')", [appId])).rows[0];
    if (cur) {
      const attempts = cur.attempts + 1;
      const next = attempts >= 5 ? null : new Date(now.getTime() + backoffMs(attempts));
      await db.query("UPDATE facility_archives SET status = 'FAILED', attempts = $2, last_error = $3, next_attempt_at = $4 WHERE application_id = $1 AND status IN ('QUEUED','FAILED')", [appId, attempts, message, next]);
      await auditOutsideTx(ctx, { action: "FACILITY_ARCHIVE_FAILED", outcome: "FAILURE", applicationId: appId, reason: message, details: { attempts } }).catch(() => undefined);
    }
    return "FAILED";
  }
}

export async function processDueArchives(now = new Date()) {
  const due = (await db.query<{ application_id: string }>("SELECT application_id FROM facility_archives WHERE status IN ('QUEUED','FAILED') AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 10", [now])).rows;
  for (const d of due) await processArchive(d.application_id, now);
  return due.length;
}

export async function kickArchive(appId: string) {
  if (process.env.ARCHIVE_AUTOGEN_INLINE === "false") return;
  await processArchive(appId);
}

/**
 * Initiator or Super Admin: retry a failed archive now, or regenerate a complete one (a new version;
 * the earlier archive is kept). Only for completed facilities.
 */
export async function retryArchive(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  await withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
    if (!app) throw notFound();
    if (app.initiator_id !== actor.staffId && !(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the initiator or the Super Admin can regenerate the facility archive.");
    if (app.status !== "CLOSED") throw gate("The archive is generated when the facility is complete.");
    await openRepository(tx, ctx, appId);
    await tx.query("UPDATE facility_archives SET status = 'QUEUED', queued_at = $2, next_attempt_at = $2, attempts = 0 WHERE application_id = $1", [appId, ctx.now]);
    await audit(tx, ctx, { action: "FACILITY_ARCHIVE_REQUESTED", applicationId: appId });
  });
  const status = await processArchive(appId, ctx.now);
  if (status !== "COMPLETE") {
    const a = await archiveFor(db, appId);
    throw gate(`The archive could not be generated: ${a?.last_error ?? "unknown error"}`);
  }
}
