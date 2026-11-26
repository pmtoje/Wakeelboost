import Link from "next/link";
import { ArrowRight, ClipboardCheck, Search } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { db } from "@/server/db";
import { PROCESSED_OUTCOMES, processedRequests, type ProcessedOutcome } from "@/server/domain/views";
import { ACTION_LABELS, STAGE_LABELS, type Stage, type TaskAction } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { formatKobo } from "@/server/money";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { StageChip } from "@/components/Status";
import { pageHref } from "@/components/SortHeader";

export const metadata = { title: "Processed Requests" };

export default async function Processed({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session } = await requireUser();
  const sp = await searchParams;
  const outcome = sp.outcome && sp.outcome in PROCESSED_OUTCOMES ? (sp.outcome as ProcessedOutcome) : null;
  const q = await processedRequests(db, session.staffId, {
    outcome,
    q: sp.q || null,
    page: Number(sp.page ?? 1) || 1,
    pageSize: 20,
  });
  const filtered = !!(outcome || sp.q);
  return (
    <>
      <PageHeader
        eyebrow="Work"
        title="Processed Requests"
        intro={
          <>
            {q.total} request{q.total === 1 ? "" : "s"} you have decided on
            {filtered ? " matching the filters" : ""}. Open one for its full history and documents.
          </>
        }
      />
      <form className="filters" method="get" role="search" aria-label="Filter processed requests">
        <div className="field">
          <label htmlFor="pq">Search</label>
          <input id="pq" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Request ID or customer" />
        </div>
        <div className="field">
          <label htmlFor="po">Outcome</label>
          <select id="po" name="outcome" defaultValue={outcome ?? ""}>
            <option value="">All outcomes</option>
            <option value="approved">Approved / endorsed</option>
            <option value="returned">Returned</option>
            <option value="declined">Declined</option>
          </select>
        </div>
        <button className="btn">
          <Search className="icon" aria-hidden="true" />Apply
        </button>
        {filtered && (
          <Link className="btn btn-ghost" href="/requests/processed">
            Clear filters
          </Link>
        )}
      </form>
      <div className="table-wrap">
        <table className="data responsive">
          <caption className="sr-only">Requests you have decided on</caption>
          <thead>
            <tr>
              <th scope="col">Request ID</th>
              <th scope="col">Customer</th>
              <th scope="col">Amount</th>
              <th scope="col">Your action</th>
              <th scope="col">Current stage</th>
              <th scope="col">Current owner</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  <ClipboardCheck className="icon" aria-hidden="true" />
                  {filtered ? "No requests match these filters." : "Requests you approve, return or decline appear here."}
                </td>
              </tr>
            )}
            {q.rows.map((r) => (
              <tr key={r.application_id} className="clickable">
                <td className="nowrap" data-label="Request ID">
                  <Link className="row-link mono" href={`/requests/${r.application_id}`}>
                    {r.ref}
                  </Link>
                </td>
                <td data-label="Customer">{r.customer_name ?? "—"}</td>
                <td className="num" data-label="Amount">{formatKobo(r.requested_amount_kobo)}</td>
                <td className="small" data-label="Your action">
                  <strong>{ACTION_LABELS[r.action as TaskAction] ?? r.action}</strong>
                  <div className="muted">{STAGE_LABELS[r.decision_stage as Stage]}</div>
                  <div className="muted">{formatLagos(r.acted_at)}</div>
                  {r.invalidated_at && <span className="badge badge-warn">Superseded</span>}
                  {r.reason && <div className="muted">{r.reason}</div>}
                </td>
                <td data-label="Current stage">
                  <StageChip stage={r.current_stage as Stage} status={r.status} />
                </td>
                <td className="small" data-label="Current owner">
                  {r.owner_name ?? "—"}
                  {r.owner_role && <div className="muted">{ROLE_LABELS[r.owner_role as Role] ?? r.owner_role}</div>}
                </td>
                <td className="row-actions">
                  <Link className="btn btn-sm" href={`/requests/${r.application_id}`}>
                    Open <ArrowRight className="icon" aria-hidden="true" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="pagination" aria-label="Processed request pages">
        <span className="small muted">
          Page {q.page} of {q.pages}
        </span>
        {q.page > 1 && (
          <Link className="btn btn-sm" href={pageHref("/requests/processed", sp, q.page - 1)}>
            Previous
          </Link>
        )}
        {q.page < q.pages && (
          <Link className="btn btn-sm" href={pageHref("/requests/processed", sp, q.page + 1)}>
            Next
          </Link>
        )}
      </nav>
    </>
  );
}
