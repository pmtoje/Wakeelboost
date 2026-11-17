import { requireSuperAdmin } from "../guard";
import { db } from "@/server/db";
import { config } from "@/server/config";
import { creditSettings } from "@/server/domain/credit-check";
import { formatLagos } from "@/server/time";
import { PageHeader } from "@/components/PageHeader";
import { CreditRulesForm } from "../AdminForms";

export const metadata = { title: "Credit check (SeedFi)" };

export default async function CreditCheckAdmin() {
  await requireSuperAdmin();
  const s = config.seedfi;
  const rules = await creditSettings(db);
  const history = (await db.query("SELECT c.*, st.full_name FROM credit_check_settings c LEFT JOIN staff st ON st.id = c.created_by ORDER BY version DESC")).rows;
  const stats = (
    await db.query<{ status: string; outcome: string | null; error_code: string | null; n: string; last: Date }>(
      "SELECT status, outcome, error_code, count(*) AS n, max(requested_at) AS last FROM credit_checks WHERE requested_at > now() - interval '30 days' GROUP BY 1,2,3 ORDER BY 4 DESC",
    )
  ).rows;
  const lastOk = (await db.query<{ t: Date | null }>("SELECT max(responded_at) AS t FROM credit_checks WHERE status = 'COMPLETED'")).rows[0].t;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Credit check (SeedFi)"
        intro="Every new request starts with a SeedFi Seed Score check. Results below the acceptable minimum go to the Product Manager. Technical failures are never treated as credit decisions."
      />
      <div className="metric-grid" style={{ marginBottom: 16 }}>
        <div className="metric">
          <div className="k">SeedFi connection</div>
          <div className="v">{s.configured ? "Configured" : "Not configured"}</div>
          <span className={`badge ${s.configured ? "badge-green" : "badge-red"}`}>{s.configured ? `${s.environment} · ${new URL(s.baseUrl).host}` : "Credit checks report unavailable"}</span>
        </div>
        <div className="metric"><div className="k">Last successful response</div><div className="v" style={{ fontSize: 16 }}>{lastOk ? formatLagos(lastOk) : "None yet"}</div></div>
        <div className="metric"><div className="k">Acceptable minimum · basis</div><div className="v">{rules.minAcceptableScore}</div><span className="small muted">{rules.scoreBasis === "LOWER_OF_BOTH" ? "Lower of overall and reviewed score" : rules.scoreBasis === "OVERALL" ? "Overall score" : "Reviewed score"}</span></div>
        <div className="metric"><div className="k">Credit history required</div><div className="v">{rules.requireCreditHistory ? "Yes" : "No"}</div><span className="small muted">rules v{rules.version}</span></div>
      </div>
      {s.configured && config.isProduction && s.environment !== "production" && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
          <span>This production server points at SeedFi <strong>staging</strong>, which returns test personas only. Credit checks are refused until <code>SEEDFI_BASE_URL</code> is set to <code>https://loanengine.theseedfi.com</code> with the live API key.</span>
        </div>
      )}
      {!s.configured && (
        <div className="alert alert-warn" style={{ marginBottom: 16 }}>
          <span>
            Set <code>SEEDFI_BASE_URL</code> (staging <code>https://stg-loan-engine.theseedfi.com</code>, production <code>https://loanengine.theseedfi.com</code> after SeedFi&apos;s go-live sign-off) and <code>SEEDFI_API_KEY</code> in the server&apos;s secret store. The key is never shown here, sent to browsers or logged. Until then, new requests show “Credit check unavailable” and cannot proceed.
          </span>
        </div>
      )}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Enquiries in the last 30 days</h2>
        {stats.length === 0 ? (
          <p className="small muted">No enquiries yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Result</th><th>Count</th><th>Latest</th></tr></thead>
              <tbody>
                {stats.map((r, i) => (
                  <tr key={i}>
                    <td>{r.status === "COMPLETED" ? (r.outcome === "ACCEPTABLE" ? "Acceptable" : "Adverse (Product Manager)") : r.status === "FAILED" ? `Unavailable · ${r.error_code}` : "In progress"}</td>
                    <td className="tnum">{r.n}</td>
                    <td className="small">{formatLagos(r.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Credit rules</h2>
        <p className="small muted">
          The initial rules follow SeedFi&apos;s documented decision bands (620–800 approved, 530–619 manual review, below 530 declined): anything below the approved band is referred to the Product Manager. Replace them with the bank&apos;s approved credit rules here. Changes apply to new checks only and are audited.
        </p>
        <CreditRulesForm current={rules} />
      </div>
      <div className="card">
        <h2>History</h2>
        <div className="table-wrap">
          <table className="data responsive">
            <thead><tr><th>Version</th><th>Minimum</th><th>Basis</th><th>History required</th><th>Changed</th><th>Reason</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td data-label="Version">v{h.version}</td>
                  <td data-label="Minimum" className="tnum">{h.min_acceptable_score}</td>
                  <td data-label="Basis" className="small">{h.score_basis}</td>
                  <td data-label="History required">{h.require_credit_history ? "Yes" : "No"}</td>
                  <td data-label="Changed" className="small">{formatLagos(h.created_at)}{h.full_name ? ` · ${h.full_name}` : ""}</td>
                  <td data-label="Reason" className="small">{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
