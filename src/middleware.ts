import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware:
 *  - assigns a request correlation id and exposes the request path to server components (for
 *    post-login deep links). Authentication is enforced server-side in every page, action and route
 *    handler against the database session;
 *  - rejects oversized request bodies by path before anything parses them (security review M3);
 *  - sets a per-request Content-Security-Policy with a script nonce (security review M1). Next.js
 *    reads the nonce from the request header and applies it to its own scripts.
 */
const MB = 1024 * 1024;
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES || 15 * MB);

/** Largest request body accepted for a path (bytes). */
export function bodyLimit(pathname: string): number {
  if (pathname.startsWith("/api/documents/upload")) return MAX_UPLOAD + MB; // file + form fields
  if (pathname.startsWith("/sign-in")) return 64 * 1024; // email and one-time code only
  if (pathname.startsWith("/admin")) return 11 * MB; // directory import (10 MB) and Word templates
  if (/^\/requests\/[^/]+\/sign\//.test(pathname)) return 4 * MB; // tablet signatures (PNG)
  return 1 * MB;
}

export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
    const len = req.headers.get("content-length");
    const limit = bodyLimit(path);
    if (len !== null && Number(len) > limit) {
      return NextResponse.json({ ok: false, error: `The request is too large (limit ${Math.round(limit / 1024)} KB).` }, { status: 413 });
    }
    if (len === null && path.startsWith("/api/documents/upload")) {
      return NextResponse.json({ ok: false, error: "Upload length required." }, { status: 411 });
    }
  }
  const headers = new Headers(req.headers);
  const incoming = req.headers.get("x-correlation-id");
  const correlationId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  headers.set("x-correlation-id", correlationId);
  headers.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  // API routes set their own headers (document downloads carry a sandbox CSP for HTML files).
  const csp = path.startsWith("/api/") ? null : contentSecurityPolicy(btoa(crypto.randomUUID()), process.env.NODE_ENV === "development");
  if (csp) {
    headers.set("x-nonce", csp.match(/'nonce-([^']+)'/)![1]);
    headers.set("Content-Security-Policy", csp);
  }
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-correlation-id", correlationId);
  if (csp) res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
