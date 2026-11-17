-- Mandatory SeedFi credit check before facility origination, with Product Manager review of
-- adverse findings. Additive: applications created before this release are marked NOT_REQUIRED so
-- nothing in flight is reset or invalidated.

ALTER TABLE applications ADD COLUMN credit_check_status text NOT NULL DEFAULT 'NOT_REQUIRED'
  CHECK (credit_check_status IN ('NOT_REQUIRED','REQUIRED','IN_PROGRESS','ACCEPTABLE','REVIEW_REQUIRED',
                                 'CLARIFICATION_REQUIRED','CLEARED','UNAVAILABLE','DECLINED'));
ALTER TABLE applications ADD COLUMN credit_check_note text;
ALTER TABLE applications ADD COLUMN credit_check_id uuid;
ALTER TABLE applications ADD COLUMN product_manager_id uuid REFERENCES staff(id);
UPDATE applications SET credit_check_note = 'Created before the mandatory credit check' WHERE credit_check_note IS NULL;

-- Rules that classify a SeedFi result. Append-only and versioned like pricing settings.
CREATE TABLE credit_check_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version            int NOT NULL UNIQUE,
  min_acceptable_score int NOT NULL CHECK (min_acceptable_score BETWEEN 280 AND 800),
  score_basis        text NOT NULL CHECK (score_basis IN ('REVIEWED','OVERALL','LOWER_OF_BOTH')),
  require_credit_history boolean NOT NULL DEFAULT false,
  reason             text NOT NULL,
  created_by         uuid REFERENCES staff(id),
  created_at         timestamptz NOT NULL
);
-- Initial rule set: SeedFi's documented decision bands (620-800 approved, 530-619 manual review,
-- below 530 declined). Anything below the approved band is referred to the Product Manager.
INSERT INTO credit_check_settings (version, min_acceptable_score, score_basis, require_credit_history, reason, created_at)
VALUES (1, 620, 'LOWER_OF_BOTH', false, 'Initial rules from the SeedFi API documentation decision bands (v2.0, April 2026)', now());

CREATE TABLE credit_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id),
  attempt_no          int NOT NULL,
  provider            text NOT NULL DEFAULT 'SEEDFI',
  provider_environment text NOT NULL,
  status              text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  idempotency_key     text NOT NULL UNIQUE,
  -- Customer identification (entered by the initiator; BVN encrypted, never logged)
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  date_of_birth       date NOT NULL,
  gender              text NOT NULL CHECK (gender IN ('male','female')),
  phone               text NOT NULL,
  bvn_enc             text NOT NULL,
  bvn_last4           text NOT NULL,
  bvn_hash            text NOT NULL,
  provider_customer_id text NOT NULL,
  -- Consent captured before the enquiry
  consent_attested    boolean NOT NULL CHECK (consent_attested),
  consent_method      text NOT NULL,
  consent_at          timestamptz NOT NULL,
  requested_by        uuid NOT NULL REFERENCES staff(id),
  requested_at        timestamptz NOT NULL,
  responded_at        timestamptz,
  http_status         int,
  error_code          text,
  error_message       text,
  provider_reference  text,
  -- Provider data (verified): headline values plus the full response, encrypted
  overall_score       numeric,
  reviewed_score      numeric,
  has_credit_history  boolean,
  validity_date       date,
  components          jsonb,
  response_enc        text,
  -- Classification against the bank's rules at the time of the check
  outcome             text CHECK (outcome IN ('ACCEPTABLE','ADVERSE')),
  outcome_reasons     jsonb,
  settings_version    int,
  UNIQUE (application_id, attempt_no)
);
-- One enquiry in flight per application: duplicate clicks cannot trigger a second enquiry.
CREATE UNIQUE INDEX credit_checks_one_in_flight ON credit_checks(application_id) WHERE status = 'IN_PROGRESS';
CREATE INDEX credit_checks_bvn_idx ON credit_checks(bvn_hash, requested_at);
