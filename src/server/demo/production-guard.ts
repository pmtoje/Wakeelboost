import { db, type Db } from "../db";
import { DEMO_STAFF } from "./seed";

/**
 * Production startup (security review M2): mark this database as production, so demo seeding is
 * refused on it from anywhere, and refuse to run while any synthetic demo account is active. Demo
 * accounts use real-looking @altbank.ng addresses (including a Super Admin); whoever later receives
 * mail at one of them could otherwise sign in.
 */
export async function assertNoDemoStaff(q: Db = db, now = new Date()): Promise<void> {
  await q.query("INSERT INTO system_flags (key, set_at) VALUES ('PRODUCTION_DATABASE', $1) ON CONFLICT (key) DO NOTHING", [now]);
  const demo = DEMO_STAFF.map((s) => s.email);
  const active = (
    await q.query<{ email: string }>(
      `SELECT DISTINCT s.email FROM staff s JOIN role_assignments ra ON ra.staff_id = s.id AND ra.active
        WHERE s.status = 'ACTIVE' AND s.email = ANY($1::text[]) ORDER BY s.email`,
      [demo],
    )
  ).rows.map((r) => r.email);
  if (active.length) {
    throw new Error(`Demo accounts are active on this production database (${active.length}: ${active.slice(0, 5).join(", ")}${active.length > 5 ? ", …" : ""}). Suspend them under Administration > Staff, or remove them, before starting.`);
  }
}
