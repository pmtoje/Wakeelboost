/**
 * SeedFi credit check report (PDF), generated automatically when a credit check completes.
 * Built only from SeedFi's response and the details the initiator recorded; the bank's
 * classification is shown separately and labelled as such. Stored against the facility as a
 * system-generated document, restricted to people allowed to see credit detail.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Tx } from "../db";
import type { Ctx } from "../context";
import { audit } from "../audit";
import { decryptField } from "../crypto";
import { maskWithLast4 } from "../mask";
import { formatLagos } from "../time";
import { PdfDoc } from "../pdf";
import { storeGeneratedDocument } from "./documents";
import type { CreditCheckRow } from "./credit-check";

const COMPONENTS: [string, string, string][] = [
  ["payment_history", "Payment history", "payment_history"],
  ["depth_of_credit", "Depth of credit", "depth_of_credit"],
  ["open_credit", "Open credit", "open_credit"],
  ["demographics", "Demographics", "demographics"],
];
const band = (s: number) => (s >= 750 ? "Exceptional" : s >= 690 ? "Very good" : s >= 620 ? "Good" : s >= 530 ? "Fair" : "Poor");
const seedfiDecision = (s: number) => (s >= 620 ? "SeedFi approved band, 620-800" : s >= 530 ? "SeedFi manual review band, 530-619" : "SeedFi declined band, below 530");

let logoCache: Buffer | null = null;
async function logo() {
  if (!logoCache) logoCache = await readFile(path.resolve(process.cwd(), "public/brand/altbank-logo-print.jpg"));
  return logoCache;
}

export async function buildCreditReportPdf(p: {
  check: CreditCheckRow;
  ref: string;
  applicantType: string;
  requestedBy: string;
  generatedAt: Date;
}): Promise<Buffer> {
  const c = p.check;
  const doc = new PdfDoc((n, t) => `${p.ref} - SeedFi credit check report - CONFIDENTIAL: credit information, handle under the bank's data protection policy - page ${n} of ${t}`);
  // Header: official logo, title, yellow rule
  try {
    doc.logo(await logo(), doc.margin, doc.y - 46, 46);
  } catch {
    /* logo asset unavailable: the report is still produced */
  }
  doc.text("WakeelBoost Work Desk", doc.margin + doc.width - 140, doc.y - 14, 9, true);
  doc.text("The Alternative Bank", doc.margin + doc.width - 140, doc.y - 26, 9);
  doc.y -= 58;
  doc.rect(doc.margin, doc.y, doc.width, 3, [1, 0.788, 0]);
  doc.y -= 22;
  doc.text("SeedFi credit check report", doc.margin, doc.y, 18, true);
  doc.y -= 16;
  doc.para(`Facility ${p.ref} - generated automatically ${formatLagos(p.generatedAt)} from the SeedFi response to enquiry ${c.attempt_no}.`, 9.5, false, 2, [0.35, 0.35, 0.38]);

  let raw: Record<string, unknown> = {};
  try {
    raw = c.response_enc ? JSON.parse(decryptField(c.response_enc)) : {};
  } catch {
    raw = {};
  }
  const body = ((raw as { data?: Record<string, unknown> }).data ?? raw) as Record<string, unknown>;
  const cs = (body.credit_score ?? {}) as Record<string, unknown>;
  const narration = typeof body.narration === "string" ? body.narration : typeof cs.narration === "string" ? cs.narration : null;
  const overall = Number(c.overall_score);
  const reviewed = Number(c.reviewed_score);

  doc.heading("Customer (entered by the initiator)");
  doc.rows([
    ["Customer", `${c.first_name} ${c.last_name}`],
    ["Applicant type", p.applicantType],
    ["BVN", maskWithLast4(c.bvn_last4)],
    ["Date of birth / gender", `${String(c.date_of_birth instanceof Date ? c.date_of_birth.toISOString() : c.date_of_birth).slice(0, 10)} / ${c.gender}`],
    ["Phone", maskWithLast4(String(c.phone).replace(/\D/g, "").slice(-4), 11)],
    ["Consent", `${c.consent_method === "SIGNED_FORM" ? "Signed consent form" : "Given in person and witnessed"} - ${formatLagos(c.consent_at)}`],
    ["Enquiry made by", p.requestedBy],
  ]);

  doc.heading("SeedFi result (verified provider data)");
  doc.rows([
    ["Reviewed Seed Score", `${reviewed} \u00b7 ${band(reviewed)} \u00b7 ${seedfiDecision(reviewed)}`],
    ["Overall Seed Score", `${overall} \u00b7 ${band(overall)} \u00b7 scale 280 (highest risk) to 800 (lowest risk)`],
    ["Credit history", c.has_credit_history ? "Yes" : "No credit history reported"],
    ["Score valid until", c.validity_date ? String(c.validity_date instanceof Date ? c.validity_date.toISOString() : c.validity_date).slice(0, 10) : "Not stated by SeedFi"],
    ["SeedFi reference", c.provider_reference ?? "Not returned by SeedFi"],
    ["Environment", c.provider_environment],
    ["Requested / responded", `${formatLagos(c.requested_at)} / ${c.responded_at ? formatLagos(c.responded_at) : "-"}`],
  ]);

  const comp = c.components ?? {};
  const rows = COMPONENTS.filter(([k]) => comp[k]).map(([k, label, prefix]) => {
    const v = comp[k] as Record<string, number>;
    return [label, String(v[`${prefix}_score`] ?? "-"), String(v[`${prefix}_seedfi_score`] ?? "-")];
  });
  if (rows.length) {
    doc.heading("Score components (SeedFi)");
    doc.table(["Component", "Raw score", "SeedFi score"], rows, [0.5, 0.25, 0.25]);
  }
  if (narration) {
    doc.heading("SeedFi narration");
    doc.para(narration, 10);
  }

  doc.heading("Bank classification (WakeelBoost credit rules, not SeedFi)");
  doc.rows([
    ["Outcome", c.outcome === "ACCEPTABLE" ? "Acceptable: the facility application may proceed" : "Adverse findings: referred to the Product Manager"],
    ["Reasons", (c.outcome_reasons ?? []).join("; ") || "-"],
    ["Rules version", c.settings_version ? `v${c.settings_version}` : "-"],
  ]);
  doc.y -= 6;
  doc.para(
    "This report reproduces the SeedFi Seed Score returned for this enquiry. It is not a credit approval: the facility remains subject to the bank's credit assessment and approval authorities. Product Manager decisions on adverse findings are recorded separately in the facility record.",
    8.5,
    false,
    0,
    [0.4, 0.4, 0.43],
  );
  return doc.toBuffer({ title: `SeedFi credit check report ${p.ref}`, author: "WakeelBoost Work Desk - The Alternative Bank", created: p.generatedAt });
}

/** Generate and store the report for a completed check (inside the completing transaction). */
export async function storeCreditReport(tx: Tx, ctx: Ctx, appId: string, checkId: string) {
  const check = (await tx.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE id = $1", [checkId])).rows[0];
  if (!check || check.status !== "COMPLETED") return null;
  const app = (await tx.query("SELECT ref, applicant_type, stage, current_version_id FROM applications WHERE id = $1", [appId])).rows[0];
  const who = (await tx.query("SELECT full_name FROM staff WHERE id = $1", [check.requested_by])).rows[0]?.full_name ?? "";
  const pdf = await buildCreditReportPdf({ check, ref: app.ref, applicantType: app.applicant_type, requestedBy: who, generatedAt: ctx.now });
  const stored = await storeGeneratedDocument(tx, ctx, {
    appId,
    category: "SEEDFI_CREDIT_REPORT",
    filename: `SeedFi-credit-report-${app.ref}-enquiry-${check.attempt_no}.pdf`,
    mime: "application/pdf",
    data: pdf,
    templateId: null,
    templateVersion: null,
    role: "SYSTEM",
    stage: app.stage,
    versionId: app.current_version_id,
    uploadedBy: check.requested_by,
  });
  await audit(tx, ctx, { action: "CREDIT_REPORT_GENERATED", applicationId: appId, documentId: stored.id, documentVersion: stored.version, details: { creditCheckId: checkId, attempt: check.attempt_no, bytes: pdf.length } });
  return stored;
}
