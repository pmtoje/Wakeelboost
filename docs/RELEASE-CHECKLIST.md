# Production release checklist (November 2026 release)

Everything below is on branch `claude/new-session-21v5xd`. Typecheck, lint and production build are
clean; 321 automated tests pass; `npm audit --omit=dev` reports 0 critical and 0 high advisories
(2 moderate, in a library bundled inside the Excel export package). The deployment memo of
16 November 2026 makes go-live subject to the Information Security review: the findings and fixes are
in the "WakeelBoost Security Review" document.

## What this release contains

- **Origination and credit:** SeedFi credit check with Product Manager review and "Proceed with Reason"
  (skipped automatically until SeedFi is configured; fails closed once it has been activated).
- **Documents:** Murabaha offer letters, pre-disbursement agreements and Murabaha sale contracts from
  the bank's own templates, prefilled from the facility record; signing on a tablet or download, sign
  on paper and re-upload; goods table grows to one row per item.
- **Closure:** Unit Head approval on every route (Omoseni Ademowo); closure file emailed to the
  initiator, copying the Unit Head and both credit reviewers, to forward to Legal and Shariah; the
  initiator confirms the sale is completed (signed sale contract required); reminders every 2 days,
  copying the line manager after a week.
- **Oversight:** facility ZIP archives, personal MTD dashboards, God's Eye oversight.
- **Security:** all 5 high and 14 medium findings fixed or decided (sign-in hardening, startup checks,
  package upgrades, CSP/HSTS, access control, data protection, key rotation, retention purge).
- **Storage:** private AWS S3 bucket with KMS encryption (SharePoint supported for later, not used now).

## Before deploying

1. **Information Security** has reviewed the release (security review document) and any live test.
2. **AWS S3** set up as in [AWS_S3.md](AWS_S3.md): private bucket, KMS key, least-privilege IAM,
   bucket policy, lifecycle rules, budget alert.
3. **Server settings** (secret store; never in code or chat):

   | Setting | Value |
   | --- | --- |
   | `APP_ENV` | `production` (a production build without it refuses to start) |
   | `APP_URL` | the public HTTPS address of WakeelBoost |
   | `DATABASE_URL` | production PostgreSQL |
   | `FIELD_ENCRYPTION_KEY`, `APP_HMAC_KEY`, `STORAGE_ENCRYPTION_KEY` | three new random 32-byte keys (base64); the published development keys are refused |
   | `TRUSTED_PROXY_HOPS` | `1` or more: WakeelBoost only behind the bank's reverse proxy, with HTTPS |
   | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_SERVER_SIDE_ENCRYPTION=aws:kms`, `S3_KMS_KEY_ID` | from AWS; credentials via the IAM role or the secret store |
   | `MAIL_DRIVER=resend`, `RESEND_API_KEY`, `MAIL_FROM` | Resend (bank decision); verified sending domain |
   | `SCANNER_DRIVER=clamd`, `CLAMD_HOST`, `CLAMD_PORT` | malware scanning (the development scanner is refused) |
   | `SEEDFI_BASE_URL`, `SEEDFI_API_KEY` | only when SeedFi goes live; until then the check is skipped |
   | `RETENTION_YEARS` | `10` unless the bank's policy says otherwise; the purge is on by default |

4. **Hosts:** LibreOffice on the app and worker hosts (PDF letters); at least one worker
   (`npm run worker`): it sends email, retries letters and archives, sends reminders and runs retention.

## Deploying

1. Back up the production database.
2. `npm ci` then `npm run build`.
3. `npm run migrate` (applies migrations up to `016_storage_migrations.sql`).
4. `npm run seed` (real staff, recipient groups and the bank's templates; demo data is refused in
   production).
5. If the database was ever seeded with demo accounts, suspend them under Administration > Staff:
   production refuses to start while any demo account is active.
6. Start the web app (`npm start`) and the worker (`npm run worker`). On first start the server marks
   the database as production and upgrades stored change-detection digests.

## After deploying

- Sign in as a Super Admin (8-digit code by email) and open Administration > Credit check
  (SeedFi status), Offer and form templates (all approved and active) and Staff (Omoseni Ademowo as
  Unit Head; grant the real staff their roles).
- Create one test request end to end with a test customer, upload a document and confirm the object
  appears in the S3 bucket under `documents/<request ref>/`, encrypted with the KMS key.
- Confirm emails arrive (sign-in code, assignment).

## Rollback

No migration in this release deletes data. They add tables and columns, and some relax or replace
constraints (for example, allowing more document types and letting retention clear personal fields).
To roll back the application, redeploy the previous build; it ignores the extra tables and columns.
Migrations are not reversed automatically: if the database itself must return to its earlier state,
restore the backup taken in step 1 (anything entered since is lost).
