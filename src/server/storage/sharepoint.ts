import { config } from "../config";
import type { ObjectStore } from "./index";

/**
 * SharePoint document library as the document store (Microsoft Graph, app-only access).
 *
 * The app signs in with its own Entra ID app registration (client credentials) and should be granted
 * Sites.Selected on the WakeelBoost site only. Files are stored as ordinary SharePoint files, readable
 * by whoever the bank gives access to that library (bank decision, 17 Nov 2026); Microsoft encrypts
 * them at rest. WakeelBoost still decides who may open each file through the app, so the library's
 * own permissions must be limited to the app and named records/audit staff.
 *
 * Keys are paths inside the library under SHAREPOINT_ROOT_FOLDER, e.g.
 *   WakeelBoost/documents/WB-2026-001035/SIGNED_OFFER/Signed-Murabaha-offer-letter-v1-3f2a9c1e.pdf
 */
type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setSharePointFetchForTests(f: Fetch | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
  token = null;
  driveId = null;
}

const GRAPH = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // Graph: larger files need an upload session
const CHUNK = 320 * 1024 * 10; // upload-session chunks must be multiples of 320 KiB

let token: { value: string; expiresAt: number } | null = null;
let driveId: string | null = null;

export class SharePointError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

async function accessToken(): Promise<string> {
  const s = config.sharepoint;
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  const body = new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(s.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new SharePointError(`SharePoint sign-in failed (HTTP ${r.status}). Check the app registration and secret.`, r.status);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new SharePointError("SharePoint sign-in returned no access token.", r.status);
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token.value;
}

/** Graph call with the app token; retries throttling (429/503) honouring Retry-After. */
async function graph(path: string, init: RequestInit = {}, okMissing = false): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchImpl(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(60_000),
    });
    if ((r.status === 429 || r.status === 503) && attempt < 3) {
      const wait = Math.min(Number(r.headers.get("retry-after") ?? 2), 30) * 1000;
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (r.status === 401 && attempt === 0) {
      token = null; // expired early: sign in again once
      continue;
    }
    if (okMissing && r.status === 404) return r;
    if (!r.ok) throw new SharePointError(`SharePoint request failed (HTTP ${r.status}).`, r.status);
    return r;
  }
}

/** The document library's drive id, resolved once from SHAREPOINT_SITE (host:/sites/name) and SHAREPOINT_LIBRARY. */
async function drive(): Promise<string> {
  if (driveId) return driveId;
  const s = config.sharepoint;
  if (s.driveId) return (driveId = s.driveId);
  const [host, sitePath] = s.site.split(":");
  const site = (await (await graph(`/sites/${encodeURIComponent(host)}:${sitePath}`)).json()) as { id: string };
  const drives = (await (await graph(`/sites/${encodeURIComponent(site.id)}/drives`)).json()) as { value: { id: string; name: string }[] };
  const d = drives.value.find((x) => x.name.toLowerCase() === s.library.toLowerCase());
  if (!d) throw new SharePointError(`Document library "${s.library}" was not found on the SharePoint site.`, 404);
  return (driveId = d.id);
}

/** Item path for a key, each segment URL-encoded, under the root folder. */
function itemPath(key: string): string {
  if (!/^[a-zA-Z0-9/_. ()-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid object key");
  const full = `${config.sharepoint.rootFolder}/${key}`.split("/").filter(Boolean);
  return full.map(encodeURIComponent).join("/");
}

export class SharePointStore implements ObjectStore {
  readonly name = "sharepoint";

  async put(key: string, data: Buffer, contentType: string) {
    const d = await drive();
    const p = itemPath(key);
    if (data.length <= SIMPLE_UPLOAD_MAX) {
      await graph(`/drives/${d}/root:/${p}:/content?@microsoft.graph.conflictBehavior=replace`, { method: "PUT", headers: { "content-type": contentType || "application/octet-stream" }, body: new Uint8Array(data) });
      return;
    }
    const session = (await (
      await graph(`/drives/${d}/root:/${p}:/createUploadSession`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
      })
    ).json()) as { uploadUrl: string };
    for (let start = 0; start < data.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, data.length);
      // The upload URL is pre-authorised by Graph and must be called without the bearer token.
      const r = await fetchImpl(session.uploadUrl, {
        method: "PUT",
        headers: { "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${data.length}` },
        body: new Uint8Array(data.subarray(start, end)),
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw new SharePointError(`SharePoint upload failed (HTTP ${r.status}).`, r.status);
    }
  }

  async get(key: string) {
    const d = await drive();
    const r = await graph(`/drives/${d}/root:/${itemPath(key)}:/content`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Copy then delete, so the destination folder is created as needed. */
  async move(from: string, to: string) {
    const data = await this.get(from);
    await this.put(to, data, "application/octet-stream");
    await this.delete(from);
  }

  async delete(key: string) {
    const d = await drive();
    // Deleted items go to the site recycle bin; the library's retention policy must match the bank's.
    await graph(`/drives/${d}/root:/${itemPath(key)}`, { method: "DELETE" }, true);
  }
}
