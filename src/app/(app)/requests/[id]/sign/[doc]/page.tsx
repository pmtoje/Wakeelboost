import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Download, Eye } from "lucide-react";
import { requireUser } from "../../../../../_lib/auth";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/domain/views";
import { signDocumentLink } from "@/server/domain/documents";
import { liveOfferLetter } from "@/server/domain/offer-letters";
import { DOC_LABEL, DOC_SLUGS, FORMS, requiredSigners, signStageOf } from "@/server/domain/disbursement-docs";
import { PageHeader } from "@/components/PageHeader";
import { SignForm, type SignerSlot } from "./SignForm";

export const metadata = { title: "Sign on tablet" };

const TITLE = { CUSTOMER: "Customer", WITNESS: "Witness", SIGNATORY_1: "Authorised signatory 1", SIGNATORY_2: "Authorised signatory 2" } as const;

export default async function SignPage({ params }: { params: Promise<{ id: string; doc: string }> }) {
  const { ctx, session } = await requireUser();
  const { id, doc } = await params;
  const docType = DOC_SLUGS[doc];
  if (!docType) notFound();
  let c;
  try {
    c = await getCase(ctx, id);
  } catch (e) {
    if (e instanceof DomainError) notFound();
    throw e;
  }
  const app = c.app;
  const task = (c.tasks as { status: string; stage: string; assignee_id: string }[]).find((t) => t.status === "OPEN");
  if (!task || task.stage !== signStageOf(docType) || task.assignee_id !== session.staffId) redirect(`/requests/${id}`);

  // The prepared document the customer reads and signs
  let pdfId: string | null = null;
  let wordId: string | null = null;
  if (docType === "OFFER_LETTER") {
    const letter = await liveOfferLetter(db, id);
    if (letter?.status === "ISSUED") {
      pdfId = letter.pdf_document_id;
      wordId = letter.docx_document_id;
    }
  } else {
    const f = FORMS.find((x) => x.docType === docType)!;
    const live = c.documents.filter((d) => !d.superseded_at);
    wordId = live.find((d) => d.category === f.prefillCategory)?.id ?? null;
    pdfId = live.find((d) => d.category === f.prefillPdfCategory)?.id ?? null;
  }
  const label = DOC_LABEL[docType];
  const back = <Link className="btn" href={`/requests/${id}`}>Back to the request</Link>;
  if (!wordId) {
    return (
      <>
        <PageHeader eyebrow={`${app.ref} · ${app.customer_name}`} title={`Sign the ${label.toLowerCase().replace("murabaha", "Murabaha")}`} />
        <div className="card stack">
          <p style={{ margin: 0 }}>There is no prepared {label.toLowerCase().replace("murabaha", "Murabaha")} to sign yet. {docType === "OFFER_LETTER" ? "The offer letter is issued automatically after Divisional Head approval." : docType === "POST_DISBURSEMENT" ? "The sale contract is prepared once Credit Officer 3 has completed the process and the request is back with the initiator for sale completion." : "Prepare the forms from the request, or upload the bank's signed form."}</p>
          <div>{back}</div>
        </div>
      </>
    );
  }

  const rules = requiredSigners(docType, app.applicant_type);
  const directors = (c.directors ?? []) as { full_name: string }[];
  const slots: SignerSlot[] = [...rules.required.map((r) => [r, true] as const), ...rules.optional.map((r) => [r, false] as const)].map(([role, required]) => ({
    role,
    title: TITLE[role],
    required,
    defaultName: role === "CUSTOMER" ? app.customer_name : role === "SIGNATORY_1" ? (directors[0]?.full_name ?? "") : role === "SIGNATORY_2" ? (directors[1]?.full_name ?? "") : "",
    fields: role.startsWith("SIGNATORY") ? ["designation"] : role === "WITNESS" && docType === "OFFER_LETTER" ? ["address", "occupation"] : [],
  }));
  const view = pdfId ? signDocumentLink(pdfId, session.staffId, session.sessionId, "view") : null;
  return (
    <>
      <PageHeader
        eyebrow={`${app.ref} · ${app.customer_name}`}
        title={`Sign the ${label.toLowerCase().replace("murabaha", "Murabaha")} on this tablet`}
        intro="Hand the tablet to the customer to read the document, then capture each signature below. The signed copy (the document plus an electronic signature page) is filed with the request automatically. You can still download, sign on paper and upload instead."
      />
      <div className="card stack" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {view && (
            <a className="btn btn-sm" href={view} target="_blank" rel="noopener">
              <Eye className="icon" aria-hidden="true" /> Open full screen
            </a>
          )}
          {pdfId && (
            <a className="btn btn-sm" href={signDocumentLink(pdfId, session.staffId, session.sessionId, "download")}>
              <Download className="icon" aria-hidden="true" /> Download PDF
            </a>
          )}
          <a className="btn btn-sm" href={signDocumentLink(wordId, session.staffId, session.sessionId, "download")}>
            <Download className="icon" aria-hidden="true" /> Download Word
          </a>
          {back}
        </div>
        {view ? <iframe title={label} src={view} className="sign-preview" /> : <p className="small muted" style={{ margin: 0 }}>A PDF preview is not available on this server; download the Word copy to read it.</p>}
      </div>
      <div className="card">
        <SignForm applicationId={id} doc={doc} label={label} slots={slots} />
      </div>
    </>
  );
}
