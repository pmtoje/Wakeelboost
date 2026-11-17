/**
 * Mandatory SeedFi credit check (first step of every new WakeelBoost request).
 *
 *   New request → customer identification + consent → SeedFi Seed Score → eligibility decision
 *     ACCEPTABLE         → the initiator may complete the facility application
 *     ADVERSE            → Product Manager credit review (CREDIT_REVIEW task)
 *     technical failure  → UNAVAILABLE (never a credit decision); the initiator may retry
 *
 * Product Manager decisions (performed through the normal task workflow): clear to proceed,
 * request clarification (back to the initiator), or decline (request closed). Clearance only
 * permits origination; every facility still goes through the full credit approval chain.
 */
import type { Db, Tx } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { decryptField, encryptField, hmac } from "../crypto";
import { conflict, DomainError, forbidden, gate, invalid, notFound } from "../errors";
import { last4 } from "../mask";
import { calculateSeedScore, type SeedScoreResult } from "../integrations/seedfi";
import { holdsRole } from "./access";
import { type AppRow, chooseAssignee, openTask } from "./assignment";
import { storeCreditReport } from "./credit-report";

export type CreditCheckStatus = "NOT_REQUIRED" | "REQUIRED" | "IN_PROGRESS" | "ACCEPTABLE" | "REVIEW_REQUIRED" | "CLARIFICATION_REQUIRED" | "CLEARED" | "UNAVAILABLE" | "DECLINED";

export const CREDIT_STATUS_LABEL: Record<CreditCheckStatus, string> = {
  NOT_REQUIRED: "Not required (created before the mandatory credit check)",
  REQUIRED: "Credit check required",
  IN_PROGRESS: "Credit check in progress",
  ACCEPTABLE: "Cleared to proceed",
  REVIEW_REQUIRED: "Awaiting Product Manager review",
  CLARIFICATION_REQUIRED: "Clarification required",
  CLEARED: "Cleared to proceed (Product Manager)",
  UNAVAILABLE: "Credit check unavailable",
  DECLINED: "Declined",
};

/** Statuses that permit the initiator to complete and submit the facility application. */
export const ORIGINATION_ALLOWED: readonly string[] = ["NOT_REQUIRED", "ACCEPTABLE", "CLEARED"];

export interface CreditSettings {
  id: string;
  version: number;
  minAcceptableScore: number;
  scoreBasis: "REVIEWED" | "OVERALL" | "LOWER_OF_BOTH";
  requireCreditHistory: boolean;
}

export async function creditSettings(q: Db): Promise<CreditSettings> {
  const r = (await q.query("SELECT * FROM credit_check_settings ORDER BY version DESC LIMIT 1")).rows[0];
  return { id: r.id, version: r.version, minAcceptableScore: r.min_acceptable_score, scoreBasis: r.score_basis, requireCreditHistory: r.require_credit_history };
}

/** Classify a SeedFi result against the bank's rules. Pure; uses only provider-returned values. */
export function classify(r: Pick<SeedScoreResult, "overallScore" | "reviewedScore" | "hasCreditHistory">, s: CreditSettings): { outcome: "ACCEPTABLE" | "ADVERSE"; score: number; reasons: string[] } {
  const score = s.scoreBasis === "OVERALL" ? r.overallScore : s.scoreBasis === "REVIEWED" ? r.reviewedScore : Math.min(r.overallScore, r.reviewedScore);
  const reasons: string[] = [];
  const basis = s.scoreBasis === "LOWER_OF_BOTH" ? "lower of overall and reviewed Seed Score" : s.scoreBasis === "OVERALL" ? "overall Seed Score" : "reviewed Seed Score";
  if (score < s.minAcceptableScore) reasons.push(`${basis} ${score} is below the acceptable minimum of ${s.minAcceptableScore}`);
  if (r.reviewedScore < r.overallScore) reasons.push(`SeedFi reviewed score (${r.reviewedScore}) is lower than the overall score (${r.overallScore})`);
  if (s.requireCreditHistory && !r.hasCreditHistory) reasons.push("SeedFi reports no credit history");
  // A reviewed-score reduction is informational unless the score itself is below the minimum.
  const adverse = score < s.minAcceptableScore || (s.requireCreditHistory && !r.hasCreditHistory);
  return { outcome: adverse ? "ADVERSE" : "ACCEPTABLE", score, reasons };
}

export function seedScoreBand(score: number) {
  return score >= 750 ? "Exceptional" : score >= 690 ? "Very good" : score >= 620 ? "Good" : score >= 530 ? "Fair" : "Poor";
}

export interface IdentificationInput {
  firstName: string;
  lastName: string;
  bvn: string;
  dateOfBirth: string;
  gender: string;
  phone: string;
  consent: boolean;
  consentMethod: string;
}

const NAME = /^[A-Za-z][A-Za-z' .-]{0,59}$/;
export function validateIdentification(i: IdentificationInput, now: Date) {
  const f: Record<string, string> = {};
  if (!NAME.test(i.firstName.trim())) f.firstName = "Enter the customer's first name as on the BVN record.";
  if (!NAME.test(i.lastName.trim())) f.lastName = "Enter the customer's last name as on the BVN record.";
  if (!/^\d{11}$/.test(i.bvn.replace(/\s/g, ""))) f.bvn = "BVN must be 11 digits.";
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(i.dateOfBirth) ? new Date(`${i.dateOfBirth}T00:00:00Z`) : null;
  if (!dob || Number.isNaN(dob.getTime())) f.dateOfBirth = "Enter the date of birth.";
  else {
    const age = (now.getTime() - dob.getTime()) / (365.25 * 864e5);
    if (age < 18 || age > 100) f.dateOfBirth = "The customer must be at least 18 years old.";
  }
  if (i.gender !== "male" && i.gender !== "female") f.gender = "Select the gender on the BVN record.";
  const phone = i.phone.replace(/[\s-]/g, "");
  if (!/^(\+?234|0)[789][01]\d{8}$/.test(phone)) f.phone = "Enter a Nigerian mobile number (e.g. 0803 123 4567).";
  if (!i.consent) f.consent = "Confirm the customer has consented to the credit enquiry.";
  if (!["SIGNED_FORM", "IN_APP_WITNESSED"].includes(i.consentMethod)) f.consentMethod = "Choose how consent was given.";
  if (Object.keys(f).length) throw invalid("Check the customer identification.", f);
  return { firstName: i.firstName.trim(), lastName: i.lastName.trim(), bvn: i.bvn.replace(/\s/g, ""), dateOfBirth: i.dateOfBirth, gender: i.gender as "male" | "female", phone };
}

export interface CreditCheckRow {
  id: string;
  application_id: string;
  attempt_no: number;
  provider_environment: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  first_name: string;
  last_name: string;
  date_of_birth: Date | string;
  gender: string;
  phone: string;
  bvn_last4: string;
  bvn_enc: string;
  bvn_hash: string;
  consent_method: string;
  consent_at: Date;
  requested_by: string;
  requested_at: Date;
  responded_at: Date | null;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  provider_reference: string | null;
  overall_score: string | null;
  reviewed_score: string | null;
  has_credit_history: boolean | null;
  validity_date: Date | null;
  components: Record<string, Record<string, number>> | null;
  response_enc: string | null;
  outcome: "ACCEPTABLE" | "ADVERSE" | null;
  outcome_reasons: string[] | null;
  settings_version: number | null;
}

export async function latestCreditCheck(q: Db, appId: string): Promise<CreditCheckRow | null> {
  return (await q.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE application_id = $1 ORDER BY attempt_no DESC LIMIT 1", [appId])).rows[0] ?? null;
}
export async function creditCheckHistory(q: Db, appId: string): Promise<CreditCheckRow[]> {
  return (await q.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE application_id = $1 ORDER BY attempt_no DESC", [appId])).rows;
}

/**
 * Credit detail (component scores, narration, the SeedFi report and the facility archive): the
 * initiator who ran the enquiry with the customer's consent, the Product Manager, credit officers and
 * approvers on the case, and the Super Admin.
 */
export async function canSeeCreditDetail(q: Db, staffId: string, appId: string): Promise<boolean> {
  if (await holdsRole(q, staffId, "SUPER_ADMIN")) return true;
  const init = await q.query("SELECT 1 FROM applications a WHERE a.id = $1 AND a.initiator_id = $2", [appId, staffId]);
  if (init.rowCount && (await holdsRole(q, staffId, (await q.query("SELECT initiator_role FROM applications WHERE id = $1", [appId])).rows[0].initiator_role))) return true;
  const r = await q.query(
    `SELECT 1 FROM tasks WHERE application_id = $1 AND assignee_id = $2
       AND assignee_role IN ('PRODUCT_MANAGER','CREDIT_OFFICER_1','CREDIT_OFFICER_2','CREDIT_OFFICER_3','CREDIT_LEAD_1','CREDIT_LEAD_2','UNIT_HEAD','DIVISIONAL_HEAD') LIMIT 1`,
    [appId, staffId],
  );
  return (r.rowCount ?? 0) > 0;
}
export function creditResponseDetail(row: CreditCheckRow): { narration: string | null } {
  if (!row.response_enc) return { narration: null };
  try {
    const raw = JSON.parse(decryptField(row.response_enc)) as { data?: { narration?: unknown; credit_score?: { narration?: unknown } }; narration?: unknown; credit_score?: { narration?: unknown } };
    const body = raw?.data ?? raw;
    const n = body?.narration ?? body?.credit_score?.narration;
    return { narration: typeof n === "string" ? n : null };
  } catch {
    return { narration: null };
  }
}

const STALE_MS = () => config.seedfi.timeoutMs * 2 + 30_000;

/**
 * Run the SeedFi credit check for a draft (initiator only). The enquiry is recorded before the call
 * (consent, identity, idempotency key) and the outcome after it. Repeated clicks with the same key
 * return the recorded check; a second enquiry cannot start while one is in flight.
 */
export async function runCreditCheck(ctx: Ctx, appId: string, input: IdentificationInput, idempotencyKey: string): Promise<{ status: CreditCheckStatus; checkId: string; message: string }> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 100) throw invalid("Missing or invalid idempotency key.");
  const ident = validateIdentification(input, ctx.now);
  let started: { checkId: string; replay?: CreditCheckStatus } ;
  try {
    started = await withTx(async (tx) => {
      const replay = (await tx.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE idempotency_key = $1", [idempotencyKey])).rows[0];
      if (replay) {
        if (replay.application_id !== appId || replay.requested_by !== actor.staffId) throw conflict("Duplicate request key.");
        const st = (await tx.query("SELECT credit_check_status FROM applications WHERE id = $1", [appId])).rows[0].credit_check_status;
        return { checkId: replay.id, replay: st };
      }
      const app = (await tx.query<AppRow & { credit_check_status: CreditCheckStatus }>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
      if (!app) throw notFound();
      if (app.initiator_id !== actor.staffId || !(await holdsRole(tx, actor.staffId, app.initiator_role))) throw forbidden("Only the initiator can run the credit check for this request.");
      if (app.stage !== "DRAFT") throw gate("The credit check is run before the facility application is submitted.");
      // Recover an enquiry left in flight by a crash (never treated as a result).
      const inflight = (await tx.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE application_id = $1 AND status = 'IN_PROGRESS'", [appId])).rows[0];
      if (inflight) {
        if (ctx.now.getTime() - new Date(inflight.requested_at).getTime() < STALE_MS()) throw conflict("A credit check for this request is already in progress.");
        await tx.query("UPDATE credit_checks SET status = 'FAILED', error_code = 'STALE', error_message = 'No response was recorded for this enquiry.', responded_at = $2 WHERE id = $1", [inflight.id, ctx.now]);
      }
      if (!["REQUIRED", "UNAVAILABLE", "IN_PROGRESS"].includes(app.credit_check_status)) {
        throw gate(app.credit_check_status === "NOT_REQUIRED" ? "This request pre-dates the mandatory credit check." : `The credit check is already complete (${CREDIT_STATUS_LABEL[app.credit_check_status]}).`);
      }
      const n = (await tx.query<{ n: number }>("SELECT coalesce(max(attempt_no),0)+1 AS n FROM credit_checks WHERE application_id = $1", [appId])).rows[0].n;
      const bvnHash = hmac(`bvn:${ident.bvn}`);
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO credit_checks (application_id, attempt_no, provider_environment, status, idempotency_key, first_name, last_name, date_of_birth, gender, phone,
              bvn_enc, bvn_last4, bvn_hash, provider_customer_id, consent_attested, consent_method, consent_at, requested_by, requested_at)
           VALUES ($1,$2,$3,'IN_PROGRESS',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16,$15) RETURNING id`,
          [appId, n, config.seedfi.environment, idempotencyKey, ident.firstName, ident.lastName, ident.dateOfBirth, ident.gender, ident.phone,
            encryptField(ident.bvn), last4(ident.bvn), bvnHash, `wb-${bvnHash.slice(0, 24)}`, input.consentMethod, ctx.now, actor.staffId],
        )
      ).rows[0];
      await tx.query("UPDATE applications SET credit_check_status = 'IN_PROGRESS', credit_check_id = $2, customer_name = $3, updated_at = $4 WHERE id = $1", [appId, row.id, `${ident.firstName} ${ident.lastName}`, ctx.now]);
      // Carry the identified customer into the draft (Individual / Enterprise proprietor) so the
      // facility application describes the same person whose credit was checked.
      if (app.applicant_type !== "LIMITED") {
        await tx.query(
          `UPDATE application_versions SET data = data || jsonb_build_object('customerName', $2::text, 'phone', $3::text), bvn_enc = $4, bvn_last4 = $5
            WHERE application_id = $1 AND submitted_at IS NULL`,
          [appId, `${ident.firstName} ${ident.lastName}`, ident.phone, encryptField(ident.bvn), last4(ident.bvn)],
        );
      }
      await audit(tx, ctx, { action: "CREDIT_CONSENT_RECORDED", actorRole: app.initiator_role, applicationId: appId, stage: "DRAFT", details: { creditCheckId: row.id, consentMethod: input.consentMethod } });
      await audit(tx, ctx, { action: "CREDIT_CHECK_REQUESTED", actorRole: app.initiator_role, applicationId: appId, stage: "DRAFT", details: { creditCheckId: row.id, attempt: n, provider: "SEEDFI", environment: config.seedfi.environment, bvnLast4: last4(ident.bvn) } });
      return { checkId: row.id };
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "CREDIT_CHECK_REQUESTED", outcome: "DENIED", applicationId: appId, reason: e.message });
    throw e;
  }
  if (started.replay) return { status: started.replay, checkId: started.checkId, message: CREDIT_STATUS_LABEL[started.replay] };

  const app0 = (await db.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  const draft = (await db.query("SELECT data FROM application_versions WHERE application_id = $1 ORDER BY version_no DESC LIMIT 1", [appId])).rows[0]?.data as { tenorMonths?: number } | undefined;
  const call = await calculateSeedScore({
    customerId: (await db.query("SELECT provider_customer_id FROM credit_checks WHERE id = $1", [started.checkId])).rows[0].provider_customer_id,
    firstName: ident.firstName,
    lastName: ident.lastName,
    bvn: ident.bvn,
    dateOfBirth: ident.dateOfBirth,
    phoneNumber: ident.phone,
    gender: ident.gender,
    loanDurationInMonths: draft?.tenorMonths ?? undefined,
  });

  return withTx(async (tx) => {
    const app = (await tx.query<AppRow & { credit_check_status: CreditCheckStatus }>("SELECT * FROM applications WHERE id = $1 FOR UPDATE", [appId])).rows[0];
    const check = (await tx.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE id = $1 FOR UPDATE", [started.checkId])).rows[0];
    if (check.status !== "IN_PROGRESS") return { status: app.credit_check_status, checkId: check.id, message: CREDIT_STATUS_LABEL[app.credit_check_status] };
    if (!call.ok) {
      await tx.query(
        "UPDATE credit_checks SET status = 'FAILED', responded_at = $2, http_status = $3, error_code = $4, error_message = $5 WHERE id = $1",
        [check.id, call.respondedAt, call.httpStatus, call.code, call.message],
      );
      await tx.query("UPDATE applications SET credit_check_status = 'UNAVAILABLE', updated_at = $2 WHERE id = $1", [appId, ctx.now]);
      await audit(tx, ctx, { action: "CREDIT_CHECK_FAILED", outcome: "FAILURE", actorRole: app0.initiator_role, applicationId: appId, stage: "DRAFT", reason: call.message, details: { creditCheckId: check.id, code: call.code, httpStatus: call.httpStatus } });
      return { status: "UNAVAILABLE", checkId: check.id, message: `Credit check unavailable: ${call.message} No credit decision was made; try again.` };
    }
    const settings = await creditSettings(tx);
    const c = classify(call.result, settings);
    await tx.query(
      `UPDATE credit_checks SET status = 'COMPLETED', responded_at = $2, http_status = $3, provider_reference = $4, overall_score = $5, reviewed_score = $6,
          has_credit_history = $7, validity_date = $8, components = $9, response_enc = $10, outcome = $11, outcome_reasons = $12, settings_version = $13
        WHERE id = $1`,
      [check.id, call.respondedAt, call.httpStatus, call.result.providerReference, call.result.overallScore, call.result.reviewedScore, call.result.hasCreditHistory,
        call.result.validityDate, JSON.stringify(call.result.components), encryptField(JSON.stringify(call.result.raw)), c.outcome, JSON.stringify(c.reasons), settings.version],
    );
    // The credit report is produced from the stored response in the same transaction.
    await storeCreditReport(tx, ctx, appId, check.id);
    const details = { creditCheckId: check.id, outcome: c.outcome, score: c.score, overall: call.result.overallScore, reviewed: call.result.reviewedScore, hasCreditHistory: call.result.hasCreditHistory, settingsVersion: settings.version, providerReference: call.result.providerReference };
    await audit(tx, ctx, { action: "CREDIT_CHECK_COMPLETED", actorRole: app0.initiator_role, applicationId: appId, stage: "DRAFT", details });
    if (c.outcome === "ACCEPTABLE") {
      await tx.query("UPDATE applications SET credit_check_status = 'ACCEPTABLE', updated_at = $2 WHERE id = $1", [appId, ctx.now]);
      return { status: "ACCEPTABLE", checkId: check.id, message: "Credit check acceptable. Continue with the facility application." };
    }
    await referToProductManager(tx, ctx, app, c.reasons);
    return { status: "REVIEW_REQUIRED", checkId: check.id, message: "SeedFi returned adverse findings. The request has been sent to the Product Manager for review." };
  });
}

/** Adverse findings: open the Product Manager's credit review task. */
async function referToProductManager(tx: Tx, ctx: Ctx, app: AppRow, reasons: string[]) {
  const chosen = await chooseAssignee(tx, app, "CREDIT_REVIEW", { preferred: app.product_manager_id ?? null, random: true });
  await tx.query("UPDATE applications SET stage = 'CREDIT_REVIEW', credit_check_status = 'REVIEW_REQUIRED', product_manager_id = coalesce($2, product_manager_id), updated_at = $3, lock_version = lock_version + 1 WHERE id = $1", [app.id, chosen.staffId, ctx.now]);
  await audit(tx, ctx, { action: "STAGE_CHANGED", applicationId: app.id, stage: "CREDIT_REVIEW", details: { from: "DRAFT", to: "CREDIT_REVIEW" } });
  await audit(tx, ctx, { action: "CREDIT_CHECK_REFERRED", applicationId: app.id, stage: "CREDIT_REVIEW", reason: reasons.join("; ").slice(0, 500), details: { productManager: chosen.staffId } });
  await openTask(tx, ctx, { ...app, stage: "CREDIT_REVIEW" }, "CREDIT_REVIEW", chosen, "Adverse SeedFi findings");
}

/** Super Admin: change the rules that classify SeedFi results (append-only, prospective). */
export async function updateCreditSettings(ctx: Ctx, p: { minAcceptableScore: number; scoreBasis: string; requireCreditHistory: boolean; reason: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  try {
    return await withTx(async (tx) => {
      if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can change the credit check rules.");
      const f: Record<string, string> = {};
      if (!Number.isInteger(p.minAcceptableScore) || p.minAcceptableScore < 280 || p.minAcceptableScore > 800) f.minAcceptableScore = "Enter a Seed Score between 280 and 800.";
      if (!["REVIEWED", "OVERALL", "LOWER_OF_BOTH"].includes(p.scoreBasis)) f.scoreBasis = "Choose which score is compared.";
      if (!p.reason || p.reason.trim().length < 5) f.reason = "Give a reason for the change.";
      if (Object.keys(f).length) throw invalid("Check the credit check rules.", f);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('credit_check_settings'))");
      const prev = await creditSettings(tx);
      await tx.query(
        "INSERT INTO credit_check_settings (version, min_acceptable_score, score_basis, require_credit_history, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [prev.version + 1, p.minAcceptableScore, p.scoreBasis, p.requireCreditHistory, p.reason.trim(), actor.staffId, ctx.now],
      );
      await audit(tx, ctx, {
        action: "CREDIT_RULES_CHANGED",
        actorRole: "SUPER_ADMIN",
        reason: p.reason.trim(),
        details: { old: prev, new: { version: prev.version + 1, minAcceptableScore: p.minAcceptableScore, scoreBasis: p.scoreBasis, requireCreditHistory: p.requireCreditHistory } },
      });
    });
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") await auditOutsideTx(ctx, { action: "CREDIT_RULES_CHANGED", outcome: "DENIED", reason: e.message });
    throw e;
  }
}

/** The submitted application must describe the customer whose credit was checked. */
export async function assertCheckedIdentity(tx: Tx, app: { id: string; applicant_type: string; credit_check_status: string; credit_check_id: string | null }, version: { id: string; bvn_enc: string | null }) {
  if (app.credit_check_status === "NOT_REQUIRED") return;
  if (!ORIGINATION_ALLOWED.includes(app.credit_check_status)) throw gate("Complete the SeedFi credit check before submitting the facility application.");
  const check = (await tx.query<CreditCheckRow>("SELECT * FROM credit_checks WHERE id = $1", [app.credit_check_id])).rows[0];
  if (!check) throw gate("No credit check is recorded for this request.");
  const checked = decryptField(check.bvn_enc);
  if (app.applicant_type === "LIMITED") {
    const dirs = (await tx.query<{ bvn_enc: string }>("SELECT bvn_enc FROM application_directors WHERE version_id = $1", [version.id])).rows.map((d) => decryptField(d.bvn_enc));
    if (!dirs.includes(checked)) throw invalid("The credit-checked customer must be one of the directors listed on the application.", { directors: "Add the credit-checked director (same BVN)." });
    return;
  }
  const bvn = version.bvn_enc ? decryptField(version.bvn_enc) : null;
  if (bvn !== checked) throw invalid("The BVN on the application must match the credit-checked customer.", { bvn: `Use the credit-checked BVN ending ${check.bvn_last4}.` });
}
