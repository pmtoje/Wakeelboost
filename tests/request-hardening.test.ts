import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/context";
import { bodyLimit, contentSecurityPolicy } from "@/middleware";
import { requestOtp } from "@/server/auth/otp";
import { setMailTransportForTests } from "@/server/notify/transport";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

const ctx = (): Ctx => ({ actor: null, now: new Date(), correlationId: "c-1", ip: "41.58.1.1", userAgent: "test" });

describe("request hardening (security review M1, M3, M14)", () => {
  it("limits request bodies by path before anything parses them", () => {
    expect(bodyLimit("/sign-in")).toBe(64 * 1024);
    expect(bodyLimit("/sign-in/verify")).toBe(64 * 1024);
    expect(bodyLimit("/requests/abc")).toBe(1024 * 1024);
    expect(bodyLimit("/requests/abc/sign/offer-letter")).toBe(4 * 1024 * 1024);
    expect(bodyLimit("/admin/directory")).toBe(11 * 1024 * 1024);
    expect(bodyLimit("/api/documents/upload")).toBe(16 * 1024 * 1024);
  });

  it("the Content-Security-Policy allows only this site's scripts carrying the request nonce", () => {
    const csp = contentSecurityPolicy("abc123", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(contentSecurityPolicy("x", true)).toContain("'unsafe-eval'"); // development build only
  });

  it("requesting a code does not wait for the email, so timing does not reveal staff addresses", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let sent = 0;
    setMailTransportForTests({
      name: "slow",
      async send() {
        sent++;
        await held; // a slow mail provider
        return { messageId: "x" };
      },
    });
    const t0 = Date.now();
    await requestOtp(ctx(), "co1@altbank.ng"); // known staff: returns while the email is still sending
    await requestOtp(ctx(), "nobody@altbank.ng"); // unknown
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sent).toBe(1);
    release();
  });
});
