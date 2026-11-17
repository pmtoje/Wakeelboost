import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { caseAccess } from "@/server/domain/access";
import { canSeeCreditDetail } from "@/server/domain/credit-check";
import { bookedRequests, revealIdentifiers } from "@/server/domain/views";
import { revokeRole } from "@/server/domain/admin";
import { act, approveFirstReview, createSubmittedCase, ctxFor, driveToClosed, driveToOffer } from "@/server/demo/scenario";
import { audits, resetDb, staffId } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("access control hardening (security review M5, M6)", () => {
  it("removing an officer's role removes their access to past cases and credit detail", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    await approveFirstReview(id);
    const co1 = await staffId("co1@altbank.ng");
    expect((await caseAccess(db, co1, id)).canView).toBe(true);
    expect(await canSeeCreditDetail(db, co1, id)).toBe(true);
    await revokeRole(await ctxFor("superadmin@altbank.ng"), { staffId: co1, role: "CREDIT_OFFICER_1" });
    expect((await caseAccess(db, co1, id)).canView).toBe(false);
    expect(await canSeeCreditDetail(db, co1, id)).toBe(false);
  });

  it("the initiator loses access when their initiator role is removed", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    const rm = await staffId("rm.ade@altbank.ng");
    expect((await caseAccess(db, rm, id)).capacities).toContain("INITIATOR");
    await revokeRole(await ctxFor("superadmin@altbank.ng"), { staffId: rm, role: "RM" });
    expect((await caseAccess(db, rm, id)).canView).toBe(false);
  });

  it("full BVN and TIN are revealed only on a need-to-know basis", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE"); // the RBE endorsed and has moved on
    // Initiator and the officer now holding the case may reveal
    expect((await revealIdentifiers(await ctxFor("rm.ade@altbank.ng"), id)).bvn).toMatch(/^\d{11}$/);
    expect((await revealIdentifiers(await ctxFor("co1@altbank.ng"), id)).bvn).toMatch(/^\d{11}$/);
    // The endorser can still view the case but sees masked identifiers only
    expect((await caseAccess(db, await staffId("rbe.lagos@altbank.ng"), id)).canView).toBe(true);
    await expect(revealIdentifiers(await ctxFor("rbe.lagos@altbank.ng"), id)).rejects.toThrow(/shown only to/);
    expect((await audits("SENSITIVE_REVEAL")).some((a) => a.outcome === "DENIED")).toBe(true);
  });

  it("Booked Requests are limited to the regions a Reporting Admin is scoped to", async () => {
    const south = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(south);
    await driveToClosed(south);
    const region = (await db.query("SELECT region FROM applications WHERE id = $1", [south])).rows[0].region;
    expect((await bookedRequests(db, { regions: null })).map((r) => r.id)).toContain(south);
    expect((await bookedRequests(db, { regions: [region] })).map((r) => r.id)).toContain(south);
    const other = region === "NORTH" ? "SOUTH" : "NORTH";
    expect((await bookedRequests(db, { regions: [other] })).map((r) => r.id)).not.toContain(south);
  });
});
