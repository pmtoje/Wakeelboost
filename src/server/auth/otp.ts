import { db, withTx } from "../db";
import type { Ctx } from "../context";
import { audit, auditOutsideTx } from "../audit";
import { config } from "../config";
import { hmac, randomOtp, safeEqualHex } from "../crypto";
import { DomainError } from "../errors";
import { maskEmail } from "../mask";
import { mailTransport } from "../notify/transport";
import { simpleEmail } from "../notify/templates";
import { countEvents, rateLimit, recordEvent } from "./rateLimit";
import { enqueueEmail } from "../notify/outbox";
import { lagosDate } from "../time";
import { createSession } from "./session";

export const GENERIC_OTP_MESSAGE = "If this email belongs to provisioned WakeelBoost staff, a one-time code has been sent to it.";

export function normaliseEmail(e: string) {
  return e.trim().toLowerCase();
}
const emailHash = (email: string) => hmac(`email:${normaliseEmail(email)}`);
const codeHash = (challengeId: string, code: string) => hmac(`otp:${challengeId}:${code}`);

const DAY = 86_400;
export const LOCKED_MESSAGE = "Sign-in is locked for this account after repeated wrong codes. Ask a WakeelBoost Super Admin to unlock it, or try again in 24 hours.";
const failBucket = (eh: string) => `otp-fail:${eh}`;

/** Locked after too many wrong codes (across all codes) in the last 24 hours. */
async function signInLocked(eh: string, now: Date): Promise<boolean> {
  return (await countEvents(db, failBucket(eh), DAY, now)) >= config.otpLockFailures;
}

/** Super Admins, for security alerts. */
async function superAdminEmails(): Promise<string[]> {
  return (
    await db.query<{ email: string }>(
      "SELECT DISTINCT s.email FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active AND ra.role = 'SUPER_ADMIN' WHERE s.status = 'ACTIVE' ORDER BY s.email",
    )
  ).rows.map((r) => r.email);
}

/** Record a wrong code: lock the account at the threshold and alert Super Admins; alert on bank-wide spikes. */
async function recordFailure(ctx: Ctx, eh: string, email: string, staffId: string | null) {
  await recordEvent(db, failBucket(eh), ctx.now);
  await recordEvent(db, "otp-fail-all", ctx.now);
  const fails = await countEvents(db, failBucket(eh), DAY, ctx.now);
  const admins = await superAdminEmails();
  if (fails === config.otpLockFailures) {
    await db.query("UPDATE otp_challenges SET consumed_at = $2 WHERE email_hash = $1 AND consumed_at IS NULL", [eh, ctx.now]);
    await auditOutsideTx(ctx, { action: "SIGNIN_LOCKED", outcome: "FAILURE", actorId: staffId, actorEmail: maskEmail(email), reason: `${fails} wrong codes in 24 hours` });
    if (admins.length)
      await enqueueEmail(db, ctx.now, {
        kind: "SECURITY_ALERT",
        dedupeKey: `signin-locked:${eh}:${lagosDate(ctx.now)}`,
        to: admins,
        subject: "WakeelBoost security alert: a staff sign-in was locked",
        text: simpleEmail([
          `Sign-in for ${maskEmail(email)} was locked after ${fails} wrong one-time codes in 24 hours.`,
          `Last attempt from IP ${ctx.ip ?? "unknown"} at ${ctx.now.toISOString()}.`,
          "If the staff member did not cause this, treat it as an attempt to guess their code and inform Information Security.",
          "To unlock: Administration > Staff > Unlock sign-in.",
        ]),
      });
  }
  const hour = await countEvents(db, "otp-fail-all", 3600, ctx.now);
  if (hour === config.otpGlobalAlertPerHour && admins.length) {
    await auditOutsideTx(ctx, { action: "SIGNIN_FAILURE_SPIKE", outcome: "FAILURE", reason: `${hour} wrong codes across all accounts in one hour` });
    await enqueueEmail(db, ctx.now, {
      kind: "SECURITY_ALERT",
      dedupeKey: `signin-spike:${ctx.now.toISOString().slice(0, 13)}`,
      to: admins,
      subject: "WakeelBoost security alert: unusual number of failed sign-ins",
      text: simpleEmail([`${hour} wrong one-time codes were entered across all accounts in the last hour.`, "This can indicate an attempt to guess staff sign-in codes. Inform Information Security."]),
    });
  }
}

/** Super Admin: clear an account's sign-in lock. */
export async function clearSignInLock(email: string): Promise<void> {
  await db.query("DELETE FROM rate_limit_events WHERE bucket = $1", [failBucket(emailHash(email))]);
}
export async function isSignInLocked(email: string, now = new Date()): Promise<boolean> {
  return signInLocked(emailHash(email), now);
}

/**
 * Issue a short-lived, single-use OTP. The response never reveals whether the email exists.
 * Codes are stored only as HMACs. The email body containing the code is sent directly through
 * the mail transport and is never persisted in the outbox.
 */
export async function requestOtp(ctx: Ctx, rawEmail: string): Promise<{ message: string }> {
  const email = normaliseEmail(rawEmail);
  const eh = emailHash(email);
  const okEmail = await rateLimit(db, `otp-issue:${eh}`, config.otpIssueLimit, 900, ctx.now);
  const okIp = await rateLimit(db, `otp-issue-ip:${ctx.ip ?? "unknown"}`, config.otpIssueLimit * 6, 900, ctx.now);
  if (!okEmail || !okIp) {
    await auditOutsideTx(ctx, { action: "OTP_REQUEST", outcome: "DENIED", reason: "rate_limited", actorEmail: maskEmail(email), actorId: null });
    throw new DomainError("RATE_LIMITED", "Too many sign-in attempts. Wait a few minutes and try again.");
  }
  if (await signInLocked(eh, ctx.now)) {
    await auditOutsideTx(ctx, { action: "OTP_REQUEST", outcome: "DENIED", reason: "signin_locked", actorEmail: maskEmail(email), actorId: null });
    throw new DomainError("RATE_LIMITED", LOCKED_MESSAGE);
  }
  const domainOk = email.endsWith(`@${config.staffEmailDomain}`);
  const staff = domainOk
    ? (
        await db.query<{ id: string; full_name: string }>(
          `SELECT s.id, s.full_name FROM staff s WHERE s.email = $1 AND s.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM role_assignments ra WHERE ra.staff_id = s.id AND ra.active)`,
          [email],
        )
      ).rows[0]
    : undefined;
  if (!staff) {
    await auditOutsideTx(ctx, { action: "OTP_REQUEST", outcome: "DENIED", reason: "unknown_or_inactive", actorEmail: maskEmail(email), actorId: null });
    return { message: GENERIC_OTP_MESSAGE };
  }
  const code = randomOtp();
  const challenge = await withTx(async (tx) => {
    // Invalidate earlier unconsumed codes for this email.
    await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE email_hash = $1 AND consumed_at IS NULL", [eh, ctx.now]);
    const c = await tx.query<{ id: string }>(
      `INSERT INTO otp_challenges (email_hash, staff_id, code_hash, ip, created_at, expires_at) VALUES ($1,$2,'pending',$3,$4,$5) RETURNING id`,
      [eh, staff.id, ctx.ip, ctx.now, new Date(ctx.now.getTime() + config.otpTtlSeconds * 1000)],
    );
    await tx.query("UPDATE otp_challenges SET code_hash = $2 WHERE id = $1", [c.rows[0].id, codeHash(c.rows[0].id, code)]);
    await audit(tx, ctx, { action: "OTP_REQUEST", actorId: staff.id, actorEmail: email, details: { challengeId: c.rows[0].id } });
    return c.rows[0].id;
  });
  try {
    await mailTransport().send({
      to: [email],
      cc: [],
      subject: "Your WakeelBoost Work Desk sign-in code",
      text: simpleEmail([
        `Your one-time sign-in code is: ${code}`,
        `It expires in ${Math.round(config.otpTtlSeconds / 60)} minutes and can be used once.`,
        "If you did not request this code, contact Information Security.",
      ]),
      attachments: [],
    });
    await auditOutsideTx(ctx, { action: "EMAIL_SENT", actorId: staff.id, actorEmail: email, details: { kind: "OTP", challengeId: challenge } });
  } catch (err) {
    await auditOutsideTx(ctx, { action: "EMAIL_FAILED", outcome: "FAILURE", actorId: staff.id, actorEmail: email, details: { kind: "OTP", error: String(err).slice(0, 200) } });
  }
  return { message: GENERIC_OTP_MESSAGE };
}

export interface VerifiedLogin {
  token: string;
  sessionId: string;
  staffId: string;
  activeRole: string | null;
}

export async function verifyOtp(ctx: Ctx, rawEmail: string, code: string, preferredRole?: string | null): Promise<VerifiedLogin> {
  const email = normaliseEmail(rawEmail);
  const eh = emailHash(email);
  const fail = new DomainError("UNAUTHENTICATED", "The code is invalid or has expired. Request a new code.");
  const okIp = await rateLimit(db, `otp-verify-ip:${ctx.ip ?? "unknown"}`, 50, 900, ctx.now);
  if (!okIp) throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a few minutes and try again.");
  if (await signInLocked(eh, ctx.now)) {
    await auditOutsideTx(ctx, { action: "LOGIN", outcome: "DENIED", reason: "signin_locked", actorEmail: maskEmail(email), actorId: null });
    throw new DomainError("RATE_LIMITED", LOCKED_MESSAGE);
  }
  code = code.replace(/\s+/g, "");
  if (!/^\d{8}$/.test(code)) {
    await auditOutsideTx(ctx, { action: "LOGIN", outcome: "DENIED", reason: "malformed_code", actorEmail: maskEmail(email), actorId: null });
    throw fail;
  }
  const result = await withTx(async (tx) => {
    const c = (
      await tx.query<{ id: string; staff_id: string; code_hash: string; attempts: number; expires_at: Date }>(
        `SELECT * FROM otp_challenges WHERE email_hash = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [eh],
      )
    ).rows[0];
    if (!c || new Date(c.expires_at) <= ctx.now || c.attempts >= config.otpMaxAttempts) return { ok: false as const, reason: "no_valid_challenge", staffId: c?.staff_id ?? null };
    if (!safeEqualHex(c.code_hash, codeHash(c.id, code.trim()))) {
      await tx.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [c.id]);
      if (c.attempts + 1 >= config.otpMaxAttempts) await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [c.id, ctx.now]);
      return { ok: false as const, reason: "wrong_code", staffId: c.staff_id };
    }
    await tx.query("UPDATE otp_challenges SET consumed_at = $2 WHERE id = $1", [c.id, ctx.now]);
    const staff = (await tx.query("SELECT * FROM staff WHERE id = $1 AND status = 'ACTIVE'", [c.staff_id])).rows[0];
    if (!staff) return { ok: false as const, reason: "inactive", staffId: c.staff_id };
    const s = await createSession(tx, ctx, staff.id, preferredRole ?? null);
    await audit(tx, { ...ctx, actor: { staffId: staff.id, email: staff.email, name: staff.full_name, sessionId: s.sessionId, activeRole: s.activeRole } }, {
      action: "LOGIN",
      actorRole: s.activeRole,
      details: { requestedWorkspace: preferredRole ?? null, grantedWorkspace: s.activeRole },
    });
    return { ok: true as const, login: { ...s, staffId: staff.id } };
  });
  if (!result.ok) {
    await auditOutsideTx(ctx, { action: "LOGIN", outcome: "DENIED", reason: result.reason, actorId: result.staffId, actorEmail: maskEmail(email) });
    if (result.reason === "wrong_code") await recordFailure(ctx, eh, email, result.staffId);
    throw fail;
  }
  return result.login;
}
