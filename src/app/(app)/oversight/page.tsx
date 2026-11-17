import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Eye } from "lucide-react";
import { requireUser } from "../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { formatKobo, parseNairaToKobo } from "@/server/money";
import { formatDuration, formatLagos } from "@/server/time";
import { STAGES, STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { CREDIT_STATUS_LABEL, type CreditCheckStatus } from "@/server/domain/credit-check";
import { openQueue, oversightOverview, periodFor, stageTargets, type OversightFilters } from "@/server/domain/metrics";
import { requireOversight } from "@/server/domain/oversight";
import { holdsRole } from "@/server/domain/access";
import { PageHeader } from "@/components/PageHeader";
import { BankEndorsement } from "@/components/Brand";
import { StageTargetForm } from "./OversightForms";

export const metadata = { title: "God's Eye" };

const naira = (k: number) => formatKobo(k).replace(/\.00$/, "");
const dur = (ms: number | null) => (ms === null ? "—" : formatDuration(ms));

export default async function GodsEye({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, session } = await requireUser();
  try {
    await requireOversight(ctx, "overview");
  } catch (e) {
    if (e instanceof DomainError) redirect("/forbidden");
    throw e;
  }
  const sp = await searchParams;
  const now = new Date();
  const period = periodFor(sp.period ?? "mtd", now, { from: sp.from, to: sp.to });
  const kobo = (v?: string) => {
    if (!v) return null;
    try {
      return parseNairaToKobo(v);
    } catch {
      return null;
    }
  };
  const f: OversightFilters = {
    rm: sp.rm && /^[0-9a-f-]{36}$/.test(sp.rm) ? sp.rm : null,
    team: ["RM", "ANM", "MERCHANT_OFFICER"].includes(sp.team ?? "") ? sp.team! : null,
    region: sp.region || null,
    status: ["DRAFT", "IN_PROGRESS", "BOOKED", "CLOSED", "REJECTED"].includes(sp.status ?? "") ? sp.status! : null,
    stage: (STAGES as readonly string[]).includes(sp.stage ?? "") ? sp.stage! : null,
    minKobo: kobo(sp.min),
    maxKobo: kobo(sp.max),
    credit: sp.credit && sp.credit in CREDIT_STATUS_LABEL ? sp.credit : null,
  };
  const o = await oversightOverview(db, period, f);
  const queue = await openQueue(db, f, now);
  const targets = await stageTargets(db);
  const isAdmin = await holdsRole(db, session.staffId, "SUPER_ADMIN");
  const initiators = (await db.query("SELECT DISTINCT s.id, s.full_name FROM applications a JOIN staff s ON s.id = a.initiator_id ORDER BY s.full_name")).rows;
  const regions = (await db.query("SELECT DISTINCT region FROM applications WHERE region IS NOT NULL ORDER BY region")).rows.map((r) => r.region as string);
  const overdue = queue.filter((t) => t.target_hours && t.waiting_secs > t.target_hours * 3600);
  const unassigned = queue.filter((t) => !t.holder);
  const returned = queue.filter((t) => t.returned);
  const byStage = new Map<string, { n: number; total: number; max: number; overdue: number }>();
  for (const t of queue) {
    const b = byStage.get(t.stage) ?? { n: 0, total: 0, max: 0, overdue: 0 };
    b.n++;
    b.total += t.waiting_secs;
    b.max = Math.max(b.max, t.waiting_secs);
    if (t.target_hours && t.waiting_secs > t.target_hours * 3600) b.overdue++;
    byStage.set(t.stage, b);
  }
  const bottlenecks = [...byStage.entries()].sort((a, b) => b[1].total / b[1].n - a[1].total / a[1].n);
  const anyTargets = Object.keys(targets).length > 0;
  const qs = (extra: Record<string, string>) => {
    const u = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v); else u.delete(k);
    return `?${u.toString()}`;
  };
  return (
    <>
      <PageHeader
        eyebrow="Management oversight"
        title="God's Eye"
        intro={<>Consolidated, read-only view of the WakeelBoost financing lifecycle. Viewing grants no authority to change, approve or disburse; act through the normal workflow where you hold that role.</>}
        actions={<BankEndorsement height={44} />}
      />
      <form className="filters" method="get" aria-label="Filter oversight">
        <div className="field">
          <label htmlFor="period">Period</label>
          <select id="period" name="period" defaultValue={sp.period ?? "mtd"}>
            <option value="today">Today</option>
            <option value="mtd">Month to date</option>
            <option value="prev">Previous month</option>
            <option value="ytd">Year to date</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div className="field"><label htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={sp.from ?? ""} /></div>
        <div className="field"><label htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={sp.to ?? ""} /></div>
        <div className="field">
          <label htmlFor="rm">Relationship Manager / initiator</label>
          <select id="rm" name="rm" defaultValue={f.rm ?? ""}>
            <option value="">All</option>
            {initiators.map((i) => <option key={i.id} value={i.id}>{i.full_name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="team">Team</label>
          <select id="team" name="team" defaultValue={f.team ?? ""}>
            <option value="">All teams</option>
            <option value="RM">Relationship Managers</option>
            <option value="ANM">Agent Network</option>
            <option value="MERCHANT_OFFICER">Merchant Officers</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="region">Location</label>
          <select id="region" name="region" defaultValue={f.region ?? ""}>
            <option value="">All</option>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Facility status</label>
          <select id="status" name="status" defaultValue={f.status ?? ""}>
            <option value="">All</option>
            {["DRAFT", "IN_PROGRESS", "BOOKED", "CLOSED", "REJECTED"].map((s) => <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="stage">Approval stage</label>
          <select id="stage" name="stage" defaultValue={f.stage ?? ""}>
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="min">Amount from (₦)</label><input id="min" name="min" inputMode="decimal" defaultValue={sp.min ?? ""} /></div>
        <div className="field"><label htmlFor="max">Amount to (₦)</label><input id="max" name="max" inputMode="decimal" defaultValue={sp.max ?? ""} /></div>
        <div className="field">
          <label htmlFor="credit">Credit check</label>
          <select id="credit" name="credit" defaultValue={f.credit ?? ""}>
            <option value="">All outcomes</option>
            {(Object.keys(CREDIT_STATUS_LABEL) as CreditCheckStatus[]).map((k) => <option key={k} value={k}>{CREDIT_STATUS_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field" style={{ alignSelf: "end" }}><button className="btn btn-primary" type="submit">Apply</button></div>
      </form>

      <section aria-labelledby="ov-h" style={{ marginBottom: 20 }}>
        <h2 id="ov-h">Executive overview <span className="small muted">· {period.label} ({formatLagos(period.from)} to {formatLagos(period.to)})</span></h2>
        <div className="metric-grid perf-grid">
          <div className="metric"><div className="k">Requested</div><div className="v tnum">{o.requested}</div><div className="small muted">{naira(o.requestedValue)}</div></div>
          <div className="metric"><div className="k">Approved</div><div className="v tnum">{o.approved}</div><div className="small muted">{naira(o.approvedValue)}</div></div>
          <div className="metric"><div className="k">Disbursed</div><div className="v tnum">{o.disbursed}</div><div className="small muted">{naira(o.disbursedValue)}</div></div>
          <div className="metric"><div className="k">Contracted markup</div><div className="v tnum">{naira(o.contractedMarkup)}</div><div className="small muted">On facilities disbursed in the period</div></div>
          <div className="metric"><div className="k">Recognised income</div><div className="v">—</div><div className="small muted">Needs core-banking data (not integrated)</div></div>
          <div className="metric"><div className="k">Avg. submission to disbursement</div><div className="v">{dur(o.avgTurnaroundMs)}</div></div>
          <Link className="metric metric-link" href={qs({ status: "IN_PROGRESS" })}><div className="k">Pending applications</div><div className="v tnum">{o.pendingApplications}</div><div className="small muted">Drafts and in progress (now)</div></Link>
          <div className="metric"><div className="k">Pending approvals</div><div className="v tnum">{o.pendingApprovals}</div></div>
          <div className="metric"><div className="k">Pending disbursement</div><div className="v tnum">{o.pendingDisbursement}</div></div>
          <Link className="metric metric-link" href={qs({ status: "REJECTED" })}><div className="k">Declined</div><div className="v tnum">{o.declined}</div></Link>
          <Link className="metric metric-link" href={qs({ credit: "REVIEW_REQUIRED" })}><div className="k">Referred to Product Manager</div><div className="v tnum">{o.referred}</div></Link>
          <div className="metric"><div className="k">Delayed beyond target</div><div className="v tnum">{anyTargets ? overdue.length : "—"}</div><div className="small muted">{anyTargets ? "Open tasks over their stage target" : "No processing targets set"}</div></div>
        </div>
      </section>

      <section aria-labelledby="bn-h" className="card" style={{ marginBottom: 16 }}>
        <h2 id="bn-h">Bottlenecks by stage</h2>
        {bottlenecks.length === 0 ? <p className="small muted">No open tasks match the filters.</p> : (
          <div className="table-wrap">
            <table className="data responsive">
              <thead><tr><th>Stage</th><th>Open</th><th>Average wait</th><th>Longest wait</th><th>Target</th><th>Over target</th></tr></thead>
              <tbody>
                {bottlenecks.map(([stage, b]) => (
                  <tr key={stage}>
                    <td data-label="Stage"><Link href={qs({ stage })}>{STAGE_LABELS[stage as Stage] ?? stage}</Link></td>
                    <td data-label="Open" className="tnum">{b.n}</td>
                    <td data-label="Average wait">{formatDuration((b.total / b.n) * 1000)}</td>
                    <td data-label="Longest wait">{formatDuration(b.max * 1000)}</td>
                    <td data-label="Target">{targets[stage] ? `${targets[stage]} h` : "—"}</td>
                    <td data-label="Over target" className="tnum">{targets[stage] ? b.overdue : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(unassigned.length > 0 || overdue.length > 0) && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          <AlertTriangle className="icon" aria-hidden="true" />
          <span>
            <strong>Escalations:</strong> {unassigned.length} task{unassigned.length === 1 ? "" : "s"} with no eligible assignee{anyTargets ? `, ${overdue.length} over target` : ""}. {returned.length} returned for correction.
          </span>
        </div>
      )}

      <section aria-labelledby="q-h" className="card" style={{ marginBottom: 16 }}>
        <h2 id="q-h">Who holds what <span className="small muted">· {queue.length} open task{queue.length === 1 ? "" : "s"}, oldest first</span></h2>
        {queue.length === 0 ? <p className="small muted">No facilities are waiting on anyone for these filters.</p> : (
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Facility</th><th>Amount</th><th>Stage and pending requirement</th><th>Held by</th><th>In queue</th><th><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {queue.map((t) => {
                const late = t.target_hours && t.waiting_secs > t.target_hours * 3600;
                return (
                  <tr key={t.task_id}>
                    <td data-label="Facility"><strong>{t.ref}</strong><div className="small muted">{t.customer_name ?? "—"} · {t.initiator}</div></td>
                    <td data-label="Amount" className="tnum">{t.requested_amount_kobo ? naira(Number(t.requested_amount_kobo)) : "—"}</td>
                    <td data-label="Stage">{STAGE_LABELS[t.stage as Stage] ?? t.stage}<div className="small muted">{t.required_action}</div>{t.returned && <span className="badge badge-warn">Returned for correction</span>}</td>
                    <td data-label="Held by">{t.holder ?? <span className="badge badge-red">Unassigned</span>}<div className="small muted">{ROLE_LABELS[t.assignee_role as Role] ?? t.assignee_role}</div></td>
                    <td data-label="In queue">{formatDuration(t.waiting_secs * 1000)}<div className="small muted">since {formatLagos(t.entered_at)}</div>{late && <span className="badge badge-red">Over {t.target_hours} h target</span>}</td>
                    <td className="row-actions"><Link className="btn btn-sm" href={`/oversight/${t.application_id}`}><Eye className="icon" aria-hidden="true" /> Lifecycle</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </section>

      {isAdmin && (
        <details className="card">
          <summary><strong>Processing targets</strong> <span className="small muted">· Super Admin · used for “delayed beyond target”</span></summary>
          <p className="small muted">Targets are the bank&apos;s service levels per stage, in hours. None are set by default. Changes are audited.</p>
          <StageTargetForm stages={STAGES.filter((s) => !["DRAFT", "CLOSED", "REJECTED"].includes(s)).map((s) => ({ stage: s, label: STAGE_LABELS[s], hours: targets[s] ?? null }))} />
        </details>
      )}
    </>
  );
}
