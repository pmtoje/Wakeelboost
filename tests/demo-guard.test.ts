import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { isProductionDatabase, seedReferenceData } from "@/server/demo/seed";
import { assertNoDemoStaff } from "@/server/demo/production-guard";
import { migrate } from "@/server/migrate";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("demo accounts never reach production (security review M2)", () => {
  it("seeding without the demo option creates real staff only", async () => {
    await migrate(process.env.DATABASE_URL!, { reset: true }); // a fresh database
    await seedReferenceData(db);
    const emails = (await db.query("SELECT email FROM staff ORDER BY email")).rows.map((r) => r.email);
    expect(emails).toContain("omoseni.ademowo@altbank.ng");
    expect(emails).not.toContain("superadmin@altbank.ng");
    expect(emails).not.toContain("co1@altbank.ng");
  });

  it("a production server refuses to start while demo accounts are active, and marks the database", async () => {
    expect(await isProductionDatabase(db)).toBe(false);
    await expect(assertNoDemoStaff(db)).rejects.toThrow(/Demo accounts are active/);
    expect(await isProductionDatabase(db)).toBe(true);
    // ...and demo seeding is then refused on that database, whatever the local APP_ENV says
    await expect(seedReferenceData(db, { includeDemo: true })).rejects.toThrow(/production server/);
    // Real-staff seeding (new templates, new Unit Heads) still works
    await expect(seedReferenceData(db)).resolves.toBeDefined();
  });

  it("starts once the demo accounts are suspended", async () => {
    await db.query("UPDATE staff SET status = 'SUSPENDED' WHERE email NOT IN ('paul.toje@altbank.ng','tomiwa.adebanjo@altbank.ng','omoseni.ademowo@altbank.ng')");
    await expect(assertNoDemoStaff(db)).resolves.toBeUndefined();
  });
});
