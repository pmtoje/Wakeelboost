import { db, withTx } from "../db";
import { systemCtx } from "../context";
import { processDueOfferLetters } from "../domain/offer-letters";
import { processDueSaleContracts } from "../domain/disbursement-docs";
import { processDueArchives } from "../domain/archive";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { objectStore } from "../storage";
import { scanDocument } from "../domain/documents";
import { processOutbox } from "./outbox";
import { runMonthlyReport, runSaleCompletionReminders, runWeeklyDigest } from "./schedules";

/** Retry scans for files left in quarantine (e.g. scanner unavailable at upload time). */
export async function rescanQuarantined(now = new Date()) {
  const rows = (await db.query<{ id: string }>("SELECT id FROM documents WHERE scan_status = 'QUARANTINED' AND uploaded_at < $1 LIMIT 20", [new Date(now.getTime() - 60_000)])).rows;
  for (const r of rows) await scanDocument(systemCtx(now), r.id).catch((e) => console.error("[worker] scan failed", r.id, e));
}

/**
 * Retention: on closed/rejected cases past retention_until, delete document files and clear personal
 * data held in the database (security review M12): BVNs, TIN, raw bureau responses, credit-check
 * date of birth and phone, and the bodies of emails about the case. On by default in production.
 * With a versioned S3 bucket, add a lifecycle rule that expires noncurrent versions.
 */
export async function retentionSweep(now = new Date()) {
  if (!config.retentionPurgeEnabled) return 0;
  const due = (
    await db.query<{ id: string }>("SELECT id FROM applications WHERE retention_until IS NOT NULL AND retention_until < $1 AND pii_purged_at IS NULL LIMIT 100", [now])
  ).rows;
  for (const a of due) {
    await withTx(async (tx) => {
      await tx.query("UPDATE application_versions SET bvn_enc = NULL, tin_enc = NULL WHERE application_id = $1", [a.id]);
      await tx.query("UPDATE application_directors SET bvn_enc = NULL WHERE version_id IN (SELECT id FROM application_versions WHERE application_id = $1)", [a.id]);
      await tx.query("UPDATE credit_checks SET bvn_enc = NULL, response_enc = NULL, date_of_birth = NULL, phone = NULL WHERE application_id = $1", [a.id]);
      await tx.query("UPDATE notification_outbox SET body_text = '[purged after the retention period]' WHERE application_id = $1", [a.id]);
      await tx.query("UPDATE applications SET pii_purged_at = $2 WHERE id = $1", [a.id, now]);
      await audit(tx, systemCtx(now), { action: "PERSONAL_DATA_PURGED", applicationId: a.id, details: { fields: ["bvn", "tin", "directors.bvn", "credit_check.response", "credit_check.date_of_birth", "credit_check.phone", "email_bodies"] } });
    });
  }
  const rows = (
    await db.query<{ id: string; storage_key: string; application_id: string; version_no: number }>(
      `SELECT d.id, d.storage_key, d.application_id, d.version_no FROM documents d JOIN applications a ON a.id = d.application_id
        WHERE d.purged_at IS NULL AND a.retention_until IS NOT NULL AND a.retention_until < $1 LIMIT 100`,
      [now],
    )
  ).rows;
  for (const d of rows) {
    await objectStore().delete(d.storage_key);
    await db.query("UPDATE documents SET purged_at = $2 WHERE id = $1", [d.id, now]);
    await auditOutsideTx(systemCtx(now), { action: "DOCUMENT_PURGED", applicationId: d.application_id, documentId: d.id, documentVersion: d.version_no });
  }
  return rows.length;
}

export async function workerTick(now = new Date()) {
  const results: Record<string, unknown> = {};
  results.offerLetters = await processDueOfferLetters(now);
  results.saleContracts = await processDueSaleContracts(now);
  results.archives = await processDueArchives(now);
  results.outbox = await processOutbox(now);
  results.saleReminders = await runSaleCompletionReminders(now);
  results.weekly = await runWeeklyDigest(now);
  results.monthly = await runMonthlyReport(now);
  await rescanQuarantined(now);
  results.retention = await retentionSweep(now);
  return results;
}
