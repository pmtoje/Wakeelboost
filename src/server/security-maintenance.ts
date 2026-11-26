import { db, type Db } from "./db";
import { decryptField, encryptField, fieldUsesCurrentKey } from "./crypto";
import { legacyMaterialDigest, materialDigest, type DraftData } from "./domain/application-data";

/**
 * Replace digests stored before the keyed form (security review M9). A legacy digest is a plain
 * SHA-256 over BVN/TIN; it is recomputed in the keyed form only when it still matches the stored
 * data, so the comparison at the next submission keeps working. Idempotent; runs at startup.
 */
export async function upgradeMaterialDigests(q: Db = db): Promise<number> {
  const rows = (
    await q.query<{ id: string; data: DraftData; bvn_enc: string | null; tin_enc: string | null; material_digest: string; applicant_type: string }>(
      `SELECT v.id, v.data, v.bvn_enc, v.tin_enc, v.material_digest, a.applicant_type
         FROM application_versions v JOIN applications a ON a.id = v.application_id
        WHERE v.material_digest IS NOT NULL AND v.material_digest NOT LIKE 'h1:%'`,
    )
  ).rows;
  let n = 0;
  for (const r of rows) {
    const dirs = (await q.query<{ full_name: string; bvn_enc: string | null }>("SELECT full_name, bvn_enc FROM application_directors WHERE version_id = $1 ORDER BY position", [r.id])).rows;
    if (dirs.some((d) => !d.bvn_enc)) continue; // purged
    const input = {
      type: r.applicant_type as never,
      data: r.data,
      bvnPlain: r.bvn_enc ? decryptField(r.bvn_enc) : null,
      tinPlain: r.tin_enc ? decryptField(r.tin_enc) : null,
      directors: dirs.map((d) => ({ fullName: d.full_name, bvnPlain: decryptField(d.bvn_enc!) })),
    };
    // Only rewrite when the old digest is for exactly this data; otherwise clear it (it can no longer be compared safely).
    const next = legacyMaterialDigest(input) === r.material_digest ? materialDigest(input) : null;
    await q.query("UPDATE application_versions SET material_digest = $2 WHERE id = $1", [r.id, next]);
    n++;
  }
  return n;
}

/** Every encrypted column, for key rotation. */
const ENCRYPTED_COLUMNS: { table: string; column: string }[] = [
  { table: "application_versions", column: "bvn_enc" },
  { table: "application_versions", column: "tin_enc" },
  { table: "application_versions", column: "nin_enc" },
  { table: "application_directors", column: "bvn_enc" },
  { table: "application_directors", column: "nin_enc" },
  { table: "credit_checks", column: "bvn_enc" },
  { table: "credit_checks", column: "response_enc" },
];

/**
 * Key rotation (security review M11): re-encrypt every encrypted field under the current
 * FIELD_ENCRYPTION_KEY. Rows already under the current key are skipped, so it can be re-run.
 * Run with the new key as FIELD_ENCRYPTION_KEY and the old one in FIELD_ENCRYPTION_KEYS_PREVIOUS.
 */
export async function reencryptFields(q: Db = db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const rows = (await q.query<{ id: string; v: string }>(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)).rows;
    let n = 0;
    for (const r of rows) {
      if (fieldUsesCurrentKey(r.v)) continue;
      await q.query(`UPDATE ${table} SET ${column} = $2 WHERE id = $1`, [r.id, encryptField(decryptField(r.v))]);
      n++;
    }
    out[`${table}.${column}`] = n;
  }
  return out;
}
