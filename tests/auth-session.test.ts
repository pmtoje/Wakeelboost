import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import type { Ctx } from "@/server/context";
import { requestOtp, verifyOtp, GENERIC_OTP_MESSAGE } from "@/server/auth/otp";
import { lookupSession, switchWorkspace } from "@/server/auth/session";
import { setMailTransportForTests } from "@/server/notify/transport";
import { safeNext } from "@/lib/paths";
import { audits, outbox, resetDb, staffId } from "./helpers";
import { clientIpFromHeaders } from "@/server/context";
import { rateLimit } from "@/server/auth/rateLimit";
import { unlockSignIn } from "@/server/domain/admin";
import { ctxFor } from "@/server/demo/scenario";

let sent: { to: string[]; text: string }[] = [];
beforeEach(async () => {
  await resetDb();
  sent = [];
  setMailTransportForTests({
    name: "capture",
    async send(m) {
      sent.push({ to: m.to, text: m.text });
      return { messageId: "x" };
    },
  });
});

const ctxAt = (now: Date, ip = "41.58.1.1"): Ctx => ({ actor: null, now, correlationId: "c-1", ip, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1" });
const codeFrom = () => /code is: (\d{8})/.exec(sent.at(-1)!.text)![1];

async function signIn(email: string, now: Date, role?: string) {
  await requestOtp(ctxAt(now), email);
  return verifyOtp(ctxAt(now), email, codeFrom(), role);
}

describe("OTP sign-in", () => {
  it("issues a single-use code stored only as a hash and creates a server session", async () => {
    const now = new Date();
    const r = await requestOtp(ctxAt(now), "RM.Ade@altbank.ng");
    expect(r.message).toBe(GENERIC_OTP_MESSAGE);
    const code = codeFrom();
    const row = (await db.query("SELECT * FROM otp_challenges")).rows[0];
    expect(row.code_hash).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_outbox")).rows[0].n).toBe(0); // never persisted
    const login = await verifyOtp(ctxAt(now), "rm.ade@altbank.ng", code, "RM");
    expect(login.activeRole).toBe("RM");
    await expect(verifyOtp(ctxAt(now), "rm.ade@altbank.ng", code)).rejects.toThrow(/invalid or has expired/);
    const audit = (await audits("LOGIN")).filter((a) => a.outcome === "SUCCESS");
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("does not reveal whether an email is provisioned", async () => {
    const now = new Date();
    const a = await requestOtp(ctxAt(now), "nobody@altbank.ng");
    const b = await requestOtp(ctxAt(now), "someone@gmail.com");
    const c = await requestOtp(ctxAt(now), "co1@altbank.ng");
    expect(a).toEqual(c);
    expect(b).toEqual(c);
    expect(sent).toHaveLength(1);
  });

  it("expires codes and locks after too many wrong attempts", async () => {
    const now = new Date();
    await requestOtp(ctxAt(now), "co1@altbank.ng");
    const code = codeFrom();
    await expect(verifyOtp(ctxAt(new Date(now.getTime() + 301_000)), "co1@altbank.ng", code)).rejects.toThrow();
    await requestOtp(ctxAt(now), "co1@altbank.ng");
    const code2 = codeFrom();
    for (let i = 0; i < 5; i++) await expect(verifyOtp(ctxAt(now), "co1@altbank.ng", "00000000" === code2 ? "11111111" : "00000000")).rejects.toThrow();
    await expect(verifyOtp(ctxAt(now), "co1@altbank.ng", code2)).rejects.toThrow(/invalid or has expired/);
  });

  it("rate limits issuance", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) await requestOtp(ctxAt(now), "co2@altbank.ng");
    await expect(requestOtp(ctxAt(now), "co2@altbank.ng")).rejects.toThrow(/Too many/);
  });

  it("a requested workspace never grants a role the user does not hold", async () => {
    const login = await signIn("co1@altbank.ng", new Date(), "RM");
    expect(login.activeRole).toBe("CREDIT_OFFICER_1");
  });
});

describe("five-minute inactivity timeout (every role)", () => {
  it.each(["superadmin@altbank.ng", "rm.ade@altbank.ng", "co3@altbank.ng", "do2@altbank.ng", "reports@altbank.ng", "legal.officer@altbank.ng"])(
    "%s expires after 5 idle minutes and needs a fresh OTP",
    async (email) => {
      const t0 = new Date("2026-05-04T09:00:00Z");
      const login = await signIn(email, t0);
      const at = (s: number) => ctxAt(new Date(t0.getTime() + s * 1000));
      expect((await lookupSession(login.token, at(299), { touch: false })).status).toBe("ok");
      const r = await lookupSession(login.token, at(300), { touch: true });
      expect(r).toEqual({ status: "expired", reason: "IDLE_TIMEOUT" });
      // stays expired even if the user comes back
      expect((await lookupSession(login.token, at(301), { touch: true })).status).toBe("expired");
      const timeout = await audits("SESSION_TIMEOUT");
      expect(timeout).toHaveLength(1);
    },
  );

  it("user activity extends the session; background polling does not", async () => {
    const t0 = new Date("2026-05-04T09:00:00Z");
    const login = await signIn("co1@altbank.ng", t0);
    const at = (s: number) => ctxAt(new Date(t0.getTime() + s * 1000));
    expect((await lookupSession(login.token, at(200), { touch: true })).status).toBe("ok"); // user click
    // polling at 400s and 480s (no touch) must not extend
    expect((await lookupSession(login.token, at(400), { touch: false })).status).toBe("ok");
    expect((await lookupSession(login.token, at(480), { touch: false })).status).toBe("ok");
    expect((await lookupSession(login.token, at(500), { touch: false })).status).toBe("expired");
  });

  it("workspace switching preserves identity in audit history", async () => {
    const t0 = new Date();
    const login = await signIn("mo.chi@altbank.ng", t0, "MERCHANT_OFFICER");
    const s = await lookupSession(login.token, ctxAt(t0), { touch: true });
    if (s.status !== "ok") throw new Error("no session");
    const ctx: Ctx = { ...ctxAt(t0), actor: { staffId: s.session.staffId, email: s.session.email, name: s.session.fullName, sessionId: s.session.sessionId, activeRole: s.session.activeRole } };
    await switchWorkspace(ctx, s.session.sessionId, "RM");
    await expect(switchWorkspace(ctx, s.session.sessionId, "UNIT_HEAD")).rejects.toThrow(/do not hold/);
    const ev = await audits("WORKSPACE_SWITCH");
    expect(ev[0].actor_id).toBe(s.session.staffId);
    expect(ev[0].details).toMatchObject({ from: "MERCHANT_OFFICER", to: "RM" });
    expect(ev[1].outcome).toBe("DENIED");
    const after = await lookupSession(login.token, ctxAt(t0), { touch: false });
    expect(after.status === "ok" && after.session.activeRole).toBe("RM");
  });

  it("suspending staff ends their sessions", async () => {
    const { setStaffStatus } = await import("@/server/domain/admin");
    const { ctxFor } = await import("@/server/demo/scenario");
    const t0 = new Date();
    const login = await signIn("co2@altbank.ng", t0);
    await setStaffStatus(await ctxFor("superadmin@altbank.ng"), login.staffId, "SUSPENDED");
    expect((await lookupSession(login.token, ctxAt(t0), { touch: true })).status).toBe("expired");
  });
});

describe("deep links", () => {
  it("only allows same-origin application paths after authentication", () => {
    expect(safeNext("/requests/abc?task=t1")).toBe("/requests/abc?task=t1");
    expect(safeNext("//evil.com")).toBe("/queue");
    expect(safeNext("https://evil.com")).toBe("/queue");
    expect(safeNext("/\\evil.com")).toBe("/queue");
    expect(safeNext("/api/documents/x")).toBe("/queue");
    expect(safeNext(null)).toBe("/queue");
  });
});

describe("sign-in hardening (security review H1)", () => {
  const wrong = (code: string) => (code === "00000000" ? "11111111" : "00000000");

  it("issues 8-digit codes", async () => {
    await requestOtp(ctxAt(new Date()), "co1@altbank.ng");
    expect(codeFrom()).toMatch(/^\d{8}$/);
  });

  it("locks an account after 10 wrong codes across several codes, alerts Super Admins, and a Super Admin can unlock it", async () => {
    const now = new Date();
    for (let round = 0; round < 2; round++) {
      await requestOtp(ctxAt(now, `10.0.0.${round}`), "co1@altbank.ng");
      const code = codeFrom();
      for (let i = 0; i < 5; i++) await expect(verifyOtp(ctxAt(now, `10.0.1.${i}`), "co1@altbank.ng", wrong(code))).rejects.toThrow();
    }
    // A new code cannot be requested, and even a correct code would be refused.
    await expect(requestOtp(ctxAt(now), "co1@altbank.ng")).rejects.toThrow(/locked/);
    await expect(verifyOtp(ctxAt(now), "co1@altbank.ng", "12345678")).rejects.toThrow(/locked/);
    expect((await audits("SIGNIN_LOCKED")).length).toBe(1);
    const alert = (await outbox("SECURITY_ALERT"))[0];
    expect(alert.to_addresses).toContain("paul.toje@altbank.ng");
    expect(alert.body_text).not.toContain("co1@altbank.ng"); // masked
    // Super Admin unlocks; the staff member signs in normally.
    await unlockSignIn(await ctxFor("superadmin@altbank.ng"), await staffId("co1@altbank.ng"));
    const login = await signIn("co1@altbank.ng", now);
    expect(login.token).toBeTruthy();
    expect((await audits("SIGNIN_UNLOCKED")).length).toBe(1);
  });

  it("a staff member cannot unlock their own sign-in, and only Super Admins can unlock", async () => {
    await expect(unlockSignIn(await ctxFor("superadmin@altbank.ng"), await staffId("superadmin@altbank.ng"))).rejects.toThrow(/own sign-in/);
    await expect(unlockSignIn(await ctxFor("co2@altbank.ng"), await staffId("co1@altbank.ng"))).rejects.toThrow();
  });

  it("the rate limiter holds under parallel requests", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 12 }, () => rateLimit(db, "parallel-test", 5, 900, now)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("takes the client IP only from what the trusted proxy appended", () => {
    const h = (xff: string | null, real: string | null = null) => (n: string) => (n === "x-forwarded-for" ? xff : n === "x-real-ip" ? real : null);
    // Behind one proxy: the client cannot choose its address by sending its own header.
    expect(clientIpFromHeaders(h("6.6.6.6, 41.58.1.1"), 1)).toBe("41.58.1.1");
    expect(clientIpFromHeaders(h("6.6.6.6, 41.58.1.1, 10.0.0.2"), 2)).toBe("41.58.1.1");
    expect(clientIpFromHeaders(h(null, "41.58.1.9"), 1)).toBe("41.58.1.9");
    // No trusted proxy (development): X-Real-IP is never trusted.
    expect(clientIpFromHeaders(h(null, "41.58.1.9"), 0)).toBeNull();
    expect(clientIpFromHeaders(h("::ffff:127.0.0.1"), 0)).toBe("127.0.0.1");
  });
});

