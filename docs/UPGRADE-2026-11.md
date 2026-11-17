# WakeelBoost upgrade (November 2026)

Six enhancements built into the existing Work Desk. Migrations 006–009 only add tables, columns and
indexes; no existing record is changed except where noted below.

| # | Enhancement | Where |
|---|---|---|
| 1 | Official The Alternative Bank logo on sign-in, sidebar, mobile header and God's Eye; the bank's Murabaha letters already carry it; the facility record workbook includes it | `public/brand/`, `src/components/Brand.tsx` |
| 2 | Mandatory SeedFi credit check first, Product Manager review of adverse findings | `src/server/integrations/seedfi.ts`, `src/server/domain/credit-check.ts`, `/requests/[id]/credit-check`, migration 007 |
| 3 | Customer-specific facility repository and ZIP archive | `src/server/domain/archive.ts`, migration 008 |
| 4 | Murabaha-only offer letters generated automatically after Divisional Head approval; template administration | `src/server/domain/offer-letters.ts`, `/admin/templates`, migration 006 |
| 5 | God's Eye management oversight (Super Admin, Divisional Head, Unit Head) | `src/server/domain/metrics.ts`, `oversight.ts`, `/oversight`, migration 009 |
| 6 | Personal month-to-date dashboards on every queue | `src/components/MyPerformance.tsx` |

## SeedFi credit check report

When a credit check completes (acceptable or adverse), a PDF report is generated automatically from the
SeedFi response (scores, bands, credit history, component scores, narration when SeedFi sends it) and
the recorded customer details and consent, with the bank's classification shown separately. It is
filed with the facility (and in the archive under `04-SeedFi-credit-check`) and opens only for the
initiator, the Product Manager, credit officers and approvers on the case and the Super Admin. No
report is produced for a failed enquiry.

## Journey

New request → customer identification and consent → SeedFi Seed Score → eligibility:

- **Acceptable** (score at or above the minimum): the facility application opens.
- **Adverse** (e.g. a poor Seed Score): the request goes to the Product Manager's Credit Review
  Queue. The Product Manager clears it, requests clarification from the initiator, or declines it,
  always with a reason. Clearance permits origination only; the facility still passes every credit
  approval.
- **Proceed with Reason**: after an adverse result the initiator may continue the facility
  application immediately by recording a reason (at least 10 characters). The Product Manager is
  notified and the review stays open: the Product Manager can still decline before business
  endorsement. If the initiator submits first, the request waits and goes to business endorsement
  automatically when the Product Manager clears it. The reason is shown on the facility record, in
  God's Eye and in the archive.
- **Technical failure** (timeout, outage, credentials, unexpected response): "Credit check
  unavailable". No credit decision is recorded and the initiator can retry.

The facility application, document uploads (other than the consent form) and submission stay locked
until the credit check clears. The submitted application must carry the credit-checked BVN.
Then: business endorsement → credit reviews → Unit Head → Divisional Head → **Murabaha offer letter
generated automatically** → initiator shares it and uploads the signed copy → pack review →
disbursement → completion → vendor confirmation → **facility ZIP archive generated automatically**.

## Credit rules (Super Admin → Credit check (SeedFi))

Initial rules follow SeedFi's documented decision bands: Seed Score 620–800 approved, 530–619 manual
review, below 530 declined. The lower of the overall and reviewed score is compared with 620; anything
below goes to the Product Manager. **Replace these with the bank's approved credit rules** on the same
page (versioned, audited, prospective). The routing diagram referenced in the brief (section 3.3) was
not received.

## Existing data

- Applications created before this release: `credit_check_status = NOT_REQUIRED` with the note
  "Created before the mandatory credit check". Nothing in flight is reset.
- Facilities already holding a generated offer: recorded as issued letters (and signed, if a signed
  copy exists). Facilities waiting at offer preparation without one: queued for automatic generation.
- Every facility gets a document repository; closed facilities are queued for their archive.

## Before production

1. **SeedFi (live)**: set `SEEDFI_BASE_URL=https://loanengine.theseedfi.com` and the live
   `SEEDFI_API_KEY` in the secret store. Production refuses SeedFi staging (test personas only).
   Per SeedFi's documentation (v2.0, §1.3, §2.5) the live environment needs SeedFi's go-live
   sign-off, and an API key is created by an authenticated account through
   `POST /auth/api/v1/keys/create` and shown **once** at creation; the document does not describe
   keys being emailed. Ask SeedFi to confirm go-live and the procedure for the bank's live account.
   The live connection has **not** been verified in this build (no key was available); all tests
   use a stand-in that answers in SeedFi's documented format.
2. **Credit rules**: enter the bank's approved rules.
3. **Product Manager**: grant the role (Users & roles) to the responsible staff.
4. **Offer templates**: Super Admin → Offer templates → Preview sample → Approve each of the three
   Murabaha templates. Production refuses to issue letters from an unapproved template.
5. **LibreOffice** on the application and worker hosts (PDF letters). Production refuses to issue a
   letter without its PDF.
6. **Worker**: at least one `npm run worker` (retries letters and archives, sends email).
7. **Storage**: confirm the S3 bucket and KMS key permissions; archives are stored there encrypted.
8. **Processing targets** (optional): Super Admin sets per-stage targets in God's Eye.
9. Run `npm run migrate`, then deploy.

## Rollback

Migrations are additive and the defaults keep older code working (new columns have defaults; new
tables are ignored). To roll back, redeploy the previous build; leave the database as it is.
Re-deploying this build afterwards resumes from the stored state.

## Not available in this build

- **Recognised income** needs core-banking data; God's Eye shows contracted markup only, labelled.
- **Customer self-service acceptance / e-signature**: the initiator shares the issued letter and
  uploads the signed copy (the existing channel); acceptance status is recorded from that upload.
- **SharePoint**: no enterprise document integration exists; archives use the existing encrypted
  object storage abstraction.
- **Organisational scoping for God's Eye**: there is no team hierarchy in the data, so the three
  oversight roles see all WakeelBoost facilities (identifiers masked; document contents only through
  normal case access).
