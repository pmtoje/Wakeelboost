-- The bank's three Murabaha offer letters (Individual / Enterprise / Corporate, 9-1-24) are approved for
-- live use on the bank's instruction (17 Nov 2026: no separate Legal / Shariah sign-off; Super Admin
-- approval). Only the original seeded bank templates are approved here; any later upload still needs
-- the Super Admin's one-click approval.
WITH approved AS (
  UPDATE offer_templates
     SET production_approved = true, approved_at = now(),
         notes = coalesce(notes, '') || ' Approved for live use on the bank''s instruction (17 Nov 2026).'
   WHERE format = 'DOCX' AND NOT production_approved
     AND source_filename IN ('Murabaha-Individual-Offer-9-1-24.docx', 'Murabaha-Enterprise-Offer-9-1-24.docx', 'Murabaha-Corporate-Offer-9-1-24.docx')
  RETURNING id, name, version, applicant_type
)
INSERT INTO audit_events (occurred_at, action, outcome, reason, details)
SELECT now(), 'TEMPLATE_APPROVED', 'SUCCESS', 'Bank instruction: approved for live use without separate Legal/Shariah sign-off',
       jsonb_build_object('templateId', id, 'name', name, 'version', version, 'applicantType', applicant_type, 'approvedBy', 'bank instruction (migration 011)')
  FROM approved;
