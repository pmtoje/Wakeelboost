import Link from "next/link";
import { db } from "@/server/db";
import { formatKobo } from "@/server/money";
import { formatDuration } from "@/server/time";
import { approverMetrics, initiatorMetrics, monthToDate, productManagerMetrics } from "@/server/domain/metrics";
import { INITIATOR_ROLES, ROLE_LABELS, type Role } from "@/server/domain/roles";

function Tile({ k, v, sub, href }: { k: string; v: string | number; sub?: string; href?: string }) {
  const body = (
    <>
      <div className="k">{k}</div>
      <div className="v tnum">{v}</div>
      {sub && <div className="small muted">{sub}</div>}
    </>
  );
  return href ? <Link className="metric metric-link" href={href}>{body}</Link> : <div className="metric">{body}</div>;
}
const naira = (k: number) => (k ? formatKobo(k).replace(/\.00$/, "") : "₦0");
const dur = (ms: number | null) => (ms === null ? "—" : formatDuration(ms));

/** Personal month-to-date summary for the active workspace, from WakeelBoost records (Lagos time). */
export async function MyPerformance({ staffId, workspace }: { staffId: string; workspace: Role | null }) {
  const p = monthToDate();
  const month = p.from.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "Africa/Lagos" });
  let tiles: React.ReactNode;
  if (workspace && (INITIATOR_ROLES as readonly string[]).includes(workspace)) {
    const m = await initiatorMetrics(db, staffId, p);
    tiles = (
      <>
        <Tile k="Requests initiated" v={m.initiated} sub={`${m.submitted} submitted`} />
        <Tile k="Value requested" v={naira(m.requestedValue)} />
        <Tile k="Approved" v={m.approved} sub={naira(m.approvedValue)} />
        <Tile k="Disbursed" v={m.disbursed} sub={naira(m.disbursedValue)} />
        <Tile k="Pending" v={m.pending} sub="in approval or disbursement" href="/requests" />
        <Tile k="Declined" v={m.declined} />
        <Tile k="Awaiting clarification" v={m.clarification} />
        <Tile k="Waiting for you" v={m.awaitingMe} sub="tasks and drafts" />
      </>
    );
  } else if (workspace === "PRODUCT_MANAGER") {
    const m = await productManagerMetrics(db, staffId, p);
    tiles = (
      <>
        <Tile k="Credit reviews received" v={m.received} />
        <Tile k="Reviews completed" v={m.completed} />
        <Tile k="Cleared to proceed" v={m.cleared} />
        <Tile k="Declined" v={m.declined} />
        <Tile k="Clarifications requested" v={m.clarifications} />
        <Tile k="Awaiting your review" v={m.waiting} />
        <Tile k="Average review time" v={dur(m.avgTurnaroundMs)} />
        {(m.otherCompleted > 0 || m.otherWaiting > 0) && <Tile k="Other reviews" v={m.otherCompleted} sub={`${m.otherWaiting} waiting`} />}
      </>
    );
  } else {
    const m = await approverMetrics(db, staffId, p);
    tiles = (
      <>
        <Tile k="Received for action" v={m.received} />
        <Tile k="Reviewed" v={m.reviewed} />
        <Tile k="Approved / endorsed" v={m.approved} sub={naira(m.approvedValue)} />
        <Tile k="Returned" v={m.returned} />
        <Tile k="Declined" v={m.declined} />
        <Tile k="Awaiting your action" v={m.waiting} />
        <Tile k="Average time to act" v={dur(m.avgTurnaroundMs)} />
      </>
    );
  }
  return (
    <section className="my-perf" aria-labelledby="my-perf-h">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 id="my-perf-h" style={{ margin: 0 }}>My performance · {month} to date</h2>
        <span className="small muted">{workspace ? ROLE_LABELS[workspace] : ""} · from WakeelBoost records, Lagos time</span>
      </div>
      <div className="metric-grid perf-grid">{tiles}</div>
    </section>
  );
}
