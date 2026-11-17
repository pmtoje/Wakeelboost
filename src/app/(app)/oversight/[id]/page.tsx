import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CheckCircle2, Circle, CircleDot, MinusCircle, XCircle } from "lucide-react";
import { requireUser } from "../../../_lib/auth";
import { DomainError } from "@/server/errors";
import { formatKobo } from "@/server/money";
import { formatDuration, formatLagos } from "@/server/time";
import { facilityLifecycle, type LifecycleStep } from "@/server/domain/oversight";
import { STAGE_LABELS, type Stage } from "@/server/domain/stages";
import { ROLE_LABELS, type Role } from "@/server/domain/roles";
import { CATEGORY_LABEL } from "@/server/domain/documents";
import { PageHeader } from "@/components/PageHeader";
import { StageChip } from "@/components/Status";
import { CreditStatusChip } from "@/components/CreditCheck";

export const metadata = { title: "Facility lifecycle" };

const ICON: Record<LifecycleStep["state"], typeof Circle> = { done: CheckCircle2, current: CircleDot, pending: Circle, skipped: MinusCircle, failed: XCircle };

export default async function FacilityLifecycle({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let f;
  try {
    f = await facilityLifecycle(ctx, id);
  } catch (e) {
    if (e instanceof DomainError && e.code === "FORBIDDEN") redirect("/forbidden");
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const app = f.app;
  return (
    <>
      <PageHeader
        crumbs={[{ href: "/oversight", label: "God's Eye" }, { label: app.ref }]}
        eyebrow="Facility lifecycle · read only"
        title={`${app.ref} · ${app.customer_name ?? "Unnamed"}`}
        actions={f.canOpenDocuments ? <Link className="btn" href={`/requests/${app.id}`}>Open facility record</Link> : undefined}
      />
      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <StageChip stage={app.stage as Stage} status={app.status} />
        <CreditStatusChip status={app.credit_check_status} />
        {app.route && <span className="badge badge-blue">Route {app.route}</span>}
      </div>
      <div className="split">
        <section style={{ minWidth: 0 }} className="stack">
          <div className="card" style={{ margin: 0 }}>
            <h2>Lifecycle</h2>
            <ol className="lifecycle">
              {f.steps.map((s) => {
                const I = ICON[s.state];
                return (
                  <li key={s.key} className={`lc-${s.state}`}>
                    <I className="icon" aria-hidden="true" />
                    <div>
                      <strong>{s.label}</strong> <span className="small muted">· {s.state === "done" ? "complete" : s.state}{s.at ? ` · ${formatLagos(s.at)}` : ""}</span>
                      {s.detail && <div className="small">{s.detail}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <h2>Decisions</h2>
            {f.decisions.length === 0 ? <p className="small muted">No decisions yet.</p> : (
              <div className="table-wrap">
                <table className="data responsive">
                  <thead><tr><th>When</th><th>Stage</th><th>Decision</th><th>By</th><th>Reason</th></tr></thead>
                  <tbody>
                    {f.decisions.map((d) => (
                      <tr key={d.id} className={d.invalidated_at ? "muted" : ""}>
                        <td data-label="When" className="small">{formatLagos(d.created_at)}</td>
                        <td data-label="Stage" className="small">{STAGE_LABELS[d.stage as Stage] ?? d.stage}</td>
                        <td data-label="Decision">{d.action.replace(/_/g, " ").toLowerCase()}{d.invalidated_at && <span className="badge">invalidated</span>}</td>
                        <td data-label="By" className="small">{d.full_name}<div className="muted">{ROLE_LABELS[d.actor_role as Role] ?? d.actor_role}</div></td>
                        <td data-label="Reason" className="small">{d.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card" style={{ margin: 0 }}>
            <h2>Queue history</h2>
            <div className="table-wrap">
              <table className="data responsive">
                <thead><tr><th>Stage</th><th>Held by</th><th>Entered</th><th>Time in queue</th><th>Outcome</th></tr></thead>
                <tbody>
                  {f.tasks.map((t) => (
                    <tr key={t.id}>
                      <td data-label="Stage" className="small">{STAGE_LABELS[t.stage as Stage] ?? t.stage}</td>
                      <td data-label="Held by" className="small">{t.full_name ?? "Unassigned"}<div className="muted">{ROLE_LABELS[t.assignee_role as Role] ?? t.assignee_role}</div></td>
                      <td data-label="Entered" className="small">{formatLagos(t.entered_at)}</td>
                      <td data-label="Time in queue">{formatDuration(((t.completed_at ? new Date(t.completed_at) : new Date()).getTime() - new Date(t.entered_at).getTime()))}{t.status === "OPEN" && <span className="badge badge-yellow">open</span>}</td>
                      <td data-label="Outcome" className="small">{t.outcome?.replace(/_/g, " ").toLowerCase() ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
        <aside className="stack" style={{ minWidth: 0 }}>
          <div className="card" style={{ margin: 0 }}>
            <h2>Facility</h2>
            <table className="kv">
              <tbody>
                <tr><th>Customer</th><td>{app.customer_name ?? "—"}</td></tr>
                <tr><th>BVN</th><td className="mono">{f.bvn}</td></tr>
                <tr><th>Applicant type</th><td>{app.applicant_type}</td></tr>
                <tr><th>Requested</th><td className="tnum">{app.requested_amount_kobo ? formatKobo(Number(app.requested_amount_kobo)) : "—"}</td></tr>
                <tr><th>Goods</th><td className="small">{f.goods || "—"}</td></tr>
                <tr><th>Supplier</th><td>{f.supplier || "—"}</td></tr>
                <tr><th>Relationship Manager</th><td>{f.initiator} <span className="small muted">({app.initiator_role})</span></td></tr>
                {f.productManager && <tr><th>Product Manager</th><td>{f.productManager}</td></tr>}
                <tr><th>Location</th><td>{app.region ?? "—"}</td></tr>
                <tr><th>Created</th><td className="small">{formatLagos(app.created_at)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <h2>Documents</h2>
            <p className="small muted" style={{ marginTop: 0 }}>{f.canOpenDocuments ? "Open them from the facility record." : "Listed for oversight; contents open only to people working on the facility."}</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {f.documents.filter((d) => !d.superseded_at).map((d) => (
                <li key={d.id}>{CATEGORY_LABEL[d.category] ?? d.category} · v{d.version_no} · {formatLagos(d.uploaded_at)}{d.scan_status !== "CLEAN" ? ` · ${d.scan_status.toLowerCase()}` : ""}</li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
