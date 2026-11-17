import { db, withTx, type Db } from "../db";
import { sha256Hex } from "../crypto";
import { documentStorageKey } from "../domain/documents";
import type { ObjectStore } from "./index";

/**
 * Copy every stored document and template from one store to another (e.g. S3 or local files to
 * SharePoint), in two phases so the running app is never pointed at a file that is not there yet:
 *
 *   copy    Read each object from the source, check its SHA-256 against the database, write it to the
 *           target under its readable path, read it back and check again, and log it. The database
 *           still points at the source, so the app keeps working. Safe to stop and re-run: only
 *           objects not yet copied (or changed since, e.g. moved out of quarantine) are copied.
 *   switch  With the app stopped: a final copy of anything new, then, in one transaction, point every
 *           document and template at its copy. Start the app with the target STORAGE_DRIVER.
 *   rollback  Point everything back at the source (the source is never modified or deleted).
 */
export type Driver = "local" | "s3" | "sharepoint";
export interface CopyOptions {
  source: ObjectStore;
  target: ObjectStore;
  sourceDriver: Driver;
  targetDriver: Driver;
  dryRun?: boolean;
  concurrency?: number;
  now?: Date;
  log?: (line: string) => void;
}
export interface CopyReport {
  documents: { copied: number; skipped: number; bytes: number };
  templates: { copied: number; skipped: number; bytes: number };
  failures: { kind: string; id: string; key: string; reason: string }[];
  sample: { from: string; to: string }[];
}

interface Item {
  kind: "DOCUMENT" | "TEMPLATE";
  id: string;
  key: string;
  to: string;
  sha256: string | null; // documents carry their checksum; templates are checked by read-back only
  size: number;
}

async function pending(q: Db, target: Driver): Promise<Item[]> {
  const docs = (
    await q.query<{ id: string; application_id: string; storage_key: string; category: string; filename: string; version_no: number; sha256: string; size_bytes: string; scan_status: string }>(
      `SELECT d.id, d.application_id, d.storage_key, d.category, d.filename, d.version_no, d.sha256, d.size_bytes, d.scan_status
         FROM documents d
        WHERE d.purged_at IS NULL AND d.scan_status <> 'REJECTED'
          AND NOT EXISTS (SELECT 1 FROM storage_migrations m WHERE m.object_kind = 'DOCUMENT' AND m.object_id = d.id AND m.target_driver = $1 AND d.storage_key IN (m.from_key, m.to_key))
        ORDER BY d.uploaded_at`,
      [target],
    )
  ).rows;
  const items: Item[] = [];
  for (const d of docs) {
    // Clean files get their readable path; files still in quarantine keep theirs (the scan moves them later).
    const to = d.scan_status === "CLEAN" ? await documentStorageKey(q, d.application_id, d.category, d.filename, d.id, d.version_no) : d.storage_key;
    items.push({ kind: "DOCUMENT", id: d.id, key: d.storage_key, to, sha256: d.sha256, size: Number(d.size_bytes) });
  }
  const tpls = (
    await q.query<{ id: string; storage_key: string }>(
      `SELECT t.id, t.storage_key FROM offer_templates t
        WHERE t.storage_key IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM storage_migrations m WHERE m.object_kind = 'TEMPLATE' AND m.object_id = t.id AND m.target_driver = $1 AND t.storage_key IN (m.from_key, m.to_key))`,
      [target],
    )
  ).rows;
  for (const t of tpls) items.push({ kind: "TEMPLATE", id: t.id, key: t.storage_key, to: t.storage_key, sha256: null, size: 0 });
  return items;
}

export async function copyStorage(o: CopyOptions, q: Db = db): Promise<CopyReport> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? new Date();
  const report: CopyReport = { documents: { copied: 0, skipped: 0, bytes: 0 }, templates: { copied: 0, skipped: 0, bytes: 0 }, failures: [], sample: [] };
  const items = await pending(q, o.targetDriver);
  log(`${items.length} object(s) to copy from ${o.sourceDriver} to ${o.targetDriver}${o.dryRun ? " (dry run: nothing is written)" : ""}.`);
  for (const it of items.slice(0, 5)) report.sample.push({ from: it.key, to: it.to });
  if (o.dryRun) {
    for (const it of items) {
      const bucket = it.kind === "DOCUMENT" ? report.documents : report.templates;
      bucket.skipped++;
      bucket.bytes += it.size;
    }
    return report;
  }
  let done = 0;
  const work = items.slice();
  async function worker() {
    for (let it = work.shift(); it; it = work.shift()) {
      const bucket = it.kind === "DOCUMENT" ? report.documents : report.templates;
      try {
        const data = await o.source.get(it.key);
        const sha = sha256Hex(data);
        if (it.sha256 && sha !== it.sha256) throw new Error("source file does not match its recorded checksum (not copied)");
        await o.target.put(it.to, data, "application/octet-stream");
        const back = await o.target.get(it.to);
        if (sha256Hex(back) !== sha) throw new Error("copy in the target does not match the source");
        // A file that moved since its last copy (e.g. out of quarantine): remove the stale copy afterwards.
        const prev = (await q.query<{ to_key: string }>("SELECT to_key FROM storage_migrations WHERE object_kind = $1 AND object_id = $2 AND target_driver = $3", [it.kind, it.id, o.targetDriver])).rows[0];
        await q.query(
          `INSERT INTO storage_migrations (object_kind, object_id, source_driver, target_driver, from_key, to_key, sha256, size_bytes, copied_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (object_kind, object_id, target_driver) DO UPDATE SET from_key = EXCLUDED.from_key, to_key = EXCLUDED.to_key, sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes, copied_at = EXCLUDED.copied_at, source_driver = EXCLUDED.source_driver`,
          [it.kind, it.id, o.sourceDriver, o.targetDriver, it.key, it.to, sha, data.length, now],
        );
        if (prev && prev.to_key !== it.to) await o.target.delete(prev.to_key).catch(() => undefined);
        bucket.copied++;
        bucket.bytes += data.length;
      } catch (e) {
        report.failures.push({ kind: it.kind, id: it.id, key: it.key, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
      if (++done % 50 === 0) log(`  ${done}/${items.length} processed`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, 16)) }, worker));
  return report;
}

/** Point every copied document and template at its copy (run with the app stopped, after a complete copy). */
export async function switchStorage(target: Driver, q: Db = db): Promise<{ documents: number; templates: number }> {
  const left = (await pending(q, target)).length;
  if (left) throw new Error(`${left} object(s) have not been copied yet. Run the copy again (with the app stopped) before switching.`);
  return withTx(async (tx) => {
    const d = await tx.query(
      `UPDATE documents d SET storage_key = m.to_key FROM storage_migrations m
        WHERE m.object_kind = 'DOCUMENT' AND m.object_id = d.id AND m.target_driver = $1 AND d.storage_key = m.from_key AND m.from_key <> m.to_key`,
      [target],
    );
    const t = await tx.query(
      `UPDATE offer_templates t SET storage_key = m.to_key FROM storage_migrations m
        WHERE m.object_kind = 'TEMPLATE' AND m.object_id = t.id AND m.target_driver = $1 AND t.storage_key = m.from_key AND m.from_key <> m.to_key`,
      [target],
    );
    await tx.query(
      "INSERT INTO system_flags (key, set_at, details) VALUES ('STORAGE_DRIVER_SWITCHED', now(), $1) ON CONFLICT (key) DO UPDATE SET set_at = now(), details = EXCLUDED.details",
      [JSON.stringify({ target })],
    );
    return { documents: d.rowCount ?? 0, templates: t.rowCount ?? 0 };
  });
}

/** Undo a switch: point everything back at the source copies (which were never modified). */
export async function rollbackStorage(target: Driver, _q: Db = db): Promise<{ documents: number; templates: number }> {
  return withTx(async (tx) => {
    const d = await tx.query(
      `UPDATE documents d SET storage_key = m.from_key FROM storage_migrations m
        WHERE m.object_kind = 'DOCUMENT' AND m.object_id = d.id AND m.target_driver = $1 AND d.storage_key = m.to_key AND m.from_key <> m.to_key`,
      [target],
    );
    const t = await tx.query(
      `UPDATE offer_templates t SET storage_key = m.from_key FROM storage_migrations m
        WHERE m.object_kind = 'TEMPLATE' AND m.object_id = t.id AND m.target_driver = $1 AND t.storage_key = m.to_key AND m.from_key <> m.to_key`,
      [target],
    );
    await tx.query("DELETE FROM system_flags WHERE key = 'STORAGE_DRIVER_SWITCHED'");
    return { documents: d.rowCount ?? 0, templates: t.rowCount ?? 0 };
  });
}
