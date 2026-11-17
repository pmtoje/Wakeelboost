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
