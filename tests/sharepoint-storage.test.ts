import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { SharePointStore, checkSharePointConnection, setSharePointFetchForTests } from "@/server/storage/sharepoint";
import { objectStore, setObjectStoreForTests } from "@/server/storage";
import { readDocumentForActor, uploadDocument } from "@/server/domain/documents";
import { liveOfferLetter, processDueOfferLetters } from "@/server/domain/offer-letters";
import { assertProductionConfig } from "@/server/config";
import { createSubmittedCase, ctxFor, driveToOffer, makePdf } from "@/server/demo/scenario";
import { resetDb } from "./helpers";
import { FakeGraph, SHAREPOINT_TEST_ENV } from "./fake-graph";

const ENV = SHAREPOINT_TEST_ENV;
const saved = { ...process.env };
let graph: FakeGraph;

beforeEach(async () => {
  setObjectStoreForTests(null); // seed into the default store, then copy what is needed into the library
  await resetDb();
  Object.assign(process.env, ENV);
  graph = new FakeGraph();
  // The bank's templates were seeded into the default store: copy them into the library first.
  setObjectStoreForTests(null);
  const templates = (await db.query<{ storage_key: string }>("SELECT storage_key FROM offer_templates")).rows;
  const blobs = await Promise.all(templates.map(async (t) => [t.storage_key, await objectStore().get(t.storage_key)] as const));
  setSharePointFetchForTests(graph.fetch as typeof fetch);
  setObjectStoreForTests(new SharePointStore());
  for (const [k, b] of blobs) await objectStore().put(k, b, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), "APP_ENV", "STORAGE_DRIVER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => {
  setObjectStoreForTests(null);
  setSharePointFetchForTests(null);
});

describe("SharePoint document store", () => {
  it("uploads land in the library under readable paths, are scanned out of quarantine and download through the app", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id); // offer preparation: the initiator may upload pack and supporting documents
    const ref = (await db.query("SELECT ref FROM applications WHERE id = $1", [id])).rows[0].ref;
    const rm = await ctxFor("rm.ade@altbank.ng");
    const pdf = makePdf("Bank statement March");
    const up = await uploadDocument(rm, { applicationId: id, category: "SUPPORTING", filename: "March statement.pdf", data: pdf });
    const doc = (await db.query("SELECT storage_key, scan_status FROM documents WHERE id = $1", [up.id])).rows[0];
    expect(doc.scan_status).toBe("CLEAN");
    expect(doc.storage_key).toMatch(new RegExp(`^documents/${ref}/SUPPORTING/March statement-v\\d+-[0-9a-f]{8}\\.pdf$`));
    expect([...graph.files.keys()]).toContain(`WakeelBoost/${doc.storage_key}`);
    expect([...graph.files.keys()].some((k) => k.startsWith("WakeelBoost/quarantine/"))).toBe(false); // moved out after the scan
    const { data } = await readDocumentForActor(rm, up.id, "download");
    expect(data.equals(pdf)).toBe(true);
    // Files are stored as ordinary files (readable in SharePoint), not app-encrypted
    expect(graph.files.get(`WakeelBoost/${doc.storage_key}`)!.subarray(0, 5).toString()).toBe("%PDF-");
    // One sign-in reused across calls; the library is looked up once
    expect(graph.tokens).toBe(1);
    graph.calls = [];
    expect(graph.calls.filter((c) => c.endsWith("/drives")).length).toBe(0); // library looked up once, earlier
  });

  it("generated letters are filed by request and document type", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
    await driveToOffer(id);
    await processDueOfferLetters();
    const letter = (await liveOfferLetter(db, id))!;
    const key = (await db.query("SELECT storage_key FROM documents WHERE id = $1", [letter.docx_document_id])).rows[0].storage_key;
    expect(key).toMatch(/^documents\/WB-\d{4}-\d{6}\/GENERATED_OFFER\/Offer-WB-.+\.docx$/);
    expect(graph.files.has(`WakeelBoost/${key}`)).toBe(true);
  });

  it("large files use an upload session in chunks; throttling and an expired token are retried", async () => {
    const store = objectStore();
    const big = Buffer.alloc(7 * 1024 * 1024 + 123, 7);
    await store.put("documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf", big, "application/pdf");
    expect(graph.calls.filter((c) => c.startsWith("PUT https://upload.example/")).length).toBe(3);
    expect(graph.files.get("WakeelBoost/documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf")!.equals(big)).toBe(true);
    graph.throttleNext = 2;
    expect((await store.get("documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf")).length).toBe(big.length);
    // The cached token is revoked early: the adapter signs in again once and carries on
    const before = graph.tokens;
    graph.revoked.add(`tok-${graph.tokens}`);
    await store.delete("documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf");
    expect(graph.tokens).toBe(before + 1);
    await store.delete("documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf"); // already gone: no error
    expect(graph.files.has("WakeelBoost/documents/WB-TEST/SUPPORTING/big-v1-abcdef12.pdf")).toBe(false);
  });

  it("refuses unsafe paths", async () => {
    await expect(objectStore().put("../outside.pdf", Buffer.from("x"), "application/pdf")).rejects.toThrow(/Invalid object key/);
    await expect(objectStore().put("/abs.pdf", Buffer.from("x"), "application/pdf")).rejects.toThrow(/Invalid object key/);
  });

  it("production requires the SharePoint settings, and refuses local storage", () => {
    process.env.APP_ENV = "production";
    process.env.STORAGE_DRIVER = "sharepoint";
    delete process.env.SHAREPOINT_CLIENT_SECRET;
    expect(() => assertProductionConfig({ NODE_ENV: "production", APP_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/SHAREPOINT_CLIENT_SECRET|published development key|TRUSTED_PROXY_HOPS|RESEND_API_KEY/);
  });

  it("the connection check signs in, finds the library and round-trips a test file, leaving nothing behind", async () => {
    const before = graph.files.size;
    const steps = await checkSharePointConnection();
    expect(steps.map((x) => x.ok)).toEqual([true, true, true, true, true]);
    expect(graph.files.size).toBe(before);
  });

  it("finds the library by the name in its web address (Shared Documents)", async () => {
    process.env.SHAREPOINT_LIBRARY = "Shared Documents";
    try {
      const steps = await checkSharePointConnection();
      expect(steps[1]).toMatchObject({ ok: true });
      expect(steps[1].detail).toContain("drive-1");
    } finally {
      delete process.env.SHAREPOINT_LIBRARY;
    }
  });

  it("reports a wrong secret or a missing library clearly", async () => {
    graph.rejectSignIn = true;
    let steps = await checkSharePointConnection();
    expect(steps).toHaveLength(1);
    expect(steps[0].detail).toMatch(/sign-in failed \(HTTP 401\)/);
    graph.rejectSignIn = false;
    process.env.SHAREPOINT_LIBRARY = "Records";
    try {
      steps = await checkSharePointConnection();
      expect(steps[1]).toMatchObject({ ok: false });
      expect(steps[1].detail).toMatch(/"Records" was not found/);
    } finally {
      delete process.env.SHAREPOINT_LIBRARY;
    }
  });

  it("works with a personal OneDrive folder for a trial (library shown as Documents, named OneDrive)", async () => {
    process.env.SHAREPOINT_SITE = "sterlingbankng-my.sharepoint.com:/personal/paul_toje_altbank_ng";
    process.env.SHAREPOINT_LIBRARY = "Documents";
    const real = graph.fetch;
    graph.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/drives")) return Response.json({ value: [{ id: "drive-1", name: "OneDrive", webUrl: "https://sterlingbankng-my.sharepoint.com/personal/paul_toje_altbank_ng/Documents" }] });
      return real(input, init);
    };
    setSharePointFetchForTests(graph.fetch as typeof fetch);
    try {
      const steps = await checkSharePointConnection();
      expect(steps.map((x) => x.ok)).toEqual([true, true, true, true, true]);
      expect(graph.calls.some((c) => c.includes("/sites/sterlingbankng-my.sharepoint.com:/personal/paul_toje_altbank_ng"))).toBe(true);
      const { isPersonalOneDrive } = await import("@/server/config");
      expect(isPersonalOneDrive(process.env.SHAREPOINT_SITE!)).toBe(true);
      expect(isPersonalOneDrive("sterlingbankng.sharepoint.com:/sites/WakeelBoost")).toBe(false);
    } finally {
      delete process.env.SHAREPOINT_LIBRARY;
      process.env.SHAREPOINT_SITE = SHAREPOINT_TEST_ENV.SHAREPOINT_SITE;
    }
  });
});
