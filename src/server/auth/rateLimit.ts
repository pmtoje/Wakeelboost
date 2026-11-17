import type { Db } from "../db";
import { withTx } from "../db";

/**
 * Sliding-window rate limiter backed by PostgreSQL (shared across app instances).
 * Returns true when the action is allowed (and records it). The count and the insert run under a
 * per-bucket advisory lock in one transaction, so parallel requests cannot slip past the limit.
 */
export async function rateLimit(_q: Db, bucket: string, limit: number, windowSeconds: number, now: Date): Promise<boolean> {
  return withTx(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [bucket]);
    const n = await countEvents(tx, bucket, windowSeconds, now);
    if (n >= limit) return false;
    await tx.query("INSERT INTO rate_limit_events (bucket, created_at) VALUES ($1, $2)", [bucket, now]);
    return true;
  });
}

/** Events recorded in a bucket within the window. */
export async function countEvents(q: Db, bucket: string, windowSeconds: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - windowSeconds * 1000);
  const r = await q.query<{ n: string }>("SELECT count(*) AS n FROM rate_limit_events WHERE bucket = $1 AND created_at > $2", [bucket, since]);
  return Number(r.rows[0].n);
}

/** Record one event in a bucket (no limit check). */
export async function recordEvent(q: Db, bucket: string, now: Date): Promise<void> {
  await q.query("INSERT INTO rate_limit_events (bucket, created_at) VALUES ($1, $2)", [bucket, now]);
}
