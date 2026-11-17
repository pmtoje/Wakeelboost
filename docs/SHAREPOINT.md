# SharePoint document storage

WakeelBoost stores every document in a SharePoint document library: uploads, generated offer letters
and agreements, tablet-signed copies, SeedFi credit reports and the facility ZIP archives. The app
talks to SharePoint through Microsoft Graph with its own Entra ID app registration (app-only access);
staff never need SharePoint access to use WakeelBoost.

Bank decisions (17 Nov 2026): SharePoint is the main document store, and files are stored as ordinary
SharePoint files, so authorised records/audit staff can open them in SharePoint. Microsoft encrypts
them at rest.

## What the Microsoft 365 administrator sets up

1. **Site and library.** Create a SharePoint site for WakeelBoost (for example
   `https://altbank.sharepoint.com/sites/WakeelBoost`). The default `Documents` library is fine, or
   create a dedicated library and give its name in `SHAREPOINT_LIBRARY`.
2. **Library permissions.** Stop inheriting permissions on the library and remove broad groups
   (Everyone, all staff, site visitors). Grant read access only to the named records/audit staff the
   bank approves. WakeelBoost decides who may open each case and each credit report; anyone with
   access to this library bypasses that, and sees BVNs, bank statements and credit reports.
3. **App registration.** In Entra ID, register an application named "WakeelBoost Work Desk".
   - API permissions: Microsoft Graph, **Application** permission `Sites.Selected`. Grant admin consent.
     (Do not grant `Sites.ReadWrite.All` or `Files.ReadWrite.All`: they cover every site in the tenant.)
   - Create a client secret (or certificate). Note the tenant ID, the application (client) ID and the secret.
4. **Give the app access to this one site** (Sites.Selected), for example with PnP PowerShell:

   ```powershell
   Grant-PnPAzureADAppSitePermission -AppId <client-id> -DisplayName "WakeelBoost Work Desk" `
     -Site https://altbank.sharepoint.com/sites/WakeelBoost -Permissions Write
   ```

   or with Graph: `POST /sites/{site-id}/permissions` with `roles: ["write"]` and the app's identity.
5. **Retention.** Deleted files go to the site recycle bin, and SharePoint keeps file versions. Set the
   library's retention policy to match the bank's records policy, so files WakeelBoost purges after
   the retention period do not stay in the recycle bin or version history longer than intended.

## WakeelBoost settings (deployment secret store)

| Setting | Example | Notes |
| --- | --- | --- |
| `STORAGE_DRIVER` | `sharepoint` | Production refuses local file storage |
| `SHAREPOINT_TENANT_ID` | `xxxxxxxx-…` | Directory (tenant) ID |
| `SHAREPOINT_CLIENT_ID` | `xxxxxxxx-…` | Application (client) ID |
| `SHAREPOINT_CLIENT_SECRET` | (secret) | Secret store only; never in code, chat or logs |
| `SHAREPOINT_SITE` | `altbank.sharepoint.com:/sites/WakeelBoost` | Host, colon, site path |
| `SHAREPOINT_LIBRARY` | `Documents` | Library name (default `Documents`) |
| `SHAREPOINT_DRIVE_ID` | (optional) | Library's drive id; skips the lookup by name |
| `SHAREPOINT_ROOT_FOLDER` | `WakeelBoost` | Top folder inside the library |

The server must be able to reach `login.microsoftonline.com`, `graph.microsoft.com` and the tenant's
SharePoint host (for example `altbank.sharepoint.com`, used for file downloads). The server refuses to
start in production when any required setting is missing.

## How files are laid out

```
WakeelBoost/
  documents/
    WB-2026-001035/
      SIGNED_OFFER/Signed-Murabaha-offer-letter-v1-3f2a9c1e.pdf
      GENERATED_OFFER/Offer-WB-2026-001035-individual-t1-8c21aa04.docx
      BANK_STATEMENT/March statement-v1-1b7e90d2.pdf
      FACILITY_ARCHIVE/WB-2026-001035-archive-…zip
  quarantine/        uploads waiting for the malware scan (do not open; they are moved out when clean)
  templates/offer/   the bank's Word templates
```

Folders are named by request reference and document type; customer names are not used in folder
names. Every version of a document is kept as its own file.

## Behaviour

- Files up to 4 MB are uploaded in one request; larger files use a Graph upload session in chunks.
- The app signs in once and reuses its token until shortly before it expires; Graph throttling
  (HTTP 429/503) is retried, honouring `Retry-After`.
- A file moves out of `quarantine/` only after the malware scan passes; rejected uploads are deleted.
- Every view and download still goes through WakeelBoost's own access checks and is audited.

## Moving existing documents to SharePoint

`npm run storage:copy-to-sharepoint` copies every stored document and template from the current store
(S3 or local files) into the library under the readable paths above. Set `SOURCE_STORAGE_DRIVER`
(`s3` or `local`) with that store's usual settings, plus the `SHAREPOINT_*` settings.

1. **Check:** `SOURCE_STORAGE_DRIVER=s3 npm run storage:copy-to-sharepoint -- --dry-run` lists how
   many documents and templates would be copied, their size, and example paths. Nothing is written.
2. **Copy while the app runs:** run it without flags. Each file is read from the source, checked
   against the SHA-256 recorded when it was stored, written to SharePoint, read back and checked again,
   then logged (`storage_migrations`). The app keeps using the source, so nothing breaks. A file whose
   checksum does not match is reported and not copied. The run can be stopped and repeated: files
   already copied are skipped. Use `--concurrency=8` to go faster (default 4, maximum 16).
3. **Switch with the app stopped:** stop the web app and the worker, then run with `--switch`. It copies
   anything added since step 2, refuses to switch if any file failed, then points every document and
   template at its SharePoint copy in one transaction.
4. **Start on SharePoint:** set `STORAGE_DRIVER=sharepoint` and start the app and worker. Open a few
   documents from different requests to confirm.
5. **Keep the source** as a backup until you are satisfied; the script never modifies or deletes it.
   If something is wrong, stop the app, run with `--rollback`, and start the app with the old
   `STORAGE_DRIVER` again.

Each run is audited (`STORAGE_COPIED`, `STORAGE_SWITCHED`, `STORAGE_ROLLBACK`).

## Connecting your folder (from its web address)

Open the folder in the browser and copy its address, for example:

```
https://altbank.sharepoint.com/sites/Wakeel/Shared%20Documents/WakeelBoost
```

| Part of the address | Setting |
| --- | --- |
| `altbank.sharepoint.com` + `/sites/Wakeel` | `SHAREPOINT_SITE=altbank.sharepoint.com:/sites/Wakeel` |
| `Shared%20Documents` (the library) | `SHAREPOINT_LIBRARY=Shared Documents` (or its display name, `Documents`) |
| `WakeelBoost` (your folder; nested folders allowed, e.g. `General/WakeelBoost`) | `SHAREPOINT_ROOT_FOLDER=WakeelBoost` |

The folder must be in a SharePoint site (a Teams channel's files are too). A folder in someone's
personal OneDrive cannot be used: `Sites.Selected` covers SharePoint sites only.

Then, on the WakeelBoost server: `npm run storage:check-sharepoint`. It signs in, finds the site and
library, and writes, reads back and deletes a small test file in your folder.

## Troubleshooting the connection check

| Failed step | Usual cause |
| --- | --- |
| Sign in to Microsoft | Wrong tenant ID, client ID or secret; the secret has expired; or the server cannot reach `login.microsoftonline.com` |
| Find the site and document library | HTTP 403: the app was not granted the site (step 4 above). HTTP 404 or "not found": `SHAREPOINT_SITE` or `SHAREPOINT_LIBRARY` does not match the address |
| Write a test file | The app was granted `Read` instead of `Write` on the site |
| Read it back | The server cannot reach the tenant's SharePoint host (downloads come from it) |
