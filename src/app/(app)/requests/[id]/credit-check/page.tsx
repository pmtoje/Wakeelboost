import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { requireUser } from "../../../../_lib/auth";
import { db } from "@/server/db";
import { config } from "@/server/config";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { APPLICANT_TYPE_LABELS } from "@/server/domain/application-data";
import { canSeeCreditDetail, creditCheckHistory, creditResponseDetail, ORIGINATION_ALLOWED, type CreditCheckStatus } from "@/server/domain/credit-check";
import { PageHeader } from "@/components/PageHeader";
import { CreditCheckResult, CreditJourney, CreditStatusChip } from "@/components/CreditCheck";
import { CreditCheckForm } from "./CreditCheckForm";

export const metadata = { title: "Credit check" };

export default async function CreditCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, session } = await requireUser();
  const { id } = await params;
  let c;
  try {
    c = await getCase(ctx, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const app = c.app;
  if (app.initiator_id !== session.staffId) redirect(`/requests/${id}`);
  const status = app.credit_check_status as CreditCheckStatus;
  if (status === "NOT_REQUIRED") redirect(`/requests/${id}`);
  const history = await creditCheckHistory(db, id);
  const latest = history[0] ?? null;
  const detail = await canSeeCreditDetail(db, session.staffId, id);
  const report = c.documents.find((d) => d.category === "SEEDFI_CREDIT_REPORT" && !d.superseded_at);
  const canRun = app.stage === "DRAFT" && (status === "REQUIRED" || status === "UNAVAILABLE");
  const typeLabel = APPLICANT_TYPE_LABELS[app.applicant_type as keyof typeof APPLICANT_TYPE_LABELS];
  return (
    <>
      <PageHeader
        eyebrow={`New financing request · ${app.ref} · ${typeLabel}`}
        title="Customer identification and credit check"
        intro="Every WakeelBoost request starts with a SeedFi credit check. The facility application opens once the result is acceptable, or once the Product Manager clears adverse findings."
      />
      <CreditJourney status={status} />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>Status</p>
            <CreditStatusChip status={status} />
          </div>
          {ORIGINATION_ALLOWED.includes(status) && app.stage === "DRAFT" && (
            <Link className="btn btn-primary" href={`/requests/${id}/edit`}>
              Continue to facility application <ArrowRight className="icon" aria-hidden="true" />
            </Link>
          )}
          {["REVIEW_REQUIRED", "CLARIFICATION_REQUIRED", "DECLINED"].includes(status) && (
            <Link className="btn" href={`/requests/${id}`}>
              {status === "CLARIFICATION_REQUIRED" ? "Respond to the Product Manager" : "Open the request"} <ArrowRight className="icon" aria-hidden="true" />
            </Link>
          )}
        </div>
        <p className="small" style={{ margin: "10px 0 0" }}>
          {status === "REQUIRED" && "Next: identify the customer, record their consent and run the SeedFi check."}
          {status === "UNAVAILABLE" && "The last enquiry did not return a result. No credit decision was made. Check the details and try again; if it keeps failing, contact the administrator."}
          {status === "ACCEPTABLE" && "Next: complete the stock-financing and supplier details and upload the documents."}
          {status === "CLEARED" && "The Product Manager cleared the request to proceed. Next: complete the facility application. This is not credit approval."}
          {status === "REVIEW_REQUIRED" && "SeedFi returned adverse findings. The Product Manager is reviewing them; you will be notified of the decision."}
          {status === "CLARIFICATION_REQUIRED" && "The Product Manager asked for clarification. Respond from the request page."}
          {status === "DECLINED" && "The Product Manager declined the request. It is closed."}
        </p>
      </div>
      {canRun && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Customer identification</h2>
          {!config.seedfi.configured && (
            <p className="blocked" role="alert">SeedFi is not configured on this server (SEEDFI_BASE_URL and SEEDFI_API_KEY), so the enquiry will report the credit check as unavailable. Ask the administrator to configure it.</p>
          )}
          <CreditCheckForm
            applicationId={id}
            applicantType={app.applicant_type}
            prefill={{
              firstName: latest?.first_name ?? "",
              lastName: latest?.last_name ?? "",
              dateOfBirth: latest ? String(latest.date_of_birth instanceof Date ? latest.date_of_birth.toISOString() : latest.date_of_birth).slice(0, 10) : "",
              gender: latest?.gender ?? "",
              phone: latest?.phone ?? "",
            }}
          />
        </div>
      )}
      {latest && (
        <div className="card">
          <h2>{latest.status === "FAILED" ? "Last enquiry" : "Credit check result"}</h2>
          <CreditCheckResult check={latest} detail={detail} narration={detail ? creditResponseDetail(latest).narration : null} />
          {report && detail && (
            <p className="small" style={{ margin: "12px 0 0" }}>
              <Link href={`/requests/${id}?tab=documents&doc=${report.id}`}>View the SeedFi credit check report (PDF)</Link> · generated automatically and filed with the facility
            </p>
          )}
          {history.length > 1 && <p className="small muted" style={{ marginTop: 12 }}>{history.length} enquiries recorded for this request; earlier ones are kept in the audit trail.</p>}
        </div>
      )}
    </>
  );
}
