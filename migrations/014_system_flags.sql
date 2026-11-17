-- One-way switches recorded by the system. SEEDFI_ACTIVATED is set the first time a production server
-- starts with a working live SeedFi configuration; from then on the credit check is mandatory and fails
-- closed (requests wait and Super Admins are alerted) if SeedFi later becomes unavailable.
CREATE TABLE system_flags (
  key      text PRIMARY KEY,
  set_at   timestamptz NOT NULL,
  details  jsonb NOT NULL DEFAULT '{}'::jsonb
);
