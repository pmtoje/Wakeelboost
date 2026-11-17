/** In-memory Microsoft Graph for tests: token endpoint, site/drive lookup, file content, upload sessions. */
export class FakeGraph {
  files = new Map<string, Buffer>();
  tokens = 0;
  calls: string[] = [];
  throttleNext = 0;
  revoked = new Set<string>();
  failPutsMatching: RegExp | null = null;
  sessions = new Map<string, { path: string; parts: Buffer[] }>();

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
      const range = (init.headers as Record<string, string>)["content-range"]; // bytes a-b/total
      const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range)!.map(Number);
      if (end + 1 === total) this.files.set(s.path, Buffer.concat(s.parts));
      return new Response(null, { status: end + 1 === total ? 201 : 202 });
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
      this.sessions.set(uploadUrl, { path: item, parts: [] });
      return Response.json({ uploadUrl });
    }
    if (m[2]?.startsWith(":/content") && method === "PUT") {
      if (this.failPutsMatching?.test(item)) return new Response(null, { status: 500 });
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

export const SHAREPOINT_TEST_ENV = {
  SHAREPOINT_TENANT_ID: "tenant-1",
  SHAREPOINT_CLIENT_ID: "client-1",
  SHAREPOINT_CLIENT_SECRET: "test-only-placeholder",
  SHAREPOINT_SITE: "altbank.sharepoint.com:/sites/WakeelBoost",
};
