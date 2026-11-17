-- Murabaha (sale) contract, signed after the bank has paid the vendor (post-disbursement).
ALTER TABLE offer_templates DROP CONSTRAINT offer_templates_doc_type_check;
ALTER TABLE offer_templates ADD CONSTRAINT offer_templates_doc_type_check
  CHECK (doc_type IN ('OFFER_LETTER','PRE_DISBURSEMENT','POST_DISBURSEMENT','GSI_FORM','INSURANCE_SIGNED'));
ALTER TABLE e_signatures DROP CONSTRAINT e_signatures_doc_type_check;
ALTER TABLE e_signatures ADD CONSTRAINT e_signatures_doc_type_check
  CHECK (doc_type IN ('OFFER_LETTER','PRE_DISBURSEMENT','POST_DISBURSEMENT','GSI_FORM','INSURANCE_SIGNED'));

-- One active template per document and applicant scope (previously per applicant scope only).
DROP INDEX offer_templates_one_active;
CREATE UNIQUE INDEX offer_templates_one_active ON offer_templates (doc_type, (coalesce(applicant_type, 'ALL'))) WHERE status = 'ACTIVE';
