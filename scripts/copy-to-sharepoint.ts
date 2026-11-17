import { loadEnv } from "./load-env";
loadEnv();
import { closePool } from "../src/server/db";
import { createStore } from "../src/server/storage";
import { copyStorage, rollbackStorage, switchStorage, type Driver } from "../src/server/storage/copy";
import { auditOutsideTx } from "../src/server/audit";
import { systemCtx } from "../src/server/context";

/**
 * Copy existing documents and templates to the bank's SharePoint library.
 *
 *   SOURCE_STORAGE_DRIVER=s3 npm run storage:copy-to-sharepoint -- --dry-run   # what would be copied
 *   SOURCE_STORAGE_DRIVER=s3 npm run storage:copy-to-sharepoint                # copy (app keeps running)
 *   SOURCE_STORAGE_DRIVER=s3 npm run storage:copy-to-sharepoint -- --switch    # app stopped: final copy + switch
 *   SOURCE_STORAGE_DRIVER=s3 npm run storage:copy-to-sharepoint -- --rollback  # point back at the source
 *
 * The source settings (S3_* or STORAGE_LOCAL_DIR) and the SHAREPOINT_* settings are read from the
 * environment, as for the app. The source is never modified or deleted. See docs/SHAREPOINT.md.
 */
async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const conc = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 4);
  const sourceDriver = (process.env.SOURCE_STORAGE_DRIVER ?? "") as Driver;
  if (!["s3", "local"].includes(sourceDriver)) throw new Error("Set SOURCE_STORAGE_DRIVER to where the documents are now: s3 or local.");
  const ctx = systemCtx();

  if (flag("--rollback")) {
    const r = await rollbackStorage("sharepoint");
    await auditOutsideTx(ctx, { action: "STORAGE_ROLLBACK", details: { target: "sharepoint", source: sourceDriver, ...r } });
    console.log(`Rolled back: ${r.documents} document(s) and ${r.templates} template(s) point at ${sourceDriver} again.`);
    console.log(`Start the app with STORAGE_DRIVER=${sourceDriver}.`);
    return;
  }

  const source = createStore(sourceDriver, { allowLocalInProduction: true });
  const target = createStore("sharepoint");
  const report = await copyStorage({ source, target, sourceDriver, targetDriver: "sharepoint", dryRun: flag("--dry-run"), concurrency: conc, log: console.log });
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`Documents: ${report.documents.copied} copied, ${mb(report.documents.bytes)}${flag("--dry-run") ? ` (${report.documents.skipped} to copy)` : ""}`);
  console.log(`Templates: ${report.templates.copied} copied${flag("--dry-run") ? ` (${report.templates.skipped} to copy)` : ""}`);
  if (report.sample.length) {
    console.log("Examples:");
    for (const s of report.sample) console.log(`  ${s.from}  ->  ${s.to}`);
  }
  for (const f of report.failures) console.log(`  FAILED ${f.kind} ${f.id} (${f.key}): ${f.reason}`);
  if (!flag("--dry-run")) await auditOutsideTx(ctx, { action: "STORAGE_COPIED", outcome: report.failures.length ? "FAILURE" : "SUCCESS", details: { source: sourceDriver, target: "sharepoint", documents: report.documents, templates: report.templates, failures: report.failures.length } });
  if (report.failures.length) {
    console.log(`${report.failures.length} object(s) failed. Fix the cause and run again; copied objects are not copied twice.`);
    process.exitCode = 1;
    return;
  }

  if (flag("--switch")) {
    const r = await switchStorage("sharepoint");
    await auditOutsideTx(ctx, { action: "STORAGE_SWITCHED", details: { source: sourceDriver, target: "sharepoint", ...r } });
    console.log(`Switched: ${r.documents} document(s) and ${r.templates} template(s) now point at SharePoint.`);
    console.log("Start the app and worker with STORAGE_DRIVER=sharepoint. Keep the source as a backup until you have checked a few documents.");
  } else if (!flag("--dry-run")) {
    console.log("Copy complete. The app still reads from the source. When ready: stop the app and worker, then run again with --switch.");
  }
}
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
