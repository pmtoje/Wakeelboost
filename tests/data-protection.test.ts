import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { decryptField, encryptField } from "@/server/crypto";
import { assertProductionConfig } from "@/server/config";
import { legacyMaterialDigest, materialDigest } from "@/server/domain/application-data";
import { reencryptFields, upgradeMaterialDigests } from "@/server/security-maintenance";
import { retentionSweep } from "@/server/jobs/worker";
import { createSubmittedCase, driveToClosed, driveToOffer } from "@/server/demo/scenario";
import { audits, resetDb } from "./helpers";

const saved = { ...process.env };
beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  for (const k of ["FIELD_ENCRYPTION_KEY", "FIELD_ENCRYPTION_KEYS_PREVIOUS", "APP_ENV", "STORAGE_DRIVER", "S3_SERVER_SIDE_ENCRYPTION", "TRUSTED_PROXY_HOPS", "APP_HMAC_KEY", "STORAGE_ENCRYPTION_KEY", "MAIL_DRIVER", "RESEND_API_KEY", "RETENTION_PURGE_ENABLED"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("data protection (security review M9-M12)", () => {
  it("M9: the change-detection digest is keyed; old unkeyed digests are upgraded and still compare", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    const v = (await db.query("SELECT v.id, v.material_digest FROM applications a JOIN application_versions v ON v.id = a.current_version_id WHERE a.id = $1", [id])).rows[0];
    expect(v.material_digest).toMatch(/^h1:[0-9a-f]{64}$/);
    // Simulate a version stored before the change, then upgrade it at startup
    // A genuine legacy digest (plain SHA-256 of the same data) is upgraded to the keyed form
    const row = (await db.query("SELECT data, bvn_enc, tin_enc, nin_enc FROM application_versions WHERE id = $1", [v.id])).rows[0];
    const input = { type: "INDIVIDUAL" as const, data: row.data, bvnPlain: row.bvn_enc ? decryptField(row.bvn_enc) : null, tinPlain: row.tin_enc ? decryptField(row.tin_enc) : null, directors: [] };
    expect(materialDigest({ ...input, ninPlain: decryptField(row.nin_enc) })).toBe(v.material_digest);
    // Versions stored before NIN existed have none, and their digest is unchanged by the NIN field
    expect(materialDigest({ ...input, ninPlain: null })).toBe(materialDigest(input));
    await db.query("UPDATE application_versions SET nin_enc = NULL, nin_last4 = NULL, material_digest = $2 WHERE id = $1", [v.id, legacyMaterialDigest(input)]);
    expect(await upgradeMaterialDigests(db)).toBe(1);
    expect((await db.query("SELECT material_digest FROM application_versions WHERE id = $1", [v.id])).rows[0].material_digest).toBe(materialDigest(input));
    // A legacy digest that no longer matches the data is cleared, never trusted
    await db.query("UPDATE application_versions SET material_digest = $2 WHERE id = $1", [v.id, "0".repeat(64)]);
    expect(await upgradeMaterialDigests(db)).toBe(1);
    expect((await db.query("SELECT material_digest FROM application_versions WHERE id = $1", [v.id])).rows[0].material_digest).toBeNull();
    expect(await upgradeMaterialDigests(db)).toBe(0);
  });

  it("M11: keys rotate without downtime, and re-encryption moves every field to the new key", async () => {
    await createSubmittedCase({ initiator: "RM", type: "LIMITED", amountKobo: NAIRA(1_000_000) });
    const oldKey = process.env.FIELD_ENCRYPTION_KEY!;
    const { id: dirId, bvn_enc: sample, nin_enc: ninSample } = (await db.query("SELECT id, bvn_enc, nin_enc FROM application_directors WHERE nin_enc IS NOT NULL LIMIT 1")).rows[0];
    const plain = decryptField(sample);
    process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS = oldKey;
    expect(decryptField(sample)).toBe(plain); // still readable during the rotation
    const r = await reencryptFields(db);
    expect(r["application_directors.bvn_enc"]).toBeGreaterThan(0);
    expect(r["application_directors.nin_enc"]).toBe(1);
    expect(r["application_versions.nin_enc"]).toBeGreaterThanOrEqual(0);
    expect(Object.values(await reencryptFields(db)).every((n) => n === 0)).toBe(true); // idempotent
    delete process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS; // old key retired
    const after = (await db.query("SELECT bvn_enc, nin_enc FROM application_directors WHERE id = $1", [dirId])).rows[0];
    expect(decryptField(after.bvn_enc)).toBe(plain);
    expect(decryptField(after.nin_enc)).toBe("33300000001");
    expect(() => decryptField(ninSample)).toThrow();
    expect(() => decryptField(sample)).toThrow(); // old ciphertext no longer readable without the old key
    expect(decryptField(encryptField("x"))).toBe("x");
  });

  it("M10: production refuses unencrypted S3 storage", () => {
    process.env.APP_ENV = "production";
    for (const k of ["FIELD_ENCRYPTION_KEY", "APP_HMAC_KEY", "STORAGE_ENCRYPTION_KEY"]) process.env[k] = randomBytes(32).toString("base64");
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.MAIL_DRIVER = "resend";
    process.env.RESEND_API_KEY = "re_test_placeholder";
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_SERVER_SIDE_ENCRYPTION = "none";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/S3_SERVER_SIDE_ENCRYPTION=none/);
    process.env.S3_SERVER_SIDE_ENCRYPTION = "aws:kms";
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("M12: past retention, personal data is purged from the database too, not only files", async () => {
    process.env.RETENTION_PURGE_ENABLED = "true";
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    await driveToClosed(id);
    await db.query("UPDATE applications SET retention_until = '2020-01-01' WHERE id = $1", [id]);
    await retentionSweep(new Date());
    const v = (await db.query("SELECT bvn_enc, tin_enc FROM application_versions WHERE application_id = $1", [id])).rows;
    expect(v.every((r) => r.bvn_enc === null && r.tin_enc === null)).toBe(true);
    const mails = (await db.query("SELECT body_text FROM notification_outbox WHERE application_id = $1", [id])).rows;
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.every((m) => m.body_text === "[purged after the retention period]")).toBe(true);
    expect((await db.query("SELECT pii_purged_at FROM applications WHERE id = $1", [id])).rows[0].pii_purged_at).not.toBeNull();
    expect((await audits("PERSONAL_DATA_PURGED")).length).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM documents WHERE application_id = $1 AND purged_at IS NULL", [id])).rows[0].n).toBe(0);
  });

  it("M12: the purge is on by default in production", async () => {
    delete process.env.RETENTION_PURGE_ENABLED;
    const { config } = await import("@/server/config");
    process.env.APP_ENV = "production";
    expect(config.retentionPurgeEnabled).toBe(true);
    process.env.APP_ENV = "test";
    expect(config.retentionPurgeEnabled).toBe(false);
  });
});
