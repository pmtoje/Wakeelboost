import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { SharePointStore, setSharePointFetchForTests } from "@/server/storage/sharepoint";
import { objectStore, setObjectStoreForTests } from "@/server/storage";
import { readDocumentForActor, uploadDocument } from "@/server/domain/documents";
import { liveOfferLetter, processDueOfferLetters } from "@/server/domain/offer-letters";
import { assertProductionConfig } from "@/server/config";
import { createSubmittedCase, ctxFor, driveToOffer, makePdf } from "@/server/demo/scenario";
import { resetDb } from "./helpers";

/** In-memory Microsoft Graph: token endpoint, site/drive lookup, file content, upload sessions. */
class FakeGraph {
  files = new Map<string, Buffer>();
  tokens = 0;
  calls: string[] = [];
  throttleNext = 0;
  revoked = new Set<string>();
  sessions = new Map<string, { path: string; parts: Buffer[]; size: number }>();
  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
    if (url.includes("login.microsoftonline.com")) {
      this.tokens++;
      return Response.json({ access_token: `tok-${this.tokens}`, expires_in: 3600 });
    }
    if (url.startsWith("https://upload.example/")) {
      const s = this.sessions.get(url)!;
      s.parts.push(Buffer.from(init.body as Uint8Array));
      const got = s.parts.reduce((a, p) => a + p.length, 0);
      if (got >= s.size) this.files.set(s.path, Buffer.concat(s.parts));
      return new Response(null, { status: got >= s.size ? 201 : 202 });
    }
    const auth = (init.headers as Record<string, string>)?.authorization ?? "";
    if (!auth.startsWith("Bearer tok-") || this.revoked.has(auth.slice(7))) return new Response(null, { status: 401 });
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    }
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    if (path.startsWith("/sites/") && !path.includes("/drives")) return Response.json({ id: "site-1" });
    if (path.endsWith("/drives")) return Response.json({ value: [{ id: "drive-x", name: "Other" }, { id: "drive-1", name: "Documents" }] });
    const m = /^\/drives\/drive-1\/root:\/(.+?)(:\/content(\?.*)?|:\/createUploadSession)?$/.exec(path);
    if (!m) return new Response(null, { status: 400 });
    const item = decodeURIComponent(m[1]);
    if (m[2]?.startsWith(":/createUploadSession")) {
      const uploadUrl = `https://upload.example/${this.sessions.size + 1}`;
      this.sessions.set(uploadUrl, { path: item, parts: [], size: 0 });
      // size learned from the first chunk's content-range
      const s = this.sessions.get(uploadUrl)!;
      const orig = this.fetch;
      void orig;
      s.size = Number.POSITIVE_INFINITY;
      return Response.json({ uploadUrl });
    }
    if (m[2]?.startsWith(":/content") && method === "PUT") {
      this.files.set(item, Buffer.from(init.body as Uint8Array));
      return Response.json({ id: "item" }, { status: 201 });
    }
    if (m[2]?.startsWith(":/content")) {
      const f = this.files.get(item);
      return f ? new Response(new Uint8Array(f)) : new Response(null, { status: 404 });
    }
    if (method === "DELETE") return new Response(null, { status: this.files.delete(item) ? 204 : 404 });
    return new Response(null, { status: 400 });
  };
}

const ENV = {
  SHAREPOINT_TENANT_ID: "tenant-1",
  SHAREPOINT_CLIENT_ID: "client-1",
  SHAREPOINT_CLIENT_SECRET: "test-only-placeholder",
  SHAREPOINT_SITE: "altbank.sharepoint.com:/sites/WakeelBoost",
};
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
    // size the fake session from the data length
    const realFetch = graph.fetch;
    graph.fetch = async (input, init) => {
      const r = await realFetch(input, init);
      const url = String(input);
      if (url.includes("createUploadSession")) {
        const j = (await r.clone().json()) as { uploadUrl: string };
        graph.sessions.get(j.uploadUrl)!.size = big.length;
      }
      return r;
    };
    setSharePointFetchForTests(graph.fetch as typeof fetch);
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
});
