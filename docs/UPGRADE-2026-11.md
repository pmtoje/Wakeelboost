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

## Before SeedFi is set up

The credit check switches on by itself once SeedFi is configured on the server (base URL plus key or
sign-in; in production, the live service). Until then every initiator, including Agent Network Managers,
creates requests that go straight to the facility application, recorded as "SeedFi credit check not
active when this request was created". Drafts already waiting for a check are released and noted at
submission. After SeedFi is configured, new requests start with the credit check again; requests
created meanwhile are not sent back.

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
disbursement → completion → sale completion (initiator) → **facility ZIP archive generated automatically**.

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

## Disbursement documents: prefilled forms and signing on a tablet

- **Bank templates approved.** The three Murabaha offer letter templates (Individual, Enterprise, Corporate) are approved for live use (migration 011, audited as `TEMPLATE_APPROVED`).
- **Typed templates.** Super Admin → Offer and form templates now takes a *document* for each upload: Murabaha offer letter, pre-disbursement agreement, GSI form or customer insurance (Takaful) form. A form can apply to all applicant types. Forms need `{{customer_name}}` and may use any known placeholder (supplier, invoice, contact, POS serial, DAO code, amounts, dates…). Interest-rate wording is refused on every document.
- **Prefill.** When the offer letter is issued, every form with an active, approved template is filled from the approved facility record (Word copy + PDF preview), audited as `FORM_PREFILLED`. The initiator can refresh them with *Prepare forms from the facility record*. Forms with no template are never invented: the initiator uploads the bank's signed form, exactly as before.
- **Sign on a tablet.** At offer pack preparation the initiator opens *Sign on tablet* for any prepared document. The customer reads it on screen (or downloads it), then the customer and witness sign with a finger or stylus (Corporate: one or two authorised signatories with designations). The signed copy is the prepared document plus an electronic signature page carrying the signatures, the names and witness details, the time, who captured it, the device and the SHA-256 checksum of the exact document presented. It is filed as the signed pack document (the signed offer letter records customer acceptance), stored in `e_signatures` and audited as `DOCUMENT_SIGNED_ON_TABLET`.
- **Download / preview / re-upload.** Every prepared and signed copy can be previewed or downloaded from the action panel. A paper-signed copy can always be uploaded instead; it replaces the previous signed copy and every version is kept.
- **Production** needs LibreOffice for the signed PDF (as for offer letters).
- **Bank agreements installed (17 Nov 2026).** From the bank's Word files, converted by `scripts/build-agreement-templates.py` into `templates/agreements/` and seeded active and approved (run `npm run seed`; it adds them once, matched by source file):
  - *Murabaha pre-disbursement agreement*: Individual, Enterprise and Company. Prepared with the offer letter and signed at offer pack preparation.
  - *Murabaha (sale) contract, post-disbursement (MetLaw edits)*: Individual and Enterprise, with Appendix A (receipt of asset). Prepared when Credit Officer 3 completes the process and the request returns to the initiator for **sale completion**, and signed there by the customer. The initiator then confirms the sale is completed (formerly "confirm vendor payment"); no CAD confirmation is needed, and the signed sale contract is required for Individual and Enterprise customers.
- **Closure file routing (security review H3).** Complete Process now emails the full customer file and transaction summary to the **initiator**, copying the **Unit Head** who approved the request and **both credit reviewers** (people already authorised to see the whole file, including credit reports). It no longer goes straight to the Legal and Shariah mailboxes: the email lists their addresses, the initiator forwards it, and "Confirm sale completed" requires the initiator to confirm they did (audited as `CLOSURE_PACK_FORWARDED`). Every route includes Unit Head approval, so the approving Unit Head is always copied. Legal and Shariah keep their read-only access to closed cases in the app, without credit reports.
- **Unit Head.** Unit Head approval applies to every transaction (all three credit routes). Omoseni Ademowo (omoseni.ademowo@altbank.ng) is seeded as Unit Head; anyone else the Super Admin gives the UNIT_HEAD role joins the pool and Unit Head tasks are shared among them. Run `npm run seed` to add her on an existing installation.
- **Sale completion reminders.** The worker emails the initiator when a request has waited at sale completion for two days, then every two days until they confirm (working hours only, 08:00–18:00 Lagos; audited as `SALE_COMPLETION_REMINDER_SENT`). The email says whether the sale contract still needs signing. Once a request has waited a week, each reminder also copies the initiator's line manager (the request's business endorser: Regional Business Executive, ANM Lead or Merchant Officer Lead) and is marked *Overdue*; if that person is no longer active, the initiator alone is emailed and the audit records why. The Monday weekly summary also lists every request waiting for the initiator's sale completion. The worker retries preparation if it fails.
  - Filled from the facility record: agreement date, offer letter date, customer party (name, trading name, address / company), goods, cost price, contract (sale) price, markup, monthly instalment, tenor, asset table (one numbered row per item, taken from the application's *Items to finance*; the table grows to fit) and the customer's AltBank account (new optional field on the application; a dotted line when not captured).
  - Also filled: the bank's two signatories (Name / Title, the same officers who sign the offer letter) and, on the Company agreement, the first two directors' names.
  - Left for completion by hand: the security deposit (Hamish Jiddiyah) amount and percentage, and the witness lines (or signed on the tablet signature page).
  - Re-running `npm run seed` after a template file changes installs it as the next version and retires the previous one; documents already produced keep their version.
- **Two ways to sign every document, side by side.** Each document in the action panel has: *Sign on tablet*; *Preview*, *PDF* and *Word* (direct downloads of the fully prefilled copy, for printing and signing on paper); and *Upload signed copy* / *Re-upload signed copy* against that same document. The latest signed copy can be viewed or downloaded; every version is kept.
- **Still not supplied:** a Company sale contract, the GSI form and the customer insurance (Takaful) form. Those rows show "No bank template · upload the signed form" until a template is uploaded under Offer and form templates, approved and activated.
- One active template per document and applicant type (migration 013 updates the unique index and adds the sale-contract document type).

## Before production

1. **SeedFi (live)**: WakeelBoost uses the same Alt Mall SeedFi production key as ARAF
   (`AltMall_ARAF_prod_Nov2026`, Alt Mall account paul.toje@altbank.ng; same team). In WakeelBoost's
   deployment settings set `SEEDFI_BASE_URL=https://loanengine.theseedfi.com` and `SEEDFI_API_KEY` to
   the value of that key, copied from ARAF's deployment settings. Do not set `SEEDFI_USERNAME` /
   `SEEDFI_PASSWORD` (account sign-in remains available as an alternative). Servers behind an outbound
   proxy need nothing extra: `npm start`, `npm run worker` and `npm run dev` detect `HTTPS_PROXY` and
   turn on Node's proxy support automatically (`scripts/with-proxy.mjs`). Production refuses SeedFi
   staging. The live connection has not been verified from this build environment (the key is held
   only in ARAF's deployment); the first real credit check, with a consenting customer, is the live test.
2. **Credit rules**: enter the bank's approved rules.
3. **Product Manager**: grant the role (Users & roles) to the responsible staff.
4. **Offer templates**: Super Admin → Offer templates → Preview sample → Approve each of the three
   Murabaha templates. Production refuses to issue letters from an unapproved template.
5. **LibreOffice** on the application and worker hosts (PDF letters). Production refuses to issue a
   letter without its PDF.
6. **Worker**: at least one `npm run worker` (retries letters and archives, sends email).
7. **Storage**: confirm the S3 bucket and KMS key permissions; archives are stored there encrypted.
8. **Processing targets** (optional): Super Admin sets per-stage targets in God's Eye.
9. **Security settings (security review)**: set `APP_ENV=production` explicitly (a production build
   without APP_ENV refuses to start), real 32-byte keys (the published dev keys are refused),
   `TRUSTED_PROXY_HOPS` of at least 1 (the bank's reverse proxy must append the client address to
   `X-Forwarded-For`), and HTTPS on the proxy. Email stays on Resend (bank decision, 17 Nov 2026):
   set `MAIL_DRIVER=resend` and `RESEND_API_KEY`; production refuses to start without it. If SMTP is
   ever used instead, it must offer TLS (required in production).
10. Run `npm run migrate` (adds `system_flags`, makes retention-purgeable columns nullable) and
   `npm run seed` (real staff and the bank's templates only; demo data is refused in production),
   then deploy. On first start the server marks the database as production, refuses to run while any
   demo account is active, and upgrades stored change-detection digests to the keyed form.
11. **Storage and retention**: documents are stored in the bank's SharePoint library
   (`STORAGE_DRIVER=sharepoint`; the Microsoft 365 admin steps are in [SHAREPOINT.md](SHAREPOINT.md)).
   Production refuses local storage. If S3 is used instead, it must use `S3_SERVER_SIDE_ENCRYPTION=AES256`
   or `aws:kms` (`none` is refused). The retention purge is on by default in production; on a versioned bucket, add a
   lifecycle rule that expires noncurrent object versions.

## Security fixes (17 Nov 2026)

Medium findings (second pass, same day):

- **Headers (M1).** A per-request Content-Security-Policy with a script nonce (no inline or third-party
  scripts) and HSTS (one year). Session cookies are Secure in production.
- **Demo accounts (M2).** Demo seeding is opt-in (`--with-demo`) and refused on any database a
  production server has used; production refuses to start while a demo account is active.
- **Request sizes (M3).** Middleware rejects oversized bodies by path before parsing (64 KB on sign-in,
  1 MB generally, 4 MB for tablet signatures, 11 MB for admin imports, the upload limit + 1 MB for
  documents); uploads must declare their length.
- **Access (M5–M8).** Booked Requests honour a Reporting Admin's region scope; case and credit access
  end when the role is removed; full BVN/TIN reveal is limited to the initiator, the officer holding the
  case and the credit decision-makers; at disbursement correction Credit Officer 3 returns the pack to
  the initiator instead of replacing customer-signed documents; bureau credit reports and DSR evidence
  are restricted like the SeedFi report.
- **Data protection (M9–M12).** The change-detection digest is keyed (HMAC), and old digests are upgraded
  at startup. Encryption keys can be rotated: put the old key in `FIELD_ENCRYPTION_KEYS_PREVIOUS`
  (or `STORAGE_ENCRYPTION_KEYS_PREVIOUS`), restart, run `npm run security:reencrypt`, then remove the
  old key. Unencrypted S3 is refused in production. Past retention, the purge also clears BVNs, TIN,
  raw bureau responses, credit-check date of birth and phone, and email bodies about the case.
- **Sign-in timing (M14).** The code email is sent without delaying the response.

- **Sign-in codes (H1).** Codes are 8 digits. After 10 wrong codes in 24 hours, across all codes, an
  account's sign-in locks; Super Admins get an email alert and can unlock it under Administration >
  Staff (not their own). A bank-wide spike (100 wrong codes in an hour) also alerts Super Admins. Rate
  limits are atomic, and the client IP comes only from the trusted proxy.
- **Startup checks (H2).** The web server and worker exit at startup when a production build has no
  APP_ENV, or when production uses dev keys or no trusted proxy. A production build run with
  APP_ENV=development logs a prominent warning.
- **Packages (H4).** nodemailer 10.6.0, zod 4.6.7, AWS SDK 3.1170 (no longer uses fast-xml-parser),
  React 19.2.9; postcss pinned to 8.5.33 for Next.js. `npm audit` of production packages: 0 critical,
  0 high (2 moderate remain, in exceljs's bundled uuid).
- **SeedFi fails closed (H5).** The first production start with a working live SeedFi setup records
  `SEEDFI_ACTIVATED` (shown on Administration > Credit check). From then on the check stays
  mandatory: if SeedFi stops working, new requests wait at the credit check and Super Admins are
  emailed (once a day); drafts are never released without a check.

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
