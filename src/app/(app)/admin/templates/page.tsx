import { Download, Eye } from "lucide-react";
import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { KNOWN_DOCX_PLACEHOLDERS, PLACEHOLDER_SOURCES, REQUIRED_DOCX_PLACEHOLDERS } from "@/server/domain/offer-docx";
import { APPLICANT_TYPE_LABELS, type ApplicantType } from "@/server/domain/application-data";
import { formatLagos } from "@/server/time";
import { config } from "@/server/config";
import { PageHeader } from "@/components/PageHeader";
import { ActivateTemplateButton, ApproveTemplateButton, SignatoryForm, UploadTemplateForm } from "../AdminForms";
import { currentSecondSignatory, signatoryHistory } from "@/server/domain/signatory";

export const metadata = { title: "Offer templates" };

export default async function Templates() {
  await requireSuperAdmin();
  const rows = (
    await db.query(
      `SELECT t.*, s.full_name AS created_by_name, a.full_name AS activated_by_name, p.full_name AS approved_by_name FROM offer_templates t
         LEFT JOIN staff s ON s.id = t.created_by LEFT JOIN staff a ON a.id = t.activated_by LEFT JOIN staff p ON p.id = t.approved_by
        ORDER BY t.applicant_type NULLS LAST, t.status = 'ACTIVE' DESC, t.version DESC`,
    )
  ).rows;
  const types: ApplicantType[] = ["INDIVIDUAL", "ENTERPRISE", "LIMITED"];
  const sig = await currentSecondSignatory(db);
  const sigHistory = await signatoryHistory(db);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Offer templates"
        intro="WakeelBoost issues Murabaha (cost plus markup) offer letters only, one active template per applicant type. Letters are generated automatically when the Divisional Head approves a facility, from the active template approved by the Super Admin. Issued letters stay linked to the template version they were made from."
      />
      <div className="grid-3" style={{ marginBottom: 16 }}>
        {types.map((t) => {
          const a = rows.find((r) => r.status === "ACTIVE" && r.applicant_type === t);
          return (
            <div className="card" key={t} style={{ margin: 0 }}>
              <p className="eyebrow">{APPLICANT_TYPE_LABELS[t]}</p>
              {a ? (
                <>
                  <h2 style={{ marginBottom: 4 }}>{a.name} v{a.version}</h2>
                  {a.production_approved ? (
                    <span className="badge badge-green">Approved for production{a.approved_by_name ? ` · ${a.approved_by_name}` : ""}</span>
                  ) : (
                    <span className="badge badge-warn">Awaiting Super Admin approval{config.isProduction ? " · letters blocked" : ""}</span>
                  )}
                </>
              ) : (
                <span className="badge badge-red">No active template</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="data responsive">
          <thead><tr><th>Template</th><th>Type</th><th>Status</th><th>Approval</th><th>Variables</th><th>Created</th><th>Activated</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="Template">{r.name} <span className="muted">v{r.version} · {r.format}</span><div className="small muted">{r.source_filename ?? ""}{r.notes ? ` · ${r.notes}` : ""}</div></td>
                <td className="small" data-label="Type">{r.applicant_type ? APPLICANT_TYPE_LABELS[r.applicant_type as ApplicantType] : "All types"}</td>
                <td data-label="Status"><span className={`badge ${r.status === "ACTIVE" ? "badge-green" : ""}`}>{r.status}</span></td>
                <td className="small" data-label="Approval">{r.production_approved ? <>Approved{r.approved_at && <div className="muted">{r.approved_by_name ?? ""} {formatLagos(r.approved_at)}</div>}</> : <span className="badge badge-warn">Not approved</span>}</td>
                <td className="small" data-label="Variables">{variableSummary(r)}</td>
                <td className="small" data-label="Created">{formatLagos(r.created_at)}{r.created_by_name && <div className="muted">{r.created_by_name}</div>}</td>
                <td className="small" data-label="Activated">{r.activated_at ? formatLagos(r.activated_at) : "—"}{r.activated_by_name && <div className="muted">{r.activated_by_name}</div>}</td>
                <td className="row-actions">
                  <div className="row">
                    {r.format === "DOCX" && <a className="btn btn-sm" href={`/api/admin/templates/${r.id}/preview`} target="_blank" rel="noopener"><Eye className="icon" aria-hidden="true" />Preview sample</a>}
                    <a className="btn btn-sm btn-ghost" href={`/api/admin/templates/${r.id}`}><Download className="icon" aria-hidden="true" />Download</a>
                    {!r.production_approved && <ApproveTemplateButton templateId={r.id} />}
                    {r.status !== "ACTIVE" && r.production_approved && <ActivateTemplateButton templateId={r.id} rollback={!!r.activated_at} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Second signatory (Individual and Enterprise letters)</h2>
        <p className="small muted">
          Printed beside the business endorser above a blank signature line; letters are signed by hand. Corporate letters use the initiator and the business endorser.
          {!sig.name && <strong> No name is set yet: letters print the title only.</strong>}
        </p>
        <SignatoryForm current={{ name: sig.name, title: sig.title }} />
        {sigHistory.length > 0 && (
          <ul className="small muted" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
            {sigHistory.map((h) => (
              <li key={h.id}>v{h.version}: {h.name || "(no name)"}, {h.title} · {h.created_by_name ?? "system"} {formatLagos(h.created_at)} · {h.reason}</li>
            ))}
          </ul>
        )}
      </div>
      <details className="card" style={{ marginBottom: 16 }}>
        <summary><strong>Variable mapping</strong> <span className="small muted">· where each placeholder is filled from</span></summary>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead><tr><th>Placeholder</th><th>Populated from</th></tr></thead>
            <tbody>
              {[...KNOWN_DOCX_PLACEHOLDERS].map((k) => (
                <tr key={k}><td className="mono small">{`{{${k}}}`}</td><td className="small">{PLACEHOLDER_SOURCES[k] ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div className="card">
        <h2>Upload a new template version</h2>
        <p className="small muted">
          Edit the downloaded Word file and keep the placeholders exactly as written, e.g. <code>{"{{cost_price}}"}</code>. Required placeholders:{" "}
          {types.map((t) => (
            <span key={t}>
              <strong>{APPLICANT_TYPE_LABELS[t]}</strong>: {REQUIRED_DOCX_PLACEHOLDERS[t].map((x) => `{{${x}}}`).join(" ")}.{" "}
            </span>
          ))}
          The letter must be a Murabaha (cost plus markup) letter and must not describe an interest rate. A new version is saved as a draft: preview it, approve it, then activate it. Signature images are not allowed; letters are signed by hand.
        </p>
        <UploadTemplateForm />
      </div>
    </>
  );
}

function variableSummary(r: { variables: string[] | null; applicant_type: string | null; format: string }) {
  if (r.format !== "DOCX") return <span className="muted">HTML</span>;
  if (!r.variables) return <span className="muted">Not recorded</span>;
  const req = r.applicant_type ? REQUIRED_DOCX_PLACEHOLDERS[r.applicant_type as ApplicantType] : [];
  const missing = req.filter((x) => !r.variables!.includes(x));
  const unknown = r.variables.filter((x) => !KNOWN_DOCX_PLACEHOLDERS.has(x));
  if (missing.length || unknown.length) return <span className="badge badge-red">{missing.length} missing · {unknown.length} unknown</span>;
  return <span className="badge badge-green" title={r.variables.join(", ")}>{r.variables.filter((v) => !v.startsWith("/")).length} mapped</span>;
}
