import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { createDraft, saveDraft, submitApplication } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { readDocumentForActor } from "@/server/domain/documents";
import { canSeeCreditDetail, classify, proceedWithReason, creditSettings, latestCreditCheck, runCreditCheck, updateCreditSettings } from "@/server/domain/credit-check";
import { act, appRow, ctxFor, makePdf, openTaskOf, sampleData } from "@/server/demo/scenario";
import { audits, outbox, resetDb, staffId } from "./helpers";
import { BVN_ADVERSE, BVN_BADAUTH, BVN_DOWN, BVN_FAIR, BVN_GARBAGE, calls } from "./seedfi-stub";

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
});

const ident = (bvn: string, over: Record<string, unknown> = {}) => ({ firstName: "Busayo", lastName: "Okon", bvn, dateOfBirth: "1990-05-20", gender: "female", phone: "0803 123 4567", consent: true, consentMethod: "SIGNED_FORM", ...over });

async function newDraft() {
  const rm = await ctxFor("rm.ade@altbank.ng");
  const { id } = await createDraft(rm, { initiatorRole: "RM", applicantType: "INDIVIDUAL" });
  return { rm, id };
}
async function completeAndSubmit(rm: Awaited<ReturnType<typeof ctxFor>>, id: string) {
  const rbe = await staffId("rbe.lagos@altbank.ng");
  await saveDraft(rm, id, { data: { ...sampleData("INDIVIDUAL", NAIRA(3_000_000)), customerName: "Busayo Okon", rbeId: rbe } });
  for (const c of ["BANK_STATEMENT", "SUPPLIER_INVOICE", "APPLICATION_FORM", "CONSENT_FORM", "RENT_RECEIPT"]) await uploadDocument(rm, { applicationId: id, category: c, filename: `${c}.pdf`, data: makePdf(c) });
  return submitApplication(rm, id, randomUUID());
}

describe("mandatory credit check comes first", () => {
  it("blocks facility details, documents and submission until the check clears", async () => {
    const { rm, id } = await newDraft();
    expect((await appRow(id)).credit_check_status).toBe("REQUIRED");
    await expect(saveDraft(rm, id, { data: { requestedAmountKobo: NAIRA(1_000_000) } })).rejects.toThrow(/Complete the SeedFi credit check/);
    await expect(uploadDocument(rm, { applicationId: id, category: "BANK_STATEMENT", filename: "b.pdf", data: makePdf("b") })).rejects.toThrow(/cannot upload this document type/);
    // The customer's consent form may be attached before the enquiry.
    await uploadDocument(rm, { applicationId: id, category: "CONSENT_FORM", filename: "consent.pdf", data: makePdf("consent") });
    await expect(submitApplication(rm, id, randomUUID())).rejects.toThrow();
    expect((await appRow(id)).stage).toBe("DRAFT");
  });

  it("an acceptable SeedFi result permits origination and the full approval chain still applies", async () => {
    const { rm, id } = await newDraft();
    const r = await runCreditCheck(rm, id, ident("22233344455"), randomUUID());
    expect(r.status).toBe("ACCEPTABLE");
    const check = (await latestCreditCheck(db, id))!;
    expect(check).toMatchObject({ status: "COMPLETED", outcome: "ACCEPTABLE", has_credit_history: true, settings_version: 1, bvn_last4: "4455" });
    expect(Number(check.overall_score)).toBe(712);
    // The request sent to SeedFi: documented endpoint, API key header, required fields.
    expect(calls[0].url).toBe("https://stg-loan-engine.theseedfi.com/scoring/api/v1/seed-score/calculate");
    expect(calls[0].headers["X-API-Key"]).toBe("test-key-not-real");
    expect(calls[0].body).toMatchObject({ first_name: "Busayo", last_name: "Okon", bvn: "22233344455", date_of_birth: "1990-05-20", phone_number: "08031234567", gender: "female" });
    expect(String(calls[0].body.customer_id)).toMatch(/^wb-[0-9a-f]{24}$/);
    await completeAndSubmit(rm, id);
    expect((await openTaskOf(id)).stage).toBe("BUSINESS_ENDORSEMENT");
  });

  it("refuses the enquiry without consent and records consent before calling SeedFi", async () => {
    const { rm, id } = await newDraft();
    await expect(runCreditCheck(rm, id, ident("22233344455", { consent: false }), randomUUID())).rejects.toMatchObject({ fields: { consent: expect.any(String) } });
    expect(calls.length).toBe(0);
    await runCreditCheck(rm, id, ident("22233344455"), randomUUID());
    const [consent] = await audits("CREDIT_CONSENT_RECORDED");
    const [requested] = await audits("CREDIT_CHECK_REQUESTED");
    expect(Number(consent.id)).toBeLessThan(Number(requested.id));
    expect(consent.details.consentMethod).toBe("SIGNED_FORM");
  });

  it("the submitted application must describe the credit-checked customer", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident("22233344455"), randomUUID());
    await saveDraft(rm, id, { data: {}, bvn: "22233344499" });
    await expect(completeAndSubmit(rm, id)).rejects.toMatchObject({ fields: { bvn: expect.stringMatching(/credit-checked BVN ending 4455/) } });
  });

  it("only the initiator can run the check, and it cannot be repeated once complete", async () => {
    const { rm, id } = await newDraft();
    await expect(runCreditCheck(await ctxFor("co1@altbank.ng"), id, ident("22233344455"), randomUUID())).rejects.toThrow(/Only the initiator/);
    await runCreditCheck(rm, id, ident("22233344455"), randomUUID());
    await expect(runCreditCheck(rm, id, ident("22233344455"), randomUUID())).rejects.toThrow(/already complete/);
    expect(calls.length).toBe(1);
  });
});

describe("duplicate enquiries", () => {
  it("the same request key never calls SeedFi twice; an enquiry in flight blocks another", async () => {
    const { rm, id } = await newDraft();
    const k = randomUUID();
    const [a, b] = await Promise.allSettled([runCreditCheck(rm, id, ident("22233344455"), k), runCreditCheck(rm, id, ident("22233344455"), k)]);
    expect([a.status, b.status]).toContain("fulfilled");
    expect(calls.length).toBe(1);
    const { id: id2 } = await newDraft();
    await db.query(
      `INSERT INTO credit_checks (application_id, attempt_no, provider_environment, status, idempotency_key, first_name, last_name, date_of_birth, gender, phone, bvn_enc, bvn_last4, bvn_hash, provider_customer_id, consent_attested, consent_method, consent_at, requested_by, requested_at)
       VALUES ($1,1,'staging','IN_PROGRESS',$2,'A','B','1990-01-01','male','08030000000','x','0000','h','wb-x',true,'SIGNED_FORM',now(),$3,now())`,
      [id2, randomUUID(), await staffId("rm.ade@altbank.ng")],
    );
    await expect(runCreditCheck(rm, id2, ident("22233344455"), randomUUID())).rejects.toThrow(/already in progress/);
  });
});

describe("adverse findings go to the Product Manager", () => {
  it("routes to the Product Manager's credit review queue with the findings", async () => {
    const { rm, id } = await newDraft();
    const r = await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    expect(r.status).toBe("REVIEW_REQUIRED");
    const t = await openTaskOf(id);
    expect(t).toMatchObject({ stage: "CREDIT_REVIEW", assignee_role: "PRODUCT_MANAGER", email: "pm@altbank.ng" });
    const check = (await latestCreditCheck(db, id))!;
    expect(check.outcome).toBe("ADVERSE");
    expect(check.outcome_reasons!.join(" ")).toMatch(/444 is below the acceptable minimum of 620/);
    expect((await audits("CREDIT_CHECK_REFERRED")).length).toBe(1);
    expect((await outbox()).some((m) => m.to_addresses.includes("pm@altbank.ng"))).toBe(true);
    await expect(saveDraft(rm, id, { data: {} })).rejects.toThrow(/cannot be edited/);
    // Detailed findings: Product Manager and the initiator yes; staff not on the credit side no.
    expect(await canSeeCreditDetail(db, await staffId("pm@altbank.ng"), id)).toBe(true);
    expect(await canSeeCreditDetail(db, await staffId("rm.ade@altbank.ng"), id)).toBe(true);
    expect(await canSeeCreditDetail(db, await staffId("co1@altbank.ng"), id)).toBe(false);
  });

  it("every Product Manager decision needs a reason and is recorded with the reviewer", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_FAIR), randomUUID());
    for (const a of ["CLEAR_TO_PROCEED", "REQUEST_CLARIFICATION", "DECLINE"] as const) await expect(act(id, a)).rejects.toThrow(/reason is required/);
    await act(id, "REQUEST_CLARIFICATION", { reason: "Explain the open credit line with Bank X and provide its statement." });
    expect((await openTaskOf(id))).toMatchObject({ stage: "CREDIT_CLARIFICATION", email: "rm.ade@altbank.ng" });
    expect((await appRow(id)).credit_check_status).toBe("CLARIFICATION_REQUIRED");
    await uploadDocument(rm, { applicationId: id, category: "SUPPORTING", filename: "bank-x.pdf", data: makePdf("Bank X statement") });
    await expect(act(id, "RESPOND_CLARIFICATION")).rejects.toThrow(/reason is required/);
    await act(id, "RESPOND_CLARIFICATION", { reason: "Facility with Bank X was fully repaid in March; statement attached." });
    expect((await openTaskOf(id))).toMatchObject({ stage: "CREDIT_REVIEW", email: "pm@altbank.ng" });
    await act(id, "CLEAR_TO_PROCEED", { reason: "Repayment evidence satisfactory; low exposure relative to turnover." });
    const app = await appRow(id);
    expect(app).toMatchObject({ stage: "DRAFT", credit_check_status: "CLEARED", product_manager_id: await staffId("pm@altbank.ng") });
    const d = (await db.query("SELECT action, actor_role, reason FROM decisions WHERE application_id = $1 ORDER BY seq", [id])).rows;
    expect(d.map((x) => [x.action, x.actor_role])).toEqual([["REQUEST_CLARIFICATION", "PRODUCT_MANAGER"], ["RESPOND_CLARIFICATION", "RM"], ["CLEAR_TO_PROCEED", "PRODUCT_MANAGER"]]);
    expect((await audits("CREDIT_REVIEW_CLEARED"))[0].reason).toMatch(/Repayment evidence/);
  });

  it("clearance is not credit approval: the facility still needs every approval stage", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    await act(id, "CLEAR_TO_PROCEED", { reason: "Historic default settled; acceptable." });
    await completeAndSubmit(rm, id);
    expect((await openTaskOf(id)).stage).toBe("BUSINESS_ENDORSEMENT");
    await act(id, "ENDORSE");
    expect((await openTaskOf(id)).stage).toBe("FIRST_CREDIT_REVIEW");
    // The Product Manager holds no approval authority on the facility itself.
    expect((await appRow(id)).first_reviewer_id).not.toBe(await staffId("pm@altbank.ng"));
  });

  it("decline closes the request with the reason and notifies the initiator", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    await act(id, "DECLINE", { reason: "Multiple recent delinquencies reported." });
    expect(await appRow(id)).toMatchObject({ stage: "REJECTED", status: "REJECTED", credit_check_status: "DECLINED" });
    expect(await openTaskOf(id)).toBeUndefined();
    expect((await outbox("CREDIT_DECLINED"))[0].to_addresses).toEqual(["rm.ade@altbank.ng"]);
    await expect(saveDraft(rm, id, { data: {} })).rejects.toThrow();
  });
});

describe("technical failures are never credit decisions", () => {
  it.each([
    [BVN_DOWN, "UNAVAILABLE", 2],
    [BVN_BADAUTH, "AUTH", 1],
    [BVN_GARBAGE, "UNEXPECTED_RESPONSE", 1],
  ])("SeedFi failure (%s) leaves the request unavailable, with no outcome and no referral", async (bvn, code, expectedCalls) => {
    const { rm, id } = await newDraft();
    const r = await runCreditCheck(rm, id, ident(bvn), randomUUID());
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.message).toMatch(/No credit decision was made/);
    const check = (await latestCreditCheck(db, id))!;
    expect(check).toMatchObject({ status: "FAILED", error_code: code, outcome: null, overall_score: null });
    expect(calls.length).toBe(expectedCalls); // one retry only for 502/503/504
    expect(await openTaskOf(id)).toBeUndefined();
    await expect(saveDraft(rm, id, { data: {} })).rejects.toThrow(/Complete the SeedFi credit check/);
    expect((await audits("CREDIT_CHECK_FAILED"))[0].outcome).toBe("FAILURE");
    // The initiator can retry once SeedFi responds.
    expect((await runCreditCheck(rm, id, ident("22233344455"), randomUUID())).status).toBe("ACCEPTABLE");
    expect((await latestCreditCheck(db, id))!.attempt_no).toBe(2);
  }, 20_000);

  it("refuses SeedFi staging in production: live data only", async () => {
    const { rm, id } = await newDraft();
    process.env.APP_ENV = "production";
    try {
      const { calculateSeedScore } = await import("@/server/integrations/seedfi");
      const r = await calculateSeedScore({ customerId: "wb-x", firstName: "A", lastName: "B", bvn: "22233344455", dateOfBirth: "1990-01-01", phoneNumber: "08030000000", gender: "male" });
      expect(r).toMatchObject({ ok: false, code: "NOT_LIVE" });
      process.env.SEEDFI_BASE_URL = "https://loanengine.theseedfi.com";
      const live = await calculateSeedScore({ customerId: "wb-x", firstName: "A", lastName: "B", bvn: "22233344455", dateOfBirth: "1990-01-01", phoneNumber: "08030000000", gender: "male" });
      expect(live.ok).toBe(true);
      expect(calls.at(-1)!.url).toBe("https://loanengine.theseedfi.com/scoring/api/v1/seed-score/calculate");
    } finally {
      process.env.APP_ENV = "test";
      process.env.SEEDFI_BASE_URL = "https://stg-loan-engine.theseedfi.com";
    }
    void id;
    void rm;
  });

  it("reports SeedFi as unavailable when it is not configured", async () => {
    const { rm, id } = await newDraft();
    const prev = process.env.SEEDFI_API_KEY;
    delete process.env.SEEDFI_API_KEY;
    try {
      const r = await runCreditCheck(rm, id, ident("22233344455"), randomUUID());
      expect(r.status).toBe("UNAVAILABLE");
      expect((await latestCreditCheck(db, id))!.error_code).toBe("NOT_CONFIGURED");
      expect(calls.length).toBe(0);
    } finally {
      process.env.SEEDFI_API_KEY = prev;
    }
  });
});

describe("protection of credit data", () => {
  it("never writes the BVN or the provider response in clear to the audit trail", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    const all = JSON.stringify((await db.query("SELECT details, reason FROM audit_events WHERE application_id = $1", [id])).rows);
    expect(all).not.toContain(BVN_ADVERSE);
    const row = (await db.query("SELECT bvn_enc, response_enc FROM credit_checks WHERE application_id = $1", [id])).rows[0];
    expect(row.bvn_enc).toMatch(/^v1:/);
    expect(row.response_enc).toMatch(/^v1:/);
  });
});

describe("credit rules", () => {
  it("classify uses only SeedFi's values against the configured minimum", async () => {
    const s = await creditSettings(db);
    expect(classify({ overallScore: 712, reviewedScore: 712, hasCreditHistory: false }, s).outcome).toBe("ACCEPTABLE");
    expect(classify({ overallScore: 544, reviewedScore: 444, hasCreditHistory: true }, s).outcome).toBe("ADVERSE");
    expect(classify({ overallScore: 620, reviewedScore: 620, hasCreditHistory: true }, s).outcome).toBe("ACCEPTABLE");
    expect(classify({ overallScore: 619, reviewedScore: 700, hasCreditHistory: true }, s).outcome).toBe("ADVERSE");
  });

  it("only the Super Admin can change them, prospectively and audited", async () => {
    await expect(updateCreditSettings(await ctxFor("pm@altbank.ng"), { minAcceptableScore: 530, scoreBasis: "REVIEWED", requireCreditHistory: false, reason: "Loosen" })).rejects.toThrow(/Only the Super Admin/);
    await updateCreditSettings(await ctxFor("superadmin@altbank.ng"), { minAcceptableScore: 530, scoreBasis: "REVIEWED", requireCreditHistory: true, reason: "Bank credit policy 2026" });
    const s = await creditSettings(db);
    expect(s).toMatchObject({ version: 2, minAcceptableScore: 530, scoreBasis: "REVIEWED", requireCreditHistory: true });
    const { rm, id } = await newDraft();
    expect((await runCreditCheck(rm, id, ident(BVN_FAIR), randomUUID())).status).toBe("ACCEPTABLE");
    expect((await latestCreditCheck(db, id))!.settings_version).toBe(2);
    const changes = await audits("CREDIT_RULES_CHANGED");
    expect(changes.map((a) => a.outcome)).toEqual(["DENIED", "SUCCESS"]);
    expect(changes[1].details.new.minAcceptableScore).toBe(530);
  });
});

describe("existing applications", () => {
  it("requests created before the credit check keep working unchanged", async () => {
    const { rm, id } = await newDraft();
    await db.query("UPDATE applications SET credit_check_status = 'NOT_REQUIRED', credit_check_note = 'Created before the mandatory credit check' WHERE id = $1", [id]);
    await saveDraft(rm, id, { data: {}, bvn: "22212345678" });
    await completeAndSubmit(rm, id);
    expect((await openTaskOf(id)).stage).toBe("BUSINESS_ENDORSEMENT");
  });
});

describe("automatic SeedFi credit report", () => {
  it("is generated from the SeedFi response when the check completes (acceptable or adverse), never for failures", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    const docs = (await db.query("SELECT * FROM documents WHERE application_id = $1 AND category = 'SEEDFI_CREDIT_REPORT'", [id])).rows;
    expect(docs.length).toBe(1);
    expect(docs[0]).toMatchObject({ generated: true, uploaded_role: "SYSTEM", mime_type: "application/pdf", scan_status: "CLEAN" });
    expect(docs[0].filename).toMatch(/^SeedFi-credit-report-WB-\d{4}-\d{6}-enquiry-1\.pdf$/);
    const { data } = await readDocumentForActor(rm, docs[0].id, "download");
    expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    const text = data.toString("latin1");
    expect(text).toContain("SeedFi credit check report");
    expect(text).toContain("Reviewed Seed Score");
    expect(text).toContain("444");
    expect(text).toContain("Adverse findings: referred to the Product Manager");
    expect(text).not.toContain(BVN_ADVERSE); // BVN masked
    expect((await audits("CREDIT_REPORT_GENERATED"))[0].details.attempt).toBe(1);
    const { id: failedId } = await newDraft();
    await runCreditCheck(rm, failedId, ident(BVN_BADAUTH), randomUUID());
    expect((await db.query("SELECT count(*)::int n FROM documents WHERE application_id = $1 AND category = 'SEEDFI_CREDIT_REPORT'", [failedId])).rows[0].n).toBe(0);
  });

  it("is restricted to people allowed to see credit detail and cannot be uploaded or replaced by hand", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    const doc = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'SEEDFI_CREDIT_REPORT'", [id])).rows[0];
    await readDocumentForActor(await ctxFor("pm@altbank.ng"), doc.id, "view");
    await act(id, "CLEAR_TO_PROCEED", { reason: "Settled" });
    await completeAndSubmit(rm, id);
    // The RBE now has case access but not credit detail.
    await expect(readDocumentForActor(await ctxFor("rbe.lagos@altbank.ng"), doc.id, "view")).rejects.toThrow(/credit information you are not authorised/);
    await expect(uploadDocument(rm, { applicationId: id, category: "SEEDFI_CREDIT_REPORT", filename: "x.pdf", data: makePdf("x") })).rejects.toThrow(/produced by the system/);
  });
});

describe("Proceed with Reason (adverse result)", () => {
  async function adverse() {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_ADVERSE), randomUUID());
    return { rm, id };
  }

  it("needs a reason, then opens the facility application while the Product Manager review stays open", async () => {
    const { rm, id } = await adverse();
    await expect(proceedWithReason(rm, id, "ok")).rejects.toMatchObject({ fields: { reason: expect.any(String) } });
    await expect(proceedWithReason(await ctxFor("co1@altbank.ng"), id, "Customer has strong turnover")).rejects.toThrow(/Only the initiator/);
    await proceedWithReason(rm, id, "Reported default was settled in March 2025; statements show steady monthly inflows.");
    const app = await appRow(id);
    expect(app).toMatchObject({ stage: "CREDIT_REVIEW", credit_check_status: "REVIEW_REQUIRED" });
    expect(app.rm_proceed_reason).toMatch(/settled in March 2025/);
    expect((await openTaskOf(id))).toMatchObject({ stage: "CREDIT_REVIEW", email: "pm@altbank.ng" });
    const pa = await audits("CREDIT_PROCEEDED_WITH_REASON");
    expect(pa.map((a) => a.outcome)).toEqual(["DENIED", "SUCCESS"]);
    expect(pa[1].reason).toMatch(/settled/);
    expect((await outbox("CREDIT_PROCEEDED_WITH_REASON"))[0].to_addresses).toEqual(["pm@altbank.ng"]);
    await saveDraft(rm, id, { data: { requestedAmountKobo: NAIRA(3_000_000) } });
    await expect(proceedWithReason(rm, id, "Again with another reason")).rejects.toThrow(/already chosen/);
  });

  it("a submission waits for the Product Manager and goes to endorsement when cleared", async () => {
    const { rm, id } = await adverse();
    await proceedWithReason(rm, id, "Default settled; strong statement inflows.");
    const r = await completeAndSubmit(rm, id);
    expect(r.message).toMatch(/as soon as the Product Manager clears/);
    expect(await appRow(id)).toMatchObject({ stage: "CREDIT_REVIEW" });
    expect((await appRow(id)).pm_hold_submitted_at).not.toBeNull();
    await expect(saveDraft(rm, id, { data: {} })).rejects.toThrow(/waiting for the Product Manager/);
    await expect(submitApplication(rm, id, randomUUID())).rejects.toThrow(/waiting for the Product Manager/);
    await act(id, "CLEAR_TO_PROCEED", { reason: "Agree with the initiator's assessment." });
    expect(await openTaskOf(id)).toMatchObject({ stage: "BUSINESS_ENDORSEMENT", email: "rbe.lagos@altbank.ng" });
    expect(await appRow(id)).toMatchObject({ credit_check_status: "CLEARED", status: "IN_PROGRESS", pm_hold_submitted_at: null });
  });

  it("the Product Manager can still stop the request before business endorsement", async () => {
    const { rm, id } = await adverse();
    await proceedWithReason(rm, id, "Default settled; strong statement inflows.");
    await completeAndSubmit(rm, id);
    await act(id, "DECLINE", { reason: "Repeated delinquencies; exposure too high." });
    expect(await appRow(id)).toMatchObject({ stage: "REJECTED", status: "REJECTED", credit_check_status: "DECLINED" });
    expect((await db.query("SELECT count(*)::int n FROM tasks WHERE application_id = $1 AND stage = 'BUSINESS_ENDORSEMENT'", [id])).rows[0].n).toBe(0);
  });

  it("clearance before submission returns the request to the initiator's draft as usual", async () => {
    const { rm, id } = await adverse();
    await proceedWithReason(rm, id, "Default settled; strong statement inflows.");
    await act(id, "CLEAR_TO_PROCEED", { reason: "Satisfied." });
    expect(await appRow(id)).toMatchObject({ stage: "DRAFT", credit_check_status: "CLEARED" });
    await completeAndSubmit(rm, id);
    expect((await openTaskOf(id)).stage).toBe("BUSINESS_ENDORSEMENT");
  });

  it("is not available after a technical failure or an acceptable result", async () => {
    const { rm, id } = await newDraft();
    await runCreditCheck(rm, id, ident(BVN_DOWN), randomUUID());
    await expect(proceedWithReason(rm, id, "Seedfi is down, proceed anyway")).rejects.toThrow(/only while adverse SeedFi findings/);
    const { id: ok } = await newDraft();
    await runCreditCheck(rm, ok, ident("22233344455"), randomUUID());
    await expect(proceedWithReason(rm, ok, "No need but trying")).rejects.toThrow(/only while adverse SeedFi findings/);
  }, 20_000);
});
