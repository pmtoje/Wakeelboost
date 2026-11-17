import { loadEnv } from "./load-env";
loadEnv();
import { config, isPersonalOneDrive } from "../src/server/config";
import { checkSharePointConnection } from "../src/server/storage/sharepoint";

/**
 * Check the SharePoint settings from the WakeelBoost server: npm run storage:check-sharepoint
 * Signs in, finds the site and library, then writes, reads back and deletes a small test file.
 * Secrets are never printed.
 */
async function main() {
  const s = config.sharepoint;
  const missing = [
    ["SHAREPOINT_TENANT_ID", s.tenantId],
    ["SHAREPOINT_CLIENT_ID", s.clientId],
    ["SHAREPOINT_CLIENT_SECRET", s.clientSecret],
    ["SHAREPOINT_SITE", s.site || s.driveId],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.log(`Missing settings: ${missing.join(", ")}. See docs/SHAREPOINT.md.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Site: ${s.site || "(drive id)"} · library: ${s.library} · folder: ${s.rootFolder} · secret: set (${s.clientSecret.length} characters)`);
  if (isPersonalOneDrive(s.site)) console.log("TRIAL: this is a personal OneDrive. Fine for a trial; move to a SharePoint team site before go-live (docs/SHAREPOINT.md).");
  const steps = await checkSharePointConnection();
  for (const r of steps) console.log(`${r.ok ? "OK  " : "FAIL"}  ${r.step}: ${r.detail}`);
  const ok = steps.length === 5 && steps.every((r) => r.ok);
  console.log(ok ? "\nSharePoint is ready. Next: npm run storage:copy-to-sharepoint -- --dry-run" : "\nFix the failed step (see docs/SHAREPOINT.md, Troubleshooting) and run this again.");
  if (!ok) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
