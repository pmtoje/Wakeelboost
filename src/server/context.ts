import { randomUUID } from "node:crypto";
import { config } from "./config";

export interface Actor {
  staffId: string;
  email: string;
  name: string;
  sessionId?: string | null;
  activeRole?: string | null;
}

/** Request context passed to every domain operation. */
export interface Ctx {
  actor: Actor | null;
  now: Date;
  correlationId: string;
  ip: string | null;
  userAgent: string | null;
}

export function systemCtx(now = new Date()): Ctx {
  return { actor: null, now, correlationId: `job-${randomUUID()}`, ip: null, userAgent: "system/worker" };
}

/**
 * Determine the client IP. Next.js keeps an X-Forwarded-For header the client sent, so only entries
 * appended by our own reverse proxies can be trusted: with N trusted proxies, the client address is
 * the Nth entry from the right (the one the outermost trusted proxy appended). Production requires
 * TRUSTED_PROXY_HOPS >= 1 (see assertProductionConfig). With 0 hops (local development) the last
 * entry is used, which Next.js fills with the socket address when the client sent none.
 * X-Real-IP is used only behind a trusted proxy that sets it, when X-Forwarded-For is absent.
 */
export function clientIpFromHeaders(get: (name: string) => string | null, hops = config.trustedProxyHops): string | null {
  const xff = get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const ip = parts[parts.length - Math.max(1, hops)];
    if (ip) return normaliseIp(ip);
    return null;
  }
  if (hops >= 1) {
    const real = get("x-real-ip");
    return real ? normaliseIp(real) : null;
  }
  return null;
}
function normaliseIp(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

/** Very small UA summariser: "Chrome 130 on Windows (desktop)". */
export function describeDevice(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (ua.startsWith("system/")) return "system";
  const browser =
    match(ua, /Edg\/(\d+)/, "Edge") ??
    match(ua, /OPR\/(\d+)/, "Opera") ??
    match(ua, /Firefox\/(\d+)/, "Firefox") ??
    match(ua, /Chrome\/(\d+)/, "Chrome") ??
    match(ua, /Version\/(\d+).*Safari/, "Safari") ??
    (/HeadlessChrome/.test(ua) ? "HeadlessChrome" : null) ??
    "Unknown browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  const form = /Mobile|iPhone|Android/.test(ua) ? "mobile" : /iPad|Tablet/.test(ua) ? "tablet" : "desktop";
  return `${browser} on ${os} (${form})`;
}
function match(ua: string, re: RegExp, name: string): string | null {
  const m = re.exec(ua);
  return m ? `${name} ${m[1]}` : null;
}
