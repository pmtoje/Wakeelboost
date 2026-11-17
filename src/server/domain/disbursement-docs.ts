/**
 * Disbursement documents: the Murabaha offer letter plus the bank's pre-disbursement agreement, GSI
 * form and customer insurance (Takaful) form.
 *
 * - Prefill: when the offer letter is issued, every form with an active, approved bank template is
 *   filled from the approved facility record (Word copy for signing, PDF copy for preview/download).
 *   Forms without a template are not invented: the initiator uploads the bank's signed form instead.
 * - Sign on a tablet: the customer (and witness where the document has one) sign on the initiator's
 *   tablet. The signed copy is the prepared document plus an electronic signature page with the
 *   signatures, the signing record and the checksum of the exact document that was presented. It is
 *   filed as the signed pack document, exactly like an uploaded signed copy.
 * - Download / preview / re-upload: every prepared document can be opened or downloaded, and a
 *   signed copy can always be uploaded (a new version replaces the previous one; all are kept).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { sha256Hex } from "../crypto";
import { DomainError, forbidden, gate, invalid, notFound } from "../errors";
import { formatLagos } from "../time";
import { objectStore } from "../storage";
import { holdsRole } from "./access";
import { storeGeneratedDocument } from "./documents";
import { activeTemplate, buildOfferFiles, DOCX_MIME } from "./offer";
import { appendSignaturePage, assertSignaturePng, docxToPdf, type SignaturePageSigner, type TemplateDocType } from "./offer-docx";
import { liveOfferLetter, recordSignedOffer } from "./offer-letters";

export type DisbursementDoc = TemplateDocType;
export interface FormSpec {
  docType: Exclude<DisbursementDoc, "OFFER_LETTER">;
  label: string;
  slug: string;
  prefillCategory: string; // Word copy (signing source)
  prefillPdfCategory: string; // PDF copy (preview / download)
  signedCategory: string; // pack category the signed copy satisfies
  filePrefix: string;
}
export const FORMS: FormSpec[] = [
  { docType: "PRE_DISBURSEMENT", label: "Pre-disbursement agreement", slug: "pre-disbursement", prefillCategory: "PREFILLED_PRE_DISBURSEMENT", prefillPdfCategory: "PREFILLED_PRE_DISBURSEMENT_PDF", signedCategory: "PRE_DISBURSEMENT", filePrefix: "Pre-disbursement" },
  { docType: "GSI_FORM", label: "GSI form", slug: "gsi-form", prefillCategory: "PREFILLED_GSI_FORM", prefillPdfCategory: "PREFILLED_GSI_FORM_PDF", signedCategory: "GSI_FORM", filePrefix: "GSI-form" },
  { docType: "INSURANCE_SIGNED", label: "Customer insurance (Takaful) form", slug: "insurance", prefillCategory: "PREFILLED_INSURANCE", prefillPdfCategory: "PREFILLED_INSURANCE_PDF", signedCategory: "INSURANCE_SIGNED", filePrefix: "Insurance-form" },
];
export const DOC_SLUGS: Record<string, DisbursementDoc> = { "offer-letter": "OFFER_LETTER", ...Object.fromEntries(FORMS.map((f) => [f.slug, f.docType])) };
export const DOC_LABEL: Record<DisbursementDoc, string> = { OFFER_LETTER: "Murabaha offer letter", ...Object.fromEntries(FORMS.map((f) => [f.docType, f.label])) } as Record<DisbursementDoc, string>;

const OFFER_STAGES = ["OFFER_PREPARATION", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING"];

/** Fill every bank form that has an active template (idempotent: skips forms already prepared from the same template and version). */
export async function prefillForms(appId: string, now = new Date()): Promise<{ prepared: string[]; skipped: string[]; missingTemplate: string[] }> {
  const ctx = systemCtx(now);
  const out = { prepared: [] as string[], skipped: [] as string[], missingTemplate: [] as string[] };
  for (const f of FORMS) {
    try {
      await withTx(async (tx) => {
        const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
        if (!app) throw notFound();
        if (!OFFER_STAGES.includes(app.stage)) throw gate("Forms are prepared after Divisional Head approval.");
        const tpl = await activeTemplate(tx, app.applicant_type, f.docType);
        if (!tpl || (config.isProduction && !tpl.production_approved)) {
          out.missingTemplate.push(f.docType);
          return;
        }
        const existing = (await tx.query("SELECT template_id, app_version_id FROM documents WHERE application_id = $1 AND category = $2 AND superseded_at IS NULL", [appId, f.prefillCategory])).rows[0];
        if (existing && existing.template_id === tpl.id && existing.app_version_id === app.current_version_id) {
          out.skipped.push(f.docType);
          return;
        }
        const built = await buildOfferFiles(tx, app, tpl, now, f.filePrefix);
        const meta = { templateId: tpl.id as string, templateVersion: tpl.version as number, role: "SYSTEM", stage: app.stage, versionId: app.current_version_id, uploadedBy: app.initiator_id };
        const word = await storeGeneratedDocument(tx, ctx, { appId, category: f.prefillCategory, filename: built.main.filename, mime: DOCX_MIME, data: built.main.data, ...meta });
        const pdf = built.pdf ? await storeGeneratedDocument(tx, ctx, { appId, category: f.prefillPdfCategory, filename: built.pdf.filename, mime: "application/pdf", data: built.pdf.data, ...meta }) : null;
        await audit(tx, ctx, { action: "FORM_PREFILLED", applicationId: appId, documentId: word.id, documentVersion: word.version, details: { docType: f.docType, templateId: tpl.id, templateVersion: tpl.version, pdfDocumentId: pdf?.id ?? null } });
        out.prepared.push(f.docType);
      });
    } catch (e) {
      if (!(e instanceof DomainError)) console.error("[forms] prefill failed", f.docType, e);
      await auditOutsideTx(ctx, { action: "FORM_PREFILL_FAILED", outcome: "FAILURE", applicationId: appId, reason: e instanceof Error ? e.message.slice(0, 300) : "error", details: { docType: f.docType } }).catch(() => undefined);
    }
  }
  return out;
}

/** Initiator at offer preparation: prepare (or refresh) the prefilled forms now. */
export async function prefillFormsNow(ctx: Ctx, appId: string) {
  await assertSigningTask(db, ctx, appId);
  return prefillForms(appId, ctx.now);
}

async function assertSigningTask(q: Db, ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const task = (await q.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
  if (!task || task.stage !== "OFFER_PREPARATION" || task.assignee_id !== actor.staffId || !(await holdsRole(q, actor.staffId, task.assignee_role))) {
    throw forbidden("Documents are signed on the tablet by the initiator at offer pack preparation.");
  }
  return task;
}

export interface SignerInput {
  role: "CUSTOMER" | "WITNESS" | "SIGNATORY_1" | "SIGNATORY_2";
  name: string;
  designation?: string;
  address?: string;
  occupation?: string;
  signaturePng: string; // base64 (data URL accepted)
}

const ROLE_TITLE: Record<SignerInput["role"], string> = { CUSTOMER: "Customer", WITNESS: "Witness", SIGNATORY_1: "Authorised signatory 1", SIGNATORY_2: "Authorised signatory 2" };

/** Who must sign each document. Corporate letters: one or two authorised signatories; others: customer, with a witness on the offer letter. */
export function requiredSigners(docType: DisbursementDoc, applicantType: string): { required: SignerInput["role"][]; optional: SignerInput["role"][] } {
  if (applicantType === "LIMITED") return { required: ["SIGNATORY_1"], optional: ["SIGNATORY_2"] };
  if (docType === "OFFER_LETTER") return { required: ["CUSTOMER", "WITNESS"], optional: [] };
  return { required: ["CUSTOMER"], optional: ["WITNESS"] };
}

function decodePng(s: string): Buffer {
  const b64 = s.replace(/^data:image\/png;base64,/, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw invalid("Each signature must be drawn on the signature pad.");
  const buf = Buffer.from(b64, "base64");
  assertSignaturePng(buf);
  return buf;
}

/**
 * Sign a prepared document on the tablet. Produces the signed copy (prepared document + signature
 * page), files it as the signed pack document and records who signed, when, where and what.
 */
export async function signOnTablet(ctx: Ctx, appId: string, docType: DisbursementDoc, signers: SignerInput[]) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) => {
      const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
      if (!app) throw notFound();
      const task = await assertSigningTask(tx, ctx, appId);
      // Source document presented to the signer
      let sourceId: string | null = null;
      let signedCategory: string;
      if (docType === "OFFER_LETTER") {
        const letter = await liveOfferLetter(tx, appId);
        if (!letter || letter.status !== "ISSUED" || !letter.docx_document_id) throw gate("The Murabaha offer letter has not been issued yet.");
        sourceId = letter.docx_document_id;
        signedCategory = "SIGNED_OFFER";
      } else {
        const f = FORMS.find((x) => x.docType === docType);
        if (!f) throw invalid("Unknown document.");
        sourceId = (await tx.query("SELECT id FROM documents WHERE application_id = $1 AND category = $2 AND superseded_at IS NULL AND scan_status = 'CLEAN'", [appId, f.prefillCategory])).rows[0]?.id ?? null;
        if (!sourceId) throw gate(`There is no prepared ${f.label.toLowerCase().replace("murabaha", "Murabaha")} to sign. Upload the bank's signed form instead.`);
        signedCategory = f.signedCategory;
      }
      const source = (await tx.query("SELECT * FROM documents WHERE id = $1", [sourceId])).rows[0];
      // Signers
      const rules = requiredSigners(docType, app.applicant_type);
      const given = new Map(signers.filter((s) => s && s.role).map((s) => [s.role, s]));
      const fields: Record<string, string> = {};
      for (const r of rules.required) if (!given.has(r)) fields[r] = `${ROLE_TITLE[r]} must sign.`;
      for (const [r, s] of given) {
        if (![...rules.required, ...rules.optional].includes(r)) fields[r] = `${ROLE_TITLE[r]} does not sign this document.`;
        if (!s.name || s.name.trim().length < 3) fields[`${r}.name`] = `Enter the ${ROLE_TITLE[r].toLowerCase()}'s full name.`;
        if ((r === "SIGNATORY_1" || r === "SIGNATORY_2") && !(s.designation ?? "").trim()) fields[`${r}.designation`] = "Enter the signatory's designation.";
        if (r === "WITNESS" && docType === "OFFER_LETTER" && (!(s.address ?? "").trim() || !(s.occupation ?? "").trim())) fields[`${r}.details`] = "Enter the witness's address and occupation.";
      }
      if (Object.keys(fields).length) throw invalid("Check the signatures.", fields);
      const order: SignerInput["role"][] = ["CUSTOMER", "SIGNATORY_1", "SIGNATORY_2", "WITNESS"];
      const pageSigners: (SignaturePageSigner & { sha: string; roleCode: string })[] = [];
      for (const r of order) {
        const s = given.get(r);
        if (!s) continue;
        const png = decodePng(s.signaturePng);
        const details: [string, string][] = [];
        if (s.designation) details.push(["Designation", s.designation.trim()]);
        if (s.address) details.push(["Address", s.address.trim()]);
        if (s.occupation) details.push(["Occupation", s.occupation.trim()]);
        details.push(["Signed", formatLagos(ctx.now)]);
        pageSigners.push({ role: ROLE_TITLE[r], roleCode: r, name: s.name.trim(), details, png, sha: sha256Hex(png) });
      }
      // Build the signed copy
      const sourceData = await objectStore().get(source.storage_key);
      const sourceSha = sha256Hex(sourceData);
      const label = docType === "OFFER_LETTER" ? "Murabaha offer letter" : FORMS.find((x) => x.docType === docType)!.label;
      const staff = (await tx.query("SELECT full_name FROM staff WHERE id = $1", [actor.staffId])).rows[0]?.full_name ?? actor.email;
      const signedDocx = await appendSignaturePage(sourceData, {
        title: "Electronic signature page",
        statement: `By signing below, the signer${pageSigners.length > 1 ? "s" : ""} accept${pageSigners.length > 1 ? "" : "s"} and execute${pageSigners.length > 1 ? "" : "s"} the ${label.toLowerCase().replace("murabaha", "Murabaha")} above (${app.ref}) for ${app.customer_name}. Signed in person on a tablet presented by The Alternative Bank.`,
        signers: pageSigners,
        record: [
          ["Document", `${label} · ${source.filename} · version ${source.version_no}`],
          ["Document checksum (SHA-256)", sourceSha],
          ["Signed", `${formatLagos(ctx.now)} (Africa/Lagos)`],
          ["Captured by", `${staff} (${task.assignee_role})`],
          ["Device", `${(ctx.userAgent ?? "unknown").slice(0, 120)} · IP ${ctx.ip ?? "unknown"}`],
          ["Signing reference", randomUUID()],
        ],
      });
      const pdf = await docxToPdf(signedDocx);
      if (!pdf && config.isProduction) throw new Error("PDF conversion is unavailable on this server (LibreOffice is required).");
      const stored = await storeGeneratedDocument(tx, ctx, {
        appId,
        category: signedCategory,
        filename: `Signed-${label.replace(/[^A-Za-z0-9]+/g, "-")}-${app.ref}.${pdf ? "pdf" : "docx"}`,
        mime: pdf ? "application/pdf" : DOCX_MIME,
        data: pdf ?? signedDocx,
        templateId: source.template_id,
        templateVersion: source.template_version,
        role: task.assignee_role,
        stage: app.stage,
        versionId: app.current_version_id,
      });
      if (docType === "OFFER_LETTER") await recordSignedOffer(tx, ctx, appId, stored.id);
      const signerRecords = pageSigners.map((s) => ({ role: s.roleCode, name: s.name, signatureSha256: s.sha }));
      await tx.query(
        `INSERT INTO e_signatures (application_id, doc_type, source_document_id, source_sha256, signed_document_id, signers, captured_by, captured_at, client_ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [appId, docType, source.id, sourceSha, stored.id, JSON.stringify(signerRecords), actor.staffId, ctx.now, ctx.ip, ctx.userAgent],
      );
      await audit(tx, ctx, {
        action: "DOCUMENT_SIGNED_ON_TABLET",
        actorRole: task.assignee_role,
        applicationId: appId,
        stage: app.stage,
        documentId: stored.id,
        documentVersion: stored.version,
        details: { docType, sourceDocumentId: source.id, sourceSha256: sourceSha, signers: signerRecords.map((s) => ({ role: s.role, name: s.name })) },
      });
      return { documentId: stored.id, label };
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "DOCUMENT_SIGNED_ON_TABLET", outcome: "DENIED", applicationId: appId, reason: e.message, details: { docType } });
    throw e;
  }
}
