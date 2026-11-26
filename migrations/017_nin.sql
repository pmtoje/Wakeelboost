-- National Identification Number (NIN) for the applicant (Individual, Enterprise proprietor).
-- Stored encrypted like the BVN; only the last four digits are kept in clear for display.
ALTER TABLE application_versions ADD COLUMN nin_enc text;
ALTER TABLE application_versions ADD COLUMN nin_last4 text;
