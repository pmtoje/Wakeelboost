-- Disbursement documents: prefilled bank forms (one template per document type) and signing on a tablet.

-- Templates are typed: the Murabaha offer letter, plus the bank's pre-disbursement agreement, GSI form
-- and customer insurance (Takaful) form once the bank supplies them.
ALTER TABLE offer_templates ADD COLUMN doc_type text NOT NULL DEFAULT 'OFFER_LETTER'
  CHECK (doc_type IN ('OFFER_LETTER','PRE_DISBURSEMENT','GSI_FORM','INSURANCE_SIGNED'));

-- Signatures captured on a tablet. The signed copy is the prepared document plus an electronic
-- signature page; the record ties it to the exact document (checksum) that was presented.
CREATE TABLE e_signatures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id),
  doc_type            text NOT NULL CHECK (doc_type IN ('OFFER_LETTER','PRE_DISBURSEMENT','GSI_FORM','INSURANCE_SIGNED')),
  source_document_id  uuid NOT NULL REFERENCES documents(id),
  source_sha256       text NOT NULL,
  signed_document_id  uuid NOT NULL REFERENCES documents(id),
  signers             jsonb NOT NULL,
  captured_by         uuid NOT NULL REFERENCES staff(id),
  captured_at         timestamptz NOT NULL,
  client_ip           text,
  user_agent          text
);
CREATE INDEX e_signatures_app_idx ON e_signatures(application_id, captured_at);
