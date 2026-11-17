/**
 * God's Eye: read-only management oversight for the Super Admin, Divisional Head and Unit Head.
 * Viewing grants no authority: no action here changes a facility. Users who separately hold an
 * approval or administration role act through the normal workflow. Customer identifiers stay masked
 * and document contents are opened only through the normal case access rules.
 */
import type { Db } from "../db";
import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { forbidden, invalid, notFound } from "../errors";
import { maskWithLast4 } from "../mask";
import { caseAccess, holdsRole } from "./access";
import { STAGES, STAGE_LABELS, type Stage } from "./stages";
import { latestCreditCheck } from "./credit-check";
import { liveOfferLetter } from "./offer-letters";
import { archiveFor } from "./archive";

export const OVERSIGHT_ROLES = ["SUPER_ADMIN", "DIVISIONAL_HEAD", "UNIT_HEAD"] as const;

export async function hasOversight(q: Db, staffId: string): Promise<boolean> {
  for (const r of OVERSIGHT_ROLES) if (await holdsRole(q, staffId, r)) return true;
  return false;
}

export async function requireOversight(ctx: Ctx, what: string, applicationId?: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  if (!(await hasOversight(db, actor.staffId))) {
    await auditOutsideTx(ctx, { action: "OVERSIGHT_VIEW", outcome: "DENIED", applicationId, details: { view: what } });
    throw forbidden("God's Eye is available to the Super Admin, Divisional Head and Unit Head only.");
  }
  await auditOutsideTx(ctx, { action: "OVERSIGHT_VIEW", applicationId, details: { view: what } });
}

export interface LifecycleStep {
  key: string;
  label: string;
  state: "done" | "current" | "pending" | "skipped" | "failed";
  at: Date | null;
  detail: string | null;
}

/** Full authorised lifecycle of one facility, from its own records. */
export async function facilityLifecycle(ctx: Ctx, appId: string) {
  await requireOversight(ctx, "facility", appId);
  const app = (await db.query("SELECT * FROM applications WHERE id = $1", [appId])).rows[0];
  if (!app) throw notFound();
  const version = app.current_version_id ? (await db.query("SELECT bvn_last4, data FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0] : null;
  const decisions = (await db.query("SELECT d.*, s.full_name FROM decisions d JOIN staff s ON s.id = d.actor_id WHERE d.application_id = $1 ORDER BY d.seq", [appId])).rows;
  const tasks = (await db.query("SELECT t.*, s.full_name FROM tasks t LEFT JOIN staff s ON s.id = t.assignee_id WHERE t.application_id = $1 ORDER BY t.seq", [appId])).rows;
  const docs = (await db.query("SELECT id, category, filename, version_no, uploaded_at, superseded_at, generated, scan_status FROM documents WHERE application_id = $1 ORDER BY uploaded_at", [appId])).rows;
  const credit = app.credit_check_status === "NOT_REQUIRED" ? null : await latestCreditCheck(db, appId);
  const letter = await liveOfferLetter(db, appId);
  const archive = await archiveFor(db, appId);
  const disb = (await db.query("SELECT * FROM disbursements WHERE application_id = $1", [appId])).rows[0] ?? null;
  const assessment = (await db.query("SELECT created_at, apr_percent, dsr_percent, markup_kobo, cost_plus_markup_kobo, threshold_result FROM credit_assessments WHERE application_id = $1 AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", [appId])).rows[0] ?? null;
  const people = (await db.query("SELECT id, full_name FROM staff WHERE id = ANY($1::uuid[])", [[app.initiator_id, app.product_manager_id].filter(Boolean)])).rows;
  const name = (id: string | null) => people.find((p: { id: string }) => p.id === id)?.full_name ?? null;
  const access = await caseAccess(db, ctx.actor!.staffId, appId);
  const last = (stage: string, actions: string[]) => decisions.filter((d: { stage: string; action: string; invalidated_at: Date | null }) => d.stage === stage && actions.includes(d.action) && !d.invalidated_at).at(-1);
  const openStage: string | null = tasks.find((t: { status: string }) => t.status === "OPEN")?.stage ?? null;
  const rejected = app.status === "REJECTED";
  const steps: LifecycleStep[] = [];
  steps.push({ key: "origination", label: "Origination", state: "done", at: app.created_at, detail: `Initiated by ${name(app.initiator_id)} (${app.initiator_role})` });
  steps.push({
    key: "credit",
    label: "Credit check",
    state: app.credit_check_status === "NOT_REQUIRED" ? "skipped" : credit?.status === "COMPLETED" ? "done" : credit?.status === "FAILED" ? "failed" : app.credit_check_status === "IN_PROGRESS" ? "current" : "pending",
    at: credit?.responded_at ?? null,
    detail: app.credit_check_status === "NOT_REQUIRED" ? app.credit_check_note : credit ? (credit.status === "COMPLETED" ? `SeedFi ${credit.outcome?.toLowerCase()} · reviewed score ${Number(credit.reviewed_score)}` : credit.error_message) : "Not yet run",
  });
  const pmDec = decisions.filter((d: { stage: string }) => d.stage === "CREDIT_REVIEW").at(-1);
  if (credit?.outcome === "ADVERSE" || pmDec)
    steps.push({ key: "pm", label: "Product Manager review", state: pmDec ? (pmDec.action === "DECLINE" ? "failed" : pmDec.action === "CLEAR_TO_PROCEED" ? "done" : "current") : "current", at: pmDec?.created_at ?? null, detail: pmDec ? `${pmDec.action.replace(/_/g, " ").toLowerCase()} by ${pmDec.full_name}: ${pmDec.reason}` : "Awaiting decision" });
  steps.push({ key: "assessment", label: "Assessment", state: assessment ? "done" : openStage === "FIRST_CREDIT_REVIEW" ? "current" : "pending", at: assessment?.created_at ?? null, detail: assessment ? `DSR ${Number(assessment.dsr_percent)}% · APR ${Number(assessment.apr_percent).toFixed(2)}%` : null });
  const finalApproval = last("DIVISIONAL_HEAD_REVIEW", ["APPROVE"]);
  const approvalOpen = openStage && ["BUSINESS_ENDORSEMENT", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW", "CREDIT_CORRECTION", "INITIATOR_CORRECTION"].includes(openStage);
  steps.push({ key: "approvals", label: "Approvals", state: finalApproval ? "done" : rejected ? "failed" : approvalOpen ? "current" : "pending", at: finalApproval?.created_at ?? null, detail: finalApproval ? `Final approval by ${finalApproval.full_name}` : approvalOpen ? `At ${STAGE_LABELS[openStage as Stage]}` : null });
  steps.push({ key: "documentation", label: "Murabaha documentation", state: letter?.acceptance_status === "SIGNED" ? "done" : letter?.status === "FAILED" ? "failed" : letter ? "current" : "pending", at: letter?.signed_at ?? letter?.issued_at ?? null, detail: letter ? `Offer letter ${letter.status.toLowerCase()}${letter.template_version ? ` (template v${letter.template_version})` : ""} · ${letter.acceptance_status.replace(/_/g, " ").toLowerCase()}` : null });
  steps.push({ key: "disbursement", label: "Disbursement", state: disb ? "done" : openStage && ["CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING"].includes(openStage) ? "current" : "pending", at: disb?.recorded_at ?? null, detail: disb ? `Booked ${disb.transaction_ref}` : null });
  steps.push({ key: "completion", label: "Completion", state: app.status === "CLOSED" ? "done" : openStage && ["COMPLETION", "VENDOR_CONFIRMATION"].includes(openStage) ? "current" : "pending", at: app.closed_at ?? null, detail: archive ? `Archive ${archive.status.toLowerCase().replace("_", " ")}` : null });
  return {
    app,
    bvn: maskWithLast4(version?.bvn_last4),
    goods: ((version?.data?.items ?? []) as { quantity: number; description: string }[]).map((i) => `${i.quantity} × ${i.description}`).join("; "),
    supplier: version?.data?.supplierName ?? "",
    initiator: name(app.initiator_id),
    productManager: name(app.product_manager_id),
    steps,
    decisions,
    tasks,
    documents: docs,
    canOpenDocuments: access.canView,
    credit,
  };
}

/** Super Admin: processing target for a stage (hours); blank removes it. */
export async function setStageTarget(ctx: Ctx, stage: string, hours: number | null) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  return withTx(async (tx) => {
    if (!(await holdsRole(tx, actor.staffId, "SUPER_ADMIN"))) throw forbidden("Only the Super Admin can set processing targets.");
    if (!(STAGES as readonly string[]).includes(stage)) throw invalid("Unknown stage.");
    if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 2160)) throw invalid("Enter a target between 1 and 2160 hours.");
    const prev = (await tx.query("SELECT target_hours FROM stage_targets WHERE stage = $1", [stage])).rows[0]?.target_hours ?? null;
    if (hours === null) await tx.query("DELETE FROM stage_targets WHERE stage = $1", [stage]);
    else await tx.query("INSERT INTO stage_targets (stage, target_hours, updated_by, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (stage) DO UPDATE SET target_hours = $2, updated_by = $3, updated_at = $4", [stage, hours, actor.staffId, ctx.now]);
    await audit(tx, ctx, { action: "STAGE_TARGET_CHANGED", actorRole: "SUPER_ADMIN", details: { stage, old: prev, new: hours } });
  });
}
