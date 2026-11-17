import { AlertTriangle, CheckCircle2, Clock, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import type { CreditCheckRow, CreditCheckStatus } from "@/server/domain/credit-check";
import { CREDIT_STATUS_LABEL, seedScoreBand } from "@/server/domain/credit-check";
import { formatLagos } from "@/server/time";
import { maskWithLast4 } from "@/server/mask";

const TONE: Record<CreditCheckStatus, string> = {
  NOT_REQUIRED: "",
  REQUIRED: "badge-yellow",
  IN_PROGRESS: "badge-blue",
  ACCEPTABLE: "badge-green",
  REVIEW_REQUIRED: "badge-warn",
  CLARIFICATION_REQUIRED: "badge-warn",
  CLEARED: "badge-green",
  UNAVAILABLE: "badge-red",
  DECLINED: "badge-red",
};

export function CreditStatusChip({ status }: { status: CreditCheckStatus }) {
  const Icon = status === "ACCEPTABLE" || status === "CLEARED" ? ShieldCheck : status === "DECLINED" ? XCircle : status === "UNAVAILABLE" ? AlertTriangle : status === "IN_PROGRESS" ? Clock : ShieldAlert;
  return (
    <span className={`badge ${TONE[status]}`}>
      <Icon className="icon" aria-hidden="true" />
      {CREDIT_STATUS_LABEL[status]}
    </span>
  );
}

/** Journey: New Request → Customer Identification → SeedFi Credit Check → Eligibility → Facility Application. */
export function CreditJourney({ status }: { status: CreditCheckStatus }) {
  const step = status === "REQUIRED" || status === "UNAVAILABLE" ? 1 : status === "IN_PROGRESS" ? 2 : ["REVIEW_REQUIRED", "CLARIFICATION_REQUIRED", "DECLINED"].includes(status) ? 3 : 4;
  const steps = ["Customer identification", "SeedFi credit check", "Eligibility decision", "Facility application"];
  return (
    <ol className="journey" aria-label="Request journey">
      {steps.map((s, i) => (
        <li key={s} className={i + 1 < step ? "done" : i + 1 === step ? "current" : ""} aria-current={i + 1 === step ? "step" : undefined}>
          <span className="journey-n">{i + 1 < step ? <CheckCircle2 className="icon" aria-hidden="true" /> : i + 1}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

const COMPONENT_LABELS: Record<string, string> = { payment_history: "Payment history", depth_of_credit: "Depth of credit", open_credit: "Open credit", demographics: "Demographics" };

/**
 * Credit check result. SeedFi-returned values and initiator-entered values are shown separately.
 * `detail` (Product Manager, credit officers on the case, Super Admin) adds the component scores
 * and SeedFi's narration.
 */
export function CreditCheckResult({ check, detail, narration }: { check: CreditCheckRow; detail: boolean; narration?: string | null }) {
  const failed = check.status === "FAILED";
  const overall = check.overall_score !== null ? Number(check.overall_score) : null;
  const reviewed = check.reviewed_score !== null ? Number(check.reviewed_score) : null;
  return (
    <div className="credit-result">
      <section className="credit-col" aria-labelledby={`cc-sf-${check.id}`}>
        <p className="eyebrow" id={`cc-sf-${check.id}`}>
          <ShieldCheck className="icon" aria-hidden="true" /> From SeedFi (verified provider data)
        </p>
        {failed ? (
          <p className="blocked" role="alert" style={{ margin: 0 }}>
            <AlertTriangle className="icon" aria-hidden="true" /> No result. {check.error_message} No credit decision was made.
          </p>
        ) : check.status === "IN_PROGRESS" ? (
          <p className="small muted" style={{ margin: 0 }}>Waiting for SeedFi…</p>
        ) : (
          <table className="kv">
            <tbody>
              <tr><th>Reviewed Seed Score</th><td className="tnum"><strong>{reviewed}</strong> <span className="muted">· {reviewed !== null ? seedScoreBand(reviewed) : ""}</span></td></tr>
              <tr><th>Overall Seed Score</th><td className="tnum">{overall} <span className="muted">· range 280 (highest risk) to 800</span></td></tr>
              <tr><th>Credit history</th><td>{check.has_credit_history ? "Yes" : "No credit history reported"}</td></tr>
              {check.validity_date && <tr><th>Score valid until</th><td>{String(check.validity_date).slice(0, 10)}</td></tr>}
              {check.provider_reference && <tr><th>SeedFi reference</th><td className="mono">{check.provider_reference}</td></tr>}
              {detail && check.components &&
                Object.entries(check.components).map(([k, v]) => (
                  <tr key={k}><th>{COMPONENT_LABELS[k] ?? k}</th><td className="tnum small">{Object.entries(v).map(([kk, vv]) => `${kk.endsWith("seedfi_score") ? "SeedFi" : "raw"} ${vv}`).join(" · ")}</td></tr>
                ))}
            </tbody>
          </table>
        )}
        {detail && narration && <p className="small" style={{ margin: "8px 0 0" }}><strong>SeedFi narration:</strong> {narration}</p>}
      </section>
      <section className="credit-col" aria-labelledby={`cc-rm-${check.id}`}>
        <p className="eyebrow" id={`cc-rm-${check.id}`}>Entered by the initiator</p>
        <table className="kv">
          <tbody>
            <tr><th>Customer</th><td>{check.first_name} {check.last_name}</td></tr>
            <tr><th>BVN</th><td className="mono">{maskWithLast4(check.bvn_last4)}</td></tr>
            <tr><th>Date of birth · gender</th><td>{String(check.date_of_birth instanceof Date ? check.date_of_birth.toISOString() : check.date_of_birth).slice(0, 10)} · {check.gender}</td></tr>
            <tr><th>Phone</th><td>{check.phone}</td></tr>
            <tr><th>Consent</th><td>{check.consent_method === "SIGNED_FORM" ? "Signed consent form" : "Witnessed in person"} · {formatLagos(check.consent_at)}</td></tr>
            <tr><th>Enquiry</th><td className="small">Attempt {check.attempt_no} · {formatLagos(check.requested_at)}{check.responded_at ? ` → ${formatLagos(check.responded_at)}` : ""} · {check.provider_environment}</td></tr>
          </tbody>
        </table>
      </section>
      {!failed && check.outcome && (
        <div className={`credit-outcome ${check.outcome === "ACCEPTABLE" ? "ok" : "adverse"}`}>
          {check.outcome === "ACCEPTABLE" ? <ShieldCheck className="icon" aria-hidden="true" /> : <ShieldAlert className="icon" aria-hidden="true" />}
          <span>
            <strong>{check.outcome === "ACCEPTABLE" ? "Acceptable under the bank's credit rules" : "Adverse findings: Product Manager review required"}</strong>
            {check.outcome_reasons && check.outcome_reasons.length > 0 && <span className="small"> · {check.outcome_reasons.join("; ")}</span>}
            <span className="small muted"> · rules v{check.settings_version}</span>
          </span>
        </div>
      )}
    </div>
  );
}
