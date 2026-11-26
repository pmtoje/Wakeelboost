-- National Identification Number (NIN) for the applicant (Individual, Enterprise proprietor).
-- Stored encrypted like the BVN; only the last four digits are kept in clear for display.
ALTER TABLE application_versions ADD COLUMN nin_enc text;
ALTER TABLE application_versions ADD COLUMN nin_last4 text;
-- Directors of a Limited company: NIN where applicable (optional), same protection as their BVN.
ALTER TABLE application_directors ADD COLUMN nin_enc text;
ALTER TABLE application_directors ADD COLUMN nin_last4 text;
