-- Retention purge clears personal data, not only document files (security review M12).
-- Columns that hold identifiers may be emptied once a request is past its retention date.
ALTER TABLE credit_checks ALTER COLUMN date_of_birth DROP NOT NULL;
ALTER TABLE credit_checks ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE credit_checks ALTER COLUMN bvn_enc DROP NOT NULL;
ALTER TABLE application_directors ALTER COLUMN bvn_enc DROP NOT NULL;
ALTER TABLE applications ADD COLUMN pii_purged_at timestamptz;
