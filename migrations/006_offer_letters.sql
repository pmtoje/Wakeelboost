-- Murabaha offer letter lifecycle (automatic issue after Divisional Head approval).
-- Additive only: existing applications, documents and templates are untouched.

CREATE TABLE offer_letters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES applications(id),
  issue_no           int NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDING','ISSUED','FAILED','SUPERSEDED')),
  trigger            text NOT NULL CHECK (trigger IN ('DIVISIONAL_HEAD_APPROVAL','RETRY','REISSUE','BACKFILL')),
  requested_by       uuid REFERENCES staff(id),
  requested_at       timestamptz NOT NULL,
  template_id        uuid REFERENCES offer_templates(id),
  template_version   int,
  assessment_id      uuid,
  app_version_id     uuid REFERENCES application_versions(id),
  docx_document_id   uuid REFERENCES documents(id),
  pdf_document_id    uuid REFERENCES documents(id),
  issued_at          timestamptz,
  available_at       timestamptz,
  acceptance_status  text NOT NULL DEFAULT 'NOT_ISSUED'
                     CHECK (acceptance_status IN ('NOT_ISSUED','AWAITING_SIGNATURE','SIGNED','SUPERSEDED')),
  signed_document_id uuid REFERENCES documents(id),
  signed_at          timestamptz,
  attempts           int NOT NULL DEFAULT 0,
  last_error         text,
  next_attempt_at    timestamptz,
  superseded_at      timestamptz,
  superseded_reason  text,
  UNIQUE (application_id, issue_no)
);
-- At most one live letter per facility: repeated triggers can never create duplicate issued letters.
CREATE UNIQUE INDEX offer_letters_one_live ON offer_letters(application_id) WHERE status IN ('PENDING','FAILED','ISSUED');
CREATE INDEX offer_letters_due_idx ON offer_letters(next_attempt_at) WHERE status IN ('PENDING','FAILED');

-- Template administration: who published a version and the variables it was validated against.
ALTER TABLE offer_templates ADD COLUMN IF NOT EXISTS variables jsonb;
ALTER TABLE offer_templates ADD COLUMN IF NOT EXISTS validated_at timestamptz;

-- Backfill for facilities already past Divisional Head approval when this migration runs.
-- Letters generated before this release are recorded as issued (with their signed copy, if any);
-- facilities waiting at offer preparation without a letter are queued for automatic generation.
INSERT INTO offer_letters (application_id, issue_no, status, trigger, requested_by, requested_at, template_id, template_version,
                           app_version_id, docx_document_id, pdf_document_id, issued_at, available_at, acceptance_status,
                           signed_document_id, signed_at, attempts)
SELECT a.id, 1, 'ISSUED', 'BACKFILL', g.uploaded_by, g.uploaded_at, t.id, g.template_version, g.app_version_id, g.id, p.id,
       g.uploaded_at, g.uploaded_at,
       CASE WHEN s.id IS NULL THEN 'AWAITING_SIGNATURE' ELSE 'SIGNED' END, s.id, s.uploaded_at, 1
  FROM applications a
  JOIN documents g ON g.application_id = a.id AND g.category = 'GENERATED_OFFER' AND g.superseded_at IS NULL
  LEFT JOIN offer_templates t ON t.id = g.template_id
  LEFT JOIN documents p ON p.application_id = a.id AND p.category = 'GENERATED_OFFER_PDF' AND p.superseded_at IS NULL
  LEFT JOIN documents s ON s.application_id = a.id AND s.category = 'SIGNED_OFFER' AND s.superseded_at IS NULL
 WHERE NOT EXISTS (SELECT 1 FROM offer_letters o WHERE o.application_id = a.id);

INSERT INTO offer_letters (application_id, issue_no, status, trigger, requested_at, next_attempt_at)
SELECT a.id, 1, 'PENDING', 'BACKFILL', now(), now()
  FROM applications a
 WHERE a.stage = 'OFFER_PREPARATION'
   AND NOT EXISTS (SELECT 1 FROM offer_letters o WHERE o.application_id = a.id);
