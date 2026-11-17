-- God's Eye: optional processing targets per stage (hours), set by the Super Admin.
-- No defaults: the bank's service levels are not defined in the system until configured.
CREATE TABLE stage_targets (
  stage        text PRIMARY KEY,
  target_hours int NOT NULL CHECK (target_hours BETWEEN 1 AND 2160),
  updated_by   uuid REFERENCES staff(id),
  updated_at   timestamptz NOT NULL
);
CREATE INDEX tasks_open_entered_idx ON tasks(entered_at) WHERE status = 'OPEN';
CREATE INDEX decisions_actor_time_idx ON decisions(actor_id, created_at);
CREATE INDEX disbursements_recorded_idx ON disbursements(recorded_at);
