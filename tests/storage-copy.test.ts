import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { SharePointStore, setSharePointFetchForTests } from "@/server/storage/sharepoint";
import { objectStore, setObjectStoreForTests, type ObjectStore } from "@/server/storage";
import { copyStorage, rollbackStorage, switchStorage } from "@/server/storage/copy";
import { readDocumentForActor, uploadDocument } from "@/server/domain/documents";
import { processDueOfferLetters } from "@/server/domain/offer-letters";
import { createSubmittedCase, ctxFor, driveToOffer, makePdf } from "@/server/demo/scenario";
import { resetDb } from "./helpers";
import { FakeGraph, SHAREPOINT_TEST_ENV } from "./fake-graph";

const saved = { ...process.env };
let graph: FakeGraph;
let local: ObjectStore;
let sharepoint: SharePointStore;
let caseId: string;

beforeEach(async () => {
  setObjectStoreForTests(null);
  await resetDb();
  Object.assign(process.env, SHAREPOINT_TEST_ENV);
  graph = new FakeGraph();
  setSharePointFetchForTests(graph.fetch as typeof fetch);
  sharepoint = new SharePointStore();
  local = objectStore(); // the documents' current store (local files in tests)
  // A request with uploaded and generated documents, all in the current store
  caseId = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
  await driveToOffer(caseId);
  await processDueOfferLetters();
});
afterEach(() => {
  setObjectStoreForTests(null);
  for (const k of Object.keys(SHAREPOINT_TEST_ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => setSharePointFetchForTests(null));

const opts = () => ({ source: local, target: sharepoint, sourceDriver: "local" as const, targetDriver: "sharepoint" as const });
const docCount = async () => (await db.query("SELECT count(*)::int AS n FROM documents WHERE purged_at IS NULL AND scan_status <> 'REJECTED'")).rows[0].n;

describe("copying existing documents to SharePoint", () => {
  it("a dry run reports what would be copied and writes nothing", async () => {
    const r = await copyStorage({ ...opts(), dryRun: true });
    expect(r.documents.skipped).toBe(await docCount());
    expect(r.templates.skipped).toBeGreaterThan(0);
    expect(r.sample[0].to).toMatch(/^(documents\/WB-|templates\/)/);
    expect(graph.files.size).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM storage_migrations")).rows[0].n).toBe(0);
  });

  it("copies and verifies everything while the app keeps reading the old store, then switches in one step", async () => {
    const before = (await db.query("SELECT id, storage_key, sha256 FROM documents ORDER BY id")).rows;
    const r = await copyStorage(opts());
    expect(r.failures).toEqual([]);
    expect(r.documents.copied).toBe(await docCount());
    // Readable paths in the library; the database still points at the old store
    const ref = (await db.query("SELECT ref FROM applications WHERE id = $1", [caseId])).rows[0].ref;
    expect([...graph.files.keys()].some((k) => k.startsWith(`WakeelBoost/documents/${ref}/GENERATED_OFFER/`))).toBe(true);
    expect((await db.query("SELECT id, storage_key, sha256 FROM documents ORDER BY id")).rows).toEqual(before);
    const rm = await ctxFor("rm.ade@altbank.ng");
    const letter = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'GENERATED_OFFER'", [caseId])).rows[0];
    const original = (await readDocumentForActor(rm, letter.id, "download")).data;
    // Re-running copies nothing new
    const again = await copyStorage(opts());
    expect(again.documents.copied + again.templates.copied).toBe(0);
    // A document added before the switch must be copied first: the switch refuses until then
    await uploadDocument(rm, { applicationId: caseId, category: "SUPPORTING", filename: "late.pdf", data: makePdf("added during the copy") });
    await expect(switchStorage("sharepoint")).rejects.toThrow(/have not been copied yet/);
    expect((await copyStorage(opts())).documents.copied).toBe(1);
    // Switch, then read everything through SharePoint
    const renamed = (await db.query("SELECT count(*)::int AS n FROM storage_migrations WHERE object_kind = 'DOCUMENT' AND from_key <> to_key")).rows[0].n;
    expect(renamed).toBeGreaterThan(0);
    const sw = await switchStorage("sharepoint");
    expect(sw.documents).toBe(renamed); // files already under their readable name need no change
    setObjectStoreForTests(sharepoint);
    expect((await readDocumentForActor(rm, letter.id, "download")).data.equals(original)).toBe(true);
    const keys = (await db.query("SELECT storage_key FROM documents")).rows.map((x) => x.storage_key);
    expect(keys.every((k) => k.startsWith(`documents/${ref}/`))).toBe(true);
    // Generating new documents now goes straight to SharePoint
    expect((await copyStorage(opts())).documents.copied).toBe(0);
  });

  it("rollback points everything back at the untouched source", async () => {
    await copyStorage(opts());
    const before = (await db.query("SELECT id, storage_key FROM documents ORDER BY id")).rows;
    await switchStorage("sharepoint");
    const r = await rollbackStorage("sharepoint");
    expect(r.documents).toBe((await db.query("SELECT count(*)::int AS n FROM storage_migrations WHERE object_kind = 'DOCUMENT' AND from_key <> to_key")).rows[0].n);
    expect((await db.query("SELECT id, storage_key FROM documents ORDER BY id")).rows).toEqual(before);
    const rm = await ctxFor("rm.ade@altbank.ng");
    const any = before[0];
    await expect(readDocumentForActor(rm, any.id, "download")).resolves.toBeDefined(); // served from the old store again
  });

  it("never copies a file that does not match its recorded checksum, and reports target failures", async () => {
    const victim = (await db.query("SELECT id FROM documents WHERE application_id = $1 ORDER BY uploaded_at LIMIT 1", [caseId])).rows[0].id;
    await db.query("UPDATE documents SET sha256 = $2 WHERE id = $1", [victim, "0".repeat(64)]);
    graph.failPutsMatching = /\/GENERATED_OFFER\//;
    const r = await copyStorage(opts());
    expect(r.failures.find((f) => f.id === victim)?.reason).toMatch(/recorded checksum/);
    expect(r.failures.some((f) => /HTTP 500/.test(f.reason))).toBe(true);
    await expect(switchStorage("sharepoint")).rejects.toThrow(/have not been copied yet/);
    // After the cause is fixed, a re-run copies only what failed
    graph.failPutsMatching = null;
    const r2 = await copyStorage(opts());
    expect(r2.failures.map((f) => f.id)).toEqual([victim]);
    expect(r2.documents.copied).toBeGreaterThan(0);
  });
});
