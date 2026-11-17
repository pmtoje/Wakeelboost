-- "Proceed with Reason": after an adverse SeedFi result the initiator may continue origination with a
-- written reason while the Product Manager's review stays open. The Product Manager can still decline
-- before business endorsement; a request submitted before the decision waits for it.
ALTER TABLE applications ADD COLUMN rm_proceeded_at timestamptz;
ALTER TABLE applications ADD COLUMN rm_proceeded_by uuid REFERENCES staff(id);
ALTER TABLE applications ADD COLUMN rm_proceed_reason text;
ALTER TABLE applications ADD COLUMN pm_hold_submitted_at timestamptz;
