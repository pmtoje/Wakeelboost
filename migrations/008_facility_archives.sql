-- Customer-specific facility document repository and consolidated ZIP archive.
-- One repository per facility reference; the ZIP is generated automatically on completion.

CREATE TABLE facility_archives (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL UNIQUE REFERENCES applications(id),
  status           text NOT NULL CHECK (status IN ('IN_PROGRESS','QUEUED','COMPLETE','FAILED')),
  opened_at        timestamptz NOT NULL,
  queued_at        timestamptz,
  generated_at     timestamptz,
  generation_no    int NOT NULL DEFAULT 0,
  document_id      uuid REFERENCES documents(id),
  filename         text,
  size_bytes       bigint,
  sha256           text,
  file_count       int,
  manifest         jsonb,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  next_attempt_at  timestamptz
);
CREATE INDEX facility_archives_due_idx ON facility_archives(next_attempt_at) WHERE status IN ('QUEUED','FAILED');

-- Every existing facility gets its repository now; closed facilities are queued for their ZIP.
INSERT INTO facility_archives (application_id, status, opened_at, queued_at, next_attempt_at)
SELECT a.id,
       CASE WHEN a.status = 'CLOSED' THEN 'QUEUED' ELSE 'IN_PROGRESS' END,
       a.created_at,
       CASE WHEN a.status = 'CLOSED' THEN now() END,
       CASE WHEN a.status = 'CLOSED' THEN now() END
  FROM applications a
 WHERE NOT EXISTS (SELECT 1 FROM facility_archives f WHERE f.application_id = a.id);
