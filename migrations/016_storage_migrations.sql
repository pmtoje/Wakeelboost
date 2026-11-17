-- Copying documents from one store to another (e.g. S3 or local files to SharePoint).
-- One row per object copied and verified; the copy can be stopped and re-run safely.
CREATE TABLE storage_migrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_kind   text NOT NULL CHECK (object_kind IN ('DOCUMENT','TEMPLATE')),
  object_id     uuid NOT NULL,
  source_driver text NOT NULL,
  target_driver text NOT NULL,
  from_key      text NOT NULL,
  to_key        text NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL,
  copied_at     timestamptz NOT NULL,
  UNIQUE (object_kind, object_id, target_driver)
);
