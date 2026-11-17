import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { createDraft } from "@/server/domain/workflow";
import { runCreditCheck } from "@/server/domain/credit-check";
import { approverMetrics, initiatorMetrics, monthToDate, openQueue, oversightOverview, periodFor, productManagerMetrics } from "@/server/domain/metrics";
import { facilityLifecycle, requireOversight, setStageTarget } from "@/server/domain/oversight";
import { act, createSubmittedCase, ctxFor, driveToClosed, driveToOffer } from "@/server/demo/scenario";
import { audits, resetDb, staffId } from "./helpers";
import { BVN_ADVERSE } from "./seedfi-stub";

beforeEach(async () => {
  await resetDb();
});

describe("reporting period", () => {
  it("month to date starts on the 1st at 00:00 Lagos time", () => {
    // 00:30 on 1 March in Lagos is 23:30 UTC on 28 February
    const p = monthToDate(new Date("2026-02-28T23:30:00Z"));
    expect(p.from.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(monthToDate(new Date("2026-02-28T22:30:00Z")).from.toISOString()).toBe("2026-01-31T23:00:00.000Z");
    const prev = periodFor("prev", new Date("2026-03-15T12:00:00Z"));
    expect([prev.from.toISOString(), prev.to.toISOString()]).toEqual(["2026-01-31T23:00:00.000Z", "2026-02-28T23:00:00.000Z"]);
  });
});

describe("personal month-to-date metrics", () => {
  it("are computed from records, count each facility once and ignore earlier months", async () => {
    const now = new Date();
    const lastMonth = new Date(monthToDate(now).from.getTime() - 3 * 864e5);
    // A: initiated and submitted last month, still in approval
    await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(4_000_000), now: lastMonth });
    // B: this month, approved through every stage and disbursed
    const b = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
    await driveToOffer(b);
    await driveToClosed(b);
    // C: this month, rejected at endorsement
    const c = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(c, "REJECT", { reason: "Outside the programme" });

    const rm = await staffId("rm.ade@altbank.ng");
    const mtd = monthToDate(new Date());
    const m = await initiatorMetrics(db, rm, mtd);
    expect(m).toMatchObject({ initiated: 2, submitted: 2, requestedValue: NAIRA(3_000_000), approved: 1, approvedValue: NAIRA(2_000_000), disbursed: 1, disbursedValue: NAIRA(2_000_000), declined: 1, pending: 1 });

    const uh = await approverMetrics(db, await staffId("omoseni.ademowo@altbank.ng"), mtd);
    expect(uh).toMatchObject({ approved: 1, approvedValue: NAIRA(2_000_000), returned: 0, declined: 0 });
    expect(uh.reviewed).toBe(1);
    expect(uh.avgTurnaroundMs).not.toBeNull();

    const o = await oversightOverview(db, mtd, {});
    expect(o).toMatchObject({ requested: 2, approved: 1, disbursed: 1, disbursedValue: NAIRA(2_000_000), declined: 1, recognisedIncome: null });
    const markup = (await db.query("SELECT markup_kobo FROM credit_assessments WHERE application_id = $1 AND superseded_at IS NULL", [b])).rows[0].markup_kobo;
    expect(o.contractedMarkup).toBe(Number(markup));
    // Filters apply (another initiator sees nothing of this RM's work)
    expect((await oversightOverview(db, mtd, { rm: await staffId("anm.south@altbank.ng") })).requested).toBe(0);
    // History is kept: the previous month still shows A
    const prev = await initiatorMetrics(db, rm, { from: new Date(lastMonth.getTime() - 864e5), to: monthToDate(now).from, label: "prev" });
    expect(prev).toMatchObject({ initiated: 1, submitted: 1, requestedValue: NAIRA(4_000_000) });
  });

  it("Product Manager metrics count credit reviews and decisions", async () => {
    const rm = await ctxFor("rm.ade@altbank.ng");
    for (const decision of ["CLEAR_TO_PROCEED", "DECLINE"] as const) {
      const { id } = await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
      await runCreditCheck(rm, id, { firstName: "Ada", lastName: "Obi", bvn: BVN_ADVERSE, dateOfBirth: "1985-01-01", gender: "female", phone: "08030000000", consent: true, consentMethod: "SIGNED_FORM" }, randomUUID());
      await act(id, decision, { reason: "Reviewed the SeedFi findings" });
    }
    const { id: open } = await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
    await runCreditCheck(rm, open, { firstName: "Ada", lastName: "Obi", bvn: BVN_ADVERSE, dateOfBirth: "1985-01-01", gender: "female", phone: "08030000000", consent: true, consentMethod: "SIGNED_FORM" }, randomUUID());
    const m = await productManagerMetrics(db, await staffId("pm@altbank.ng"), monthToDate());
    expect(m).toMatchObject({ received: 3, completed: 2, cleared: 1, declined: 1, clarifications: 0, waiting: 1 });
    expect(m.avgTurnaroundMs).not.toBeNull();
  });
});

describe("God's Eye", () => {
  it("is limited to the Super Admin, Divisional Head and Unit Head, and every view is audited", async () => {
    for (const e of ["superadmin@altbank.ng", "div.head@altbank.ng", "omoseni.ademowo@altbank.ng"]) await requireOversight(await ctxFor(e), "overview");
    for (const e of ["rm.ade@altbank.ng", "co3@altbank.ng", "pm@altbank.ng", "reports@altbank.ng"]) await expect(requireOversight(await ctxFor(e), "overview")).rejects.toThrow(/God's Eye is available/);
    const a = await audits("OVERSIGHT_VIEW");
    expect(a.filter((x) => x.outcome === "SUCCESS").length).toBe(3);
    expect(a.filter((x) => x.outcome === "DENIED").length).toBe(4);
  });

  it("shows who holds each facility, for how long, and the full lifecycle without granting any action", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await act(id, "ENDORSE");
    const q = await openQueue(db, {});
    const row = q.find((r) => r.application_id === id)!;
    expect(row).toMatchObject({ stage: "FIRST_CREDIT_REVIEW", holder: "Bola Credit-One", returned: false });
    expect(row.waiting_secs).toBeGreaterThanOrEqual(0);
    const f = await facilityLifecycle(await ctxFor("div.head@altbank.ng"), id);
    expect(f.steps.map((s) => [s.key, s.state])).toEqual([
      ["origination", "done"],
      ["credit", "done"],
      ["assessment", "current"],
      ["approvals", "current"],
      ["documentation", "pending"],
      ["disbursement", "pending"],
      ["completion", "pending"],
    ]);
    expect(f.bvn).toMatch(/^•+\d{4}$/);
    // Oversight does not create case access: the Divisional Head has no task here yet.
    expect(f.canOpenDocuments).toBe(false);
    await expect(facilityLifecycle(await ctxFor("co2@altbank.ng"), id)).rejects.toThrow(/God's Eye is available/);
  });

  it("flags tasks over the Super Admin's processing target", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await db.query("UPDATE tasks SET entered_at = now() - interval '30 hours' WHERE application_id = $1 AND status = 'OPEN'", [id]);
    await expect(setStageTarget(await ctxFor("omoseni.ademowo@altbank.ng"), "BUSINESS_ENDORSEMENT", 24)).rejects.toThrow(/Only the Super Admin/);
    await setStageTarget(await ctxFor("superadmin@altbank.ng"), "BUSINESS_ENDORSEMENT", 24);
    const row = (await openQueue(db, {})).find((r) => r.application_id === id)!;
    expect(row.target_hours).toBe(24);
    expect(row.waiting_secs).toBeGreaterThan(24 * 3600);
    expect((await audits("STAGE_TARGET_CHANGED"))[0].details).toMatchObject({ stage: "BUSINESS_ENDORSEMENT", new: 24 });
  });
});
