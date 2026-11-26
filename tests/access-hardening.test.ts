import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { caseAccess } from "@/server/domain/access";
import { canSeeCreditDetail } from "@/server/domain/credit-check";
import { bookedRequests, getCase, processedRequests, revealIdentifiers } from "@/server/domain/views";
import { createDraft, saveDraft, submitApplication } from "@/server/domain/workflow";
import { revokeRole } from "@/server/domain/admin";
import { act, approveFirstReview, passCreditCheck, createSubmittedCase, ctxFor, driveToClosed, driveToOffer } from "@/server/demo/scenario";
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

  it("only the credit reviewers on a case can see the full BVN, TIN and NIN; everyone else sees them masked", async () => {
    const id = await createSubmittedCase({ initiator: "RM", type: "ENTERPRISE", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE"); // the RBE endorsed and has moved on
    // The credit officer holding the case sees all three in full
    const r = await revealIdentifiers(await ctxFor("co1@altbank.ng"), id);
    expect(r).toMatchObject({ bvn: "22212345678", nin: "12345678901", tin: "12345678-0001" });
    // The initiator, the endorser and the Super Admin can view the case but not reveal
    for (const email of ["rm.ade@altbank.ng", "rbe.lagos@altbank.ng", "superadmin@altbank.ng"]) {
      await expect(revealIdentifiers(await ctxFor(email), id)).rejects.toThrow(/credit reviewers/);
    }
    expect((await caseAccess(db, await staffId("rbe.lagos@altbank.ng"), id)).canView).toBe(true);
    expect((await audits("SENSITIVE_REVEAL")).filter((a) => a.outcome === "DENIED").length).toBe(3);
    // A credit officer whose role is removed loses the reveal too
    await revokeRole(await ctxFor("superadmin@altbank.ng"), { staffId: await staffId("co1@altbank.ng"), role: "CREDIT_OFFICER_1" });
    await expect(revealIdentifiers(await ctxFor("co1@altbank.ng"), id)).rejects.toThrow();
  });

  it("the NIN is required to submit; a director's NIN is optional and revealed only to credit reviewers", async () => {
    const rm = await ctxFor("rm.ade@altbank.ng");
    const draft = (await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" })).id;
    await passCreditCheck(rm, draft, "22212345678");
    await saveDraft(rm, draft, { data: {}, bvn: "22212345678" });
    await expect(submitApplication(rm, draft, randomUUID())).rejects.toMatchObject({ fields: expect.objectContaining({ nin: "NIN is required." }) });

    const ltd = await createSubmittedCase({ initiator: "RM", type: "LIMITED", amountKobo: NAIRA(1_000_000) });
    await act(ltd, "ENDORSE");
    const c = await getCase(rm, ltd);
    expect(c.directors.map((d: { nin_last4: string | null }) => d.nin_last4)).toEqual(["0001", null, null]);
    const r = await revealIdentifiers(await ctxFor("co1@altbank.ng"), ltd);
    expect(r.directors[0]).toMatchObject({ fullName: "Director One", bvn: "22200000001", nin: "33300000001" });
    expect(r.directors[1].nin).toBeNull();
    await expect(revealIdentifiers(rm, ltd)).rejects.toThrow(/credit reviewers/);
  });

  it("the NIN is validated, stored encrypted and shown masked", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    const v = (await db.query("SELECT nin_enc, nin_last4 FROM application_versions WHERE application_id = $1", [id])).rows[0];
    expect(v.nin_last4).toBe("8901");
    expect(v.nin_enc).not.toContain("12345678901");
    const c = await getCase(await ctxFor("rm.ade@altbank.ng"), id);
    expect(c.masked.nin).not.toContain("1234567");
    expect(c.masked.nin).toContain("8901");
    expect(c.canRevealIdentifiers).toBe(false);
    const rm = await ctxFor("rm.ade@altbank.ng");
    const draft = (await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" })).id;
    await passCreditCheck(rm, draft, "22212345678");
    await expect(saveDraft(await ctxFor("rm.ade@altbank.ng"), draft, { data: {}, nin: "1234" })).rejects.toMatchObject({ fields: { nin: "NIN must be 11 digits." } });
  });

  it("an endorser can find the cases they approved, until their role is removed", async () => {
    const id = await createSubmittedCase({ initiator: "MERCHANT_OFFICER", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    const lead = await staffId("mo.lead@altbank.ng");
    const approved = await processedRequests(db, lead, { outcome: "approved" });
    expect(approved.rows.map((r) => r.application_id)).toContain(id);
    await revokeRole(await ctxFor("superadmin@altbank.ng"), { staffId: lead, role: "MERCHANT_OFFICER_LEAD" });
    const after = await processedRequests(db, lead, { outcome: "approved" });
    expect(after.rows.map((r) => r.application_id)).not.toContain(id);
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
