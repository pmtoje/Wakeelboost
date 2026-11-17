/**
 * Performance metrics computed from WakeelBoost records (applications, tasks, decisions,
 * disbursements, credit checks). Nothing is stored or reset at month end: every figure is a query
 * over the underlying history, in the bank's reporting timezone (Africa/Lagos).
 *
 * Values are kept distinct: requested (submitted amount), approved (Divisional Head approval, at the
 * approved principal), disbursed (booked amount) and contracted markup (Murabaha markup on the
 * approved assessment). Recognised income needs core-banking data and is reported as unavailable.
 * Counts are of distinct facilities so a request moving between stages is never counted twice.
 */
import type { Db } from "../db";
import { fromLagos, lagosParts } from "../time";

export interface Period {
  from: Date;
  to: Date;
  label: string;
}

/** First calendar day of the current Lagos month (00:00 WAT) to now. */
export function monthToDate(now = new Date()): Period {
  const p = lagosParts(now);
  return { from: fromLagos(p.year, p.month, 1), to: now, label: "Month to date" };
}
export function periodFor(preset: string, now = new Date(), custom?: { from?: string; to?: string }): Period {
  const p = lagosParts(now);
  switch (preset) {
    case "today":
      return { from: fromLagos(p.year, p.month, p.day), to: now, label: "Today" };
    case "prev": {
      const y = p.month === 1 ? p.year - 1 : p.year;
      const m = p.month === 1 ? 12 : p.month - 1;
      return { from: fromLagos(y, m, 1), to: fromLagos(p.year, p.month, 1), label: "Previous month" };
    }
    case "ytd":
      return { from: fromLagos(p.year, 1, 1), to: now, label: "Year to date" };
    case "custom": {
      const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (ok(custom?.from) && ok(custom?.to)) {
        const [fy, fm, fd] = custom!.from!.split("-").map(Number);
        const [ty, tm, td] = custom!.to!.split("-").map(Number);
        const from = fromLagos(fy, fm, fd);
        const to = new Date(fromLagos(ty, tm, td).getTime() + 864e5);
        if (to > from) return { from, to, label: `${custom!.from} to ${custom!.to}` };
      }
      return monthToDate(now);
    }
    default:
      return monthToDate(now);
  }
}

const n = (v: unknown) => Number(v ?? 0);
/** SQL for the approved principal of a facility (approved assessment, else requested amount). */
const APPROVED_PRINCIPAL = `coalesce((SELECT (ca.outputs->>'amountApprovedKobo')::bigint FROM credit_assessments ca WHERE ca.application_id = a.id AND ca.superseded_at IS NULL ORDER BY ca.created_at DESC LIMIT 1), a.requested_amount_kobo, 0)`;
const APPROVED_MARKUP = `coalesce((SELECT ca.markup_kobo FROM credit_assessments ca WHERE ca.application_id = a.id AND ca.superseded_at IS NULL ORDER BY ca.created_at DESC LIMIT 1), 0)`;
const FINAL_APPROVAL = `(SELECT min(d.created_at) FROM decisions d WHERE d.application_id = a.id AND d.stage = 'DIVISIONAL_HEAD_REVIEW' AND d.action = 'APPROVE' AND d.invalidated_at IS NULL)`;

export const APPROVAL_STAGES = ["BUSINESS_ENDORSEMENT", "FIRST_CREDIT_REVIEW", "SECOND_CREDIT_REVIEW", "UNIT_HEAD_REVIEW", "DIVISIONAL_HEAD_REVIEW"];
export const DISBURSEMENT_STAGES = ["OFFER_PREPARATION", "CO3_PACK_REVIEW", "DISBURSEMENT_CHECK", "DISBURSEMENT_CORRECTION", "DISBURSEMENT_BOOKING"];

// ------------------------------------------------------------------ personal (MTD) summaries

export async function initiatorMetrics(q: Db, staffId: string, p: Period) {
  const r = (
    await q.query(
      `SELECT
         count(*) FILTER (WHERE a.created_at >= $2 AND a.created_at < $3) AS initiated,
         coalesce(sum(a.requested_amount_kobo) FILTER (WHERE a.submitted_at >= $2 AND a.submitted_at < $3), 0) AS requested_value,
         count(*) FILTER (WHERE a.submitted_at >= $2 AND a.submitted_at < $3) AS submitted,
         count(*) FILTER (WHERE ${FINAL_APPROVAL} >= $2 AND ${FINAL_APPROVAL} < $3) AS approved,
         coalesce(sum(${APPROVED_PRINCIPAL}) FILTER (WHERE ${FINAL_APPROVAL} >= $2 AND ${FINAL_APPROVAL} < $3), 0) AS approved_value,
         count(*) FILTER (WHERE a.status = 'IN_PROGRESS') AS pending,
         count(*) FILTER (WHERE a.rejected_at >= $2 AND a.rejected_at < $3) AS declined,
         count(*) FILTER (WHERE a.credit_check_status = 'CLARIFICATION_REQUIRED' OR a.stage = 'INITIATOR_CORRECTION') AS clarification
       FROM applications a WHERE a.initiator_id = $1`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  const d = (
    await q.query(
      `SELECT count(*) AS n, coalesce(sum(d.amount_kobo), 0) AS v FROM disbursements d JOIN applications a ON a.id = d.application_id
        WHERE a.initiator_id = $1 AND d.recorded_at >= $2 AND d.recorded_at < $3`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  const waiting = (await q.query("SELECT count(*) AS n FROM tasks WHERE status = 'OPEN' AND assignee_id = $1", [staffId])).rows[0].n;
  const drafts = (await q.query("SELECT count(*) AS n FROM applications WHERE initiator_id = $1 AND stage = 'DRAFT'", [staffId])).rows[0].n;
  return {
    initiated: n(r.initiated),
    submitted: n(r.submitted),
    requestedValue: n(r.requested_value),
    approved: n(r.approved),
    approvedValue: n(r.approved_value),
    disbursed: n(d.n),
    disbursedValue: n(d.v),
    pending: n(r.pending),
    declined: n(r.declined),
    clarification: n(r.clarification),
    awaitingMe: n(waiting) + n(drafts),
  };
}

export async function productManagerMetrics(q: Db, staffId: string, p: Period) {
  const t = (
    await q.query(
      `SELECT
         count(*) FILTER (WHERE stage = 'CREDIT_REVIEW' AND entered_at >= $2 AND entered_at < $3) AS received,
         count(*) FILTER (WHERE stage = 'CREDIT_REVIEW' AND status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS completed,
         count(*) FILTER (WHERE stage = 'CREDIT_REVIEW' AND status = 'OPEN') AS waiting,
         avg(extract(epoch FROM completed_at - entered_at)) FILTER (WHERE stage = 'CREDIT_REVIEW' AND status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS avg_secs,
         count(*) FILTER (WHERE stage <> 'CREDIT_REVIEW' AND status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS other_completed,
         count(*) FILTER (WHERE stage <> 'CREDIT_REVIEW' AND status = 'OPEN') AS other_waiting
       FROM tasks WHERE assignee_id = $1`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  const d = (
    await q.query(
      `SELECT count(*) FILTER (WHERE action = 'CLEAR_TO_PROCEED') AS cleared, count(*) FILTER (WHERE action = 'DECLINE') AS declined,
              count(*) FILTER (WHERE action = 'REQUEST_CLARIFICATION') AS clarified
         FROM decisions WHERE actor_id = $1 AND stage = 'CREDIT_REVIEW' AND created_at >= $2 AND created_at < $3`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  return {
    received: n(t.received),
    completed: n(t.completed),
    cleared: n(d.cleared),
    declined: n(d.declined),
    clarifications: n(d.clarified),
    waiting: n(t.waiting),
    avgTurnaroundMs: t.avg_secs === null ? null : n(t.avg_secs) * 1000,
    otherCompleted: n(t.other_completed),
    otherWaiting: n(t.other_waiting),
  };
}

export async function approverMetrics(q: Db, staffId: string, p: Period) {
  const t = (
    await q.query(
      `SELECT
         count(*) FILTER (WHERE assigned_at >= $2 AND assigned_at < $3) AS received,
         count(*) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS reviewed,
         count(*) FILTER (WHERE status = 'OPEN') AS waiting,
         avg(extract(epoch FROM completed_at - coalesce(assigned_at, entered_at))) FILTER (WHERE status = 'COMPLETED' AND completed_at >= $2 AND completed_at < $3) AS avg_secs
       FROM tasks WHERE assignee_id = $1`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  const d = (
    await q.query(
      `SELECT count(DISTINCT d.application_id) FILTER (WHERE d.action IN ('APPROVE','PROCEED','ENDORSE')) AS approved,
              count(DISTINCT d.application_id) FILTER (WHERE d.action IN ('RETURN','SEND_FOR_CORRECTION','REQUEST_INITIATOR')) AS returned,
              count(DISTINCT d.application_id) FILTER (WHERE d.action = 'REJECT') AS declined
         FROM decisions d WHERE d.actor_id = $1 AND d.created_at >= $2 AND d.created_at < $3`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  const v = (
    await q.query(
      `SELECT coalesce(sum(${APPROVED_PRINCIPAL}), 0) AS v FROM applications a
        WHERE a.id IN (SELECT d.application_id FROM decisions d WHERE d.actor_id = $1 AND d.action IN ('APPROVE','PROCEED','ENDORSE') AND d.created_at >= $2 AND d.created_at < $3)`,
      [staffId, p.from, p.to],
    )
  ).rows[0];
  return {
    received: n(t.received),
    reviewed: n(t.reviewed),
    approved: n(d.approved),
    returned: n(d.returned),
    declined: n(d.declined),
    approvedValue: n(v.v),
    waiting: n(t.waiting),
    avgTurnaroundMs: t.avg_secs === null ? null : n(t.avg_secs) * 1000,
  };
}

// ------------------------------------------------------------------ God's Eye (oversight)

export interface OversightFilters {
  rm?: string | null;
  team?: string | null; // initiator role: RM / ANM / MERCHANT_OFFICER
  region?: string | null;
  status?: string | null;
  stage?: string | null;
  minKobo?: number | null;
  maxKobo?: number | null;
  credit?: string | null; // credit_check_status
}

function filterSql(f: OversightFilters, params: unknown[]) {
  const w: string[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    w.push(sql.replace("?", `$${params.length}`));
  };
  if (f.rm) add("a.initiator_id = ?", f.rm);
  if (f.team) add("a.initiator_role = ?", f.team);
  if (f.region) add("a.region = ?", f.region);
  if (f.status) add("a.status = ?", f.status);
  if (f.stage) add("a.stage = ?", f.stage);
  if (f.minKobo != null) add("a.requested_amount_kobo >= ?", f.minKobo);
  if (f.maxKobo != null) add("a.requested_amount_kobo <= ?", f.maxKobo);
  if (f.credit) add("a.credit_check_status = ?", f.credit);
  return w.length ? `AND ${w.join(" AND ")}` : "";
}

export async function oversightOverview(q: Db, p: Period, f: OversightFilters) {
  const params: unknown[] = [p.from, p.to, APPROVAL_STAGES, DISBURSEMENT_STAGES];
  const where = filterSql(f, params);
  const r = (
    await q.query(
      `SELECT
         count(*) FILTER (WHERE a.submitted_at >= $1 AND a.submitted_at < $2) AS requested,
         coalesce(sum(a.requested_amount_kobo) FILTER (WHERE a.submitted_at >= $1 AND a.submitted_at < $2), 0) AS requested_value,
         count(*) FILTER (WHERE ${FINAL_APPROVAL} >= $1 AND ${FINAL_APPROVAL} < $2) AS approved,
         coalesce(sum(${APPROVED_PRINCIPAL}) FILTER (WHERE ${FINAL_APPROVAL} >= $1 AND ${FINAL_APPROVAL} < $2), 0) AS approved_value,
         count(*) FILTER (WHERE d.recorded_at >= $1 AND d.recorded_at < $2) AS disbursed,
         coalesce(sum(d.amount_kobo) FILTER (WHERE d.recorded_at >= $1 AND d.recorded_at < $2), 0) AS disbursed_value,
         coalesce(sum(${APPROVED_MARKUP}) FILTER (WHERE d.recorded_at >= $1 AND d.recorded_at < $2), 0) AS markup,
         count(*) FILTER (WHERE a.status = 'IN_PROGRESS' AND a.stage = ANY($3::text[])) AS pending_approvals,
         count(*) FILTER (WHERE a.status = 'IN_PROGRESS' AND a.stage = ANY($4::text[])) AS pending_disbursement,
         count(*) FILTER (WHERE a.status IN ('DRAFT','IN_PROGRESS') AND a.stage NOT IN ('REJECTED','CLOSED')) AS pending_applications,
         count(*) FILTER (WHERE a.rejected_at >= $1 AND a.rejected_at < $2) AS declined,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM credit_checks c WHERE c.application_id = a.id AND c.outcome = 'ADVERSE' AND c.responded_at >= $1 AND c.responded_at < $2)) AS referred,
         avg(extract(epoch FROM d.recorded_at - a.submitted_at)) FILTER (WHERE d.recorded_at >= $1 AND d.recorded_at < $2) AS avg_secs
       FROM applications a LEFT JOIN disbursements d ON d.application_id = a.id
      WHERE true ${where}`,
      params,
    )
  ).rows[0];
  return {
    requested: n(r.requested),
    requestedValue: n(r.requested_value),
    approved: n(r.approved),
    approvedValue: n(r.approved_value),
    disbursed: n(r.disbursed),
    disbursedValue: n(r.disbursed_value),
    contractedMarkup: n(r.markup),
    recognisedIncome: null as number | null, // requires core-banking data (not integrated)
    pendingApplications: n(r.pending_applications),
    pendingApprovals: n(r.pending_approvals),
    pendingDisbursement: n(r.pending_disbursement),
    declined: n(r.declined),
    referred: n(r.referred),
    avgTurnaroundMs: r.avg_secs === null ? null : n(r.avg_secs) * 1000,
  };
}

export interface OpenTaskRow {
  task_id: string;
  application_id: string;
  ref: string;
  customer_name: string | null;
  requested_amount_kobo: string | null;
  stage: string;
  assignee_role: string;
  holder: string | null;
  initiator: string | null;
  entered_at: Date;
  waiting_secs: number;
  returned: boolean;
  required_action: string;
  target_hours: number | null;
}

/** Every open task with its holder and how long it has been waiting (from task timestamps). */
export async function openQueue(q: Db, f: OversightFilters, now = new Date()): Promise<OpenTaskRow[]> {
  const params: unknown[] = [now];
  const where = filterSql(f, params);
  return (
    await q.query<OpenTaskRow>(
      `SELECT t.id AS task_id, a.id AS application_id, a.ref, a.customer_name, a.requested_amount_kobo, t.stage, t.assignee_role,
              s.full_name AS holder, i.full_name AS initiator, t.entered_at, extract(epoch FROM $1 - t.entered_at)::float AS waiting_secs,
              (a.active_correction_id IS NOT NULL OR t.stage IN ('INITIATOR_CORRECTION','CREDIT_CORRECTION','DISBURSEMENT_CORRECTION','CREDIT_CLARIFICATION')) AS returned,
              t.required_action, st.target_hours
         FROM tasks t JOIN applications a ON a.id = t.application_id
         LEFT JOIN staff s ON s.id = t.assignee_id LEFT JOIN staff i ON i.id = a.initiator_id
         LEFT JOIN stage_targets st ON st.stage = t.stage
        WHERE t.status = 'OPEN' ${where}
        ORDER BY t.entered_at ASC LIMIT 500`,
      params,
    )
  ).rows;
}

export async function stageTargets(q: Db): Promise<Record<string, number>> {
  return Object.fromEntries((await q.query<{ stage: string; target_hours: number }>("SELECT stage, target_hours FROM stage_targets")).rows.map((r) => [r.stage, r.target_hours]));
}
