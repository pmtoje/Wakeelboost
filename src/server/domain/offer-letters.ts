/**
 * Murabaha offer letter lifecycle.
 *
 * - When the Divisional Head approves a facility, the approval transaction records a PENDING letter
 *   (requestOfferLetter). Nothing is rendered inside the approval itself.
 * - processOfferLetter renders the active, approved Murabaha template for the applicant type from
 *   the approved facility record, stores the Word letter and its PDF against the facility and marks
 *   the letter ISSUED. It runs straight after the approval and again from the worker until it
 *   succeeds, so a failure never blocks the approval and is retried safely.
 * - A unique index allows one live letter per facility, so repeated triggers cannot issue twice.
 * - The customer-signed copy (uploaded by the initiator) moves the letter to SIGNED.
 * A letter is only shown as issued when its documents are stored; failures stay visible with the reason.
 */
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { systemCtx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { DomainError, forbidden, gate, notFound } from "../errors";
import { enqueueEmail } from "../notify/outbox";
import { caseLink, simpleEmail } from "../notify/templates";
import { formatLagos } from "../time";
import { holdsRole } from "./access";
import { storeGeneratedDocument } from "./documents";
import { activeTemplate, buildOfferFiles } from "./offer";

export type OfferLetterStatus = "PENDING" | "ISSUED" | "FAILED" | "SUPERSEDED";
export interface OfferLetterRow {
  id: string;
  application_id: string;
  issue_no: number;
  status: OfferLetterStatus;
  trigger: string;
  requested_by: string | null;
  requested_at: Date;
  template_id: string | null;
  template_version: number | null;
  assessment_id: string | null;
  docx_document_id: string | null;
  pdf_document_id: string | null;
  issued_at: Date | null;
  available_at: Date | null;
  acceptance_status: "NOT_ISSUED" | "AWAITING_SIGNATURE" | "SIGNED" | "SUPERSEDED";
  signed_document_id: string | null;
  signed_at: Date | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
}

/** Stages at which a facility has all approvals and may hold an offer letter. */
const OFFER_STAGES = ["OFFER_PREPARATION", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING", "COMPLETION", "VENDOR_CONFIRMATION", "CLOSED"];
const MAX_AUTO_ATTEMPTS = 5;

export async function liveOfferLetter(q: Db, appId: string): Promise<OfferLetterRow | null> {
  return (await q.query<OfferLetterRow>("SELECT * FROM offer_letters WHERE application_id = $1 AND status IN ('PENDING','FAILED','ISSUED')", [appId])).rows[0] ?? null;
}
export async function offerLetterHistory(q: Db, appId: string): Promise<OfferLetterRow[]> {
  return (await q.query<OfferLetterRow>("SELECT * FROM offer_letters WHERE application_id = $1 ORDER BY issue_no DESC", [appId])).rows;
}

/** Record that a letter is due (idempotent: returns the existing live letter if there is one). */
export async function requestOfferLetter(tx: Tx, ctx: Ctx, appId: string, trigger: "DIVISIONAL_HEAD_APPROVAL" | "RETRY" | "REISSUE" | "BACKFILL"): Promise<OfferLetterRow> {
  const live = await liveOfferLetter(tx, appId);
  if (live) return live;
  const n = (await tx.query<{ n: number }>("SELECT coalesce(max(issue_no), 0) + 1 AS n FROM offer_letters WHERE application_id = $1", [appId])).rows[0].n;
  const row = (
    await tx.query<OfferLetterRow>(
      `INSERT INTO offer_letters (application_id, issue_no, status, trigger, requested_by, requested_at, next_attempt_at)
       VALUES ($1,$2,'PENDING',$3,$4,$5,$5) RETURNING *`,
      [appId, n, trigger, ctx.actor?.staffId ?? null, ctx.now],
    )
  ).rows[0];
  await audit(tx, ctx, { action: "OFFER_LETTER_REQUESTED", applicationId: appId, details: { offerLetterId: row.id, issueNo: n, trigger } });
  return row;
}

function backoff(attempts: number) {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}
const errText = (e: unknown) => (e instanceof DomainError ? e.message : e instanceof Error ? `Generation error: ${e.message}` : "Generation error").replace(/\s+/g, " ").slice(0, 400);

/**
 * Render and issue one letter. Safe to call concurrently and repeatedly: the row is locked with
 * SKIP LOCKED and only PENDING/FAILED letters are processed.
 */
export async function processOfferLetter(letterId: string, now = new Date()): Promise<OfferLetterStatus | "BUSY"> {
  const status = await issueOfferLetter(letterId, now);
  if (status === "ISSUED") {
    // Prepare the bank's disbursement forms alongside the letter (best effort; the initiator can retry).
    const appId = (await db.query<{ application_id: string }>("SELECT application_id FROM offer_letters WHERE id = $1", [letterId])).rows[0]?.application_id;
    if (appId) {
      const { prefillForms } = await import("./disbursement-docs");
      await prefillForms(appId, now).catch((e) => console.error("[forms] prefill failed", e));
    }
  }
  return status;
}

async function issueOfferLetter(letterId: string, now: Date): Promise<OfferLetterStatus | "BUSY"> {
  const ctx = systemCtx(now);
  try {
    return await withTx(async (tx) => {
      const letter = (await tx.query<OfferLetterRow>("SELECT * FROM offer_letters WHERE id = $1 FOR UPDATE SKIP LOCKED", [letterId])).rows[0];
      if (!letter) return "BUSY";
      if (letter.status !== "PENDING" && letter.status !== "FAILED") return letter.status;
      const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR SHARE", [letter.application_id])).rows[0];
      if (!app) throw notFound();
      // 1. Approvals complete: the facility has passed the Divisional Head and is not rejected.
      if (!OFFER_STAGES.includes(app.stage) || app.status === "REJECTED") throw gate(`The facility is at ${app.stage}; offer letters are issued only after Divisional Head approval.`);
      const dhApproved = (await tx.query("SELECT 1 FROM decisions WHERE application_id = $1 AND stage = 'DIVISIONAL_HEAD_REVIEW' AND action = 'APPROVE' AND invalidated_at IS NULL LIMIT 1", [app.id])).rows[0];
      if (!dhApproved) throw gate("No current Divisional Head approval is recorded for this facility.");
      // 2-3. Active Murabaha template for the applicant type, approved for production use.
      const tpl = await activeTemplate(tx, app.applicant_type);
      if (!tpl) throw gate("No active Murabaha offer template is configured for this applicant type. The Super Admin must activate one under Offer templates.");
      if (config.isProduction && !tpl.production_approved) throw gate(`Template "${tpl.name}" v${tpl.version} is not approved for production. The Super Admin must approve it under Offer templates.`);
      // 4-5. Populate from the approved facility record and produce the PDF.
      const built = await buildOfferFiles(tx, app, tpl, now);
      if (built.format === "DOCX" && !built.pdf && config.isProduction) throw new Error("PDF conversion is unavailable on this server (LibreOffice is required).");
      // 6. Store against the facility.
      const meta = { templateId: tpl.id as string, templateVersion: tpl.version as number, role: "SYSTEM", stage: app.stage, versionId: app.current_version_id, uploadedBy: letter.requested_by ?? app.initiator_id };
      const main = await storeGeneratedDocument(tx, ctx, { appId: app.id, category: "GENERATED_OFFER", filename: built.main.filename, mime: built.main.mime, data: built.main.data, ...meta });
      const pdf = built.pdf ? await storeGeneratedDocument(tx, ctx, { appId: app.id, category: "GENERATED_OFFER_PDF", filename: built.pdf.filename, mime: "application/pdf", data: built.pdf.data, ...meta }) : null;
      await tx.query(
        `UPDATE offer_letters SET status = 'ISSUED', template_id = $2, template_version = $3, assessment_id = $4, app_version_id = $5,
            docx_document_id = $6, pdf_document_id = $7, issued_at = $8, available_at = $8, acceptance_status = 'AWAITING_SIGNATURE',
            attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL
          WHERE id = $1`,
        [letter.id, tpl.id, tpl.version, built.assessmentId, app.current_version_id, main.id, pdf?.id ?? null, now],
      );
      await tx.query("UPDATE applications SET offer_template_id = $2 WHERE id = $1", [app.id, tpl.id]);
      // 8. Audit trail.
      await audit(tx, ctx, {
        action: "OFFER_LETTER_ISSUED",
        applicationId: app.id,
        stage: app.stage,
        documentId: main.id,
        documentVersion: main.version,
        details: { offerLetterId: letter.id, issueNo: letter.issue_no, templateId: tpl.id, templateName: tpl.name, templateVersion: tpl.version, applicantType: app.applicant_type, pdfDocumentId: pdf?.id ?? null, trigger: letter.trigger, assessmentId: built.assessmentId },
      });
      // 7. Make it available to the initiator, who handles customer acceptance.
      const to = (await tx.query("SELECT email FROM staff WHERE id = $1", [app.initiator_id])).rows[0]?.email;
      if (to) {
        await enqueueEmail(tx, now, {
          kind: "OFFER_LETTER_ISSUED",
          dedupeKey: `offer-letter:${letter.id}`,
          applicationId: app.id,
          to: [to],
          subject: `WakeelBoost ${app.ref}: Murabaha offer letter ready`,
          text: simpleEmail([
            `The Murabaha offer letter for ${app.ref} (${app.customer_name}) has been generated from the approved facility record.`,
            `Template: ${tpl.name} v${tpl.version} · issued ${formatLagos(now)}.`,
            "Share it with the customer for acceptance, then upload the customer-signed copy as “Signed offer letter”.",
            `Open the request: ${caseLink(app.id)}`,
          ]),
        });
      }
      return "ISSUED" as const;
    });
  } catch (e) {
    const message = errText(e);
    if (!(e instanceof DomainError)) console.error("[offer-letter] generation failed", letterId, e);
    const cur = (await db.query<{ attempts: number; application_id: string }>("SELECT attempts, application_id FROM offer_letters WHERE id = $1 AND status IN ('PENDING','FAILED')", [letterId])).rows[0];
    if (cur) {
      const attempts = cur.attempts + 1;
      const next = attempts >= MAX_AUTO_ATTEMPTS ? null : new Date(now.getTime() + backoff(attempts));
      await db.query("UPDATE offer_letters SET status = 'FAILED', attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1 AND status IN ('PENDING','FAILED')", [letterId, attempts, message, next]);
      await auditOutsideTx(ctx, { action: "OFFER_LETTER_FAILED", outcome: "FAILURE", applicationId: cur.application_id, reason: message, details: { offerLetterId: letterId, attempts, nextAttemptAt: next?.toISOString() ?? null } }).catch(() => undefined);
    }
    return "FAILED";
  }
}

/** Worker: issue every letter that is due. */
export async function processDueOfferLetters(now = new Date()): Promise<number> {
  const due = (await db.query<{ id: string }>("SELECT id FROM offer_letters WHERE status IN ('PENDING','FAILED') AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT 20", [now])).rows;
  for (const d of due) await processOfferLetter(d.id, now);
  return due.length;
}

/** Called straight after an approval commits so the initiator sees the letter without waiting for the worker. */
export async function kickOfferLetter(appId: string) {
  if (process.env.OFFER_AUTOGEN_INLINE === "false") return;
  const live = await liveOfferLetter(db, appId);
  if (live && (live.status === "PENDING" || live.status === "FAILED")) await processOfferLetter(live.id);
}

/**
 * Initiator at offer preparation, or Super Admin: retry a failed letter now (or create it for a
 * facility that has none). Does not create a second letter when one is already issued.
 */
export async function requestOfferLetterNow(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const letter = await withTx(async (tx) => {
    const app = (await tx.query("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    if (!app) throw notFound();
    const isAdmin = await holdsRole(tx, actor.staffId, "SUPER_ADMIN");
    const task = (await tx.query("SELECT * FROM tasks WHERE application_id = $1 AND status = 'OPEN'", [appId])).rows[0];
    const isInitiatorTask = task && task.stage === "OFFER_PREPARATION" && task.assignee_id === actor.staffId && (await holdsRole(tx, actor.staffId, task.assignee_role));
    if (!isAdmin && !isInitiatorTask) throw forbidden("Only the initiator at offer preparation or the Super Admin can retry the offer letter.");
    const live = await requestOfferLetter(tx, ctx, appId, "RETRY");
    if (live.status === "FAILED") await tx.query("UPDATE offer_letters SET next_attempt_at = $2 WHERE id = $1", [live.id, ctx.now]);
    return live;
  });
  const status = letter.status === "ISSUED" ? "ISSUED" : await processOfferLetter(letter.id, ctx.now);
  const after = await liveOfferLetter(db, appId);
  if (status !== "ISSUED") throw gate(`The offer letter could not be generated: ${after?.last_error ?? "unknown error"}`);
  return { documentId: after!.docx_document_id!, pdfDocumentId: after!.pdf_document_id, templateVersion: after!.template_version!, format: "DOCX" };
}

/** Customer acceptance: the initiator uploaded the signed letter. */
export async function recordSignedOffer(tx: Tx, ctx: Ctx, appId: string, signedDocumentId: string) {
  const live = await liveOfferLetter(tx, appId);
  if (!live || live.status !== "ISSUED") throw gate("The Murabaha offer letter has not been issued yet. Upload the customer-signed copy after the system issues the letter.");
  await tx.query("UPDATE offer_letters SET acceptance_status = 'SIGNED', signed_document_id = $2, signed_at = $3 WHERE id = $1", [live.id, signedDocumentId, ctx.now]);
  await audit(tx, ctx, { action: "OFFER_LETTER_SIGNED", applicationId: appId, documentId: signedDocumentId, details: { offerLetterId: live.id, issueNo: live.issue_no, templateVersion: live.template_version } });
}
