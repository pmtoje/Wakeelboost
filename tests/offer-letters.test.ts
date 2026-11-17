import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { readDocumentForActor, uploadDocument } from "@/server/domain/documents";
import { activateTemplate, approveTemplate, createDocxTemplateVersion } from "@/server/domain/admin";
import { liveOfferLetter, offerLetterHistory, processDueOfferLetters, processOfferLetter, requestOfferLetterNow } from "@/server/domain/offer-letters";
import { validateDocxTemplate } from "@/server/domain/offer-docx";
import { act, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf } from "@/server/demo/scenario";
import { audits, outbox, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function letterText(docId: string, email: string) {
  const { data } = await readDocumentForActor(await ctxFor(email), docId, "download");
  const z = await JSZip.loadAsync(data);
  return (await z.file("word/document.xml")!.async("string")).replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
}

describe("automatic Murabaha offer letters", () => {
  it("are requested at Divisional Head approval and issued without anyone pressing a button", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
    await driveToOffer(id);
    const pending = await liveOfferLetter(db, id);
    expect(pending).toMatchObject({ status: "PENDING", trigger: "DIVISIONAL_HEAD_APPROVAL", acceptance_status: "NOT_ISSUED" });
    expect(await processDueOfferLetters()).toBe(1);
    const issued = (await liveOfferLetter(db, id))!;
    expect(issued).toMatchObject({ status: "ISSUED", acceptance_status: "AWAITING_SIGNATURE", template_version: 1, attempts: 1 });
    expect(issued.docx_document_id).toBeTruthy();
    const a = (await audits("OFFER_LETTER_ISSUED"))[0];
    expect(a.details).toMatchObject({ offerLetterId: issued.id, templateVersion: 1, trigger: "DIVISIONAL_HEAD_APPROVAL" });
    expect((await outbox("OFFER_LETTER_ISSUED")).map((m) => m.to_addresses[0])).toEqual(["rm.ade@altbank.ng"]);
  });

  it("populate the approved facility record (cost, markup, selling price) in Murabaha terms", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(2_000_000) });
    await driveToOffer(id);
    await processDueOfferLetters();
    const l = (await liveOfferLetter(db, id))!;
    const text = await letterText(l.docx_document_id!, "rm.ade@altbank.ng");
    const app = (await db.query("SELECT ref, customer_name FROM applications WHERE id = $1", [id])).rows[0];
    const asmt = (await db.query("SELECT * FROM credit_assessments WHERE id = $1", [l.assessment_id])).rows[0];
    expect(text).toContain(app.customer_name);
    expect(text).toMatch(/Murabaha/);
    expect(text).not.toMatch(/interest rate/i);
    const N = (k: number | string) => `N${(Number(k) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    // Cost price, total selling price (cost plus markup) and the instalment all come from the approved assessment.
    expect(text).toContain(N(NAIRA(2_000_000)));
    expect(text).toContain(N(asmt.cost_plus_markup_kobo));
    expect(text).toContain(N(asmt.outputs.periodicInstalmentKobo));
    expect(text).toContain(`${asmt.outputs.flatMarkupRatePercent}%`);
    expect(Number(asmt.cost_plus_markup_kobo) - Number(asmt.markup_kobo)).toBe(NAIRA(2_000_000));
  });

  it("never create a second issued letter when triggered repeatedly", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    const l = (await liveOfferLetter(db, id))!;
    await Promise.all([processOfferLetter(l.id), processOfferLetter(l.id), processDueOfferLetters()]);
    const rm = await ctxFor("rm.ade@altbank.ng");
    await requestOfferLetterNow(rm, id);
    await requestOfferLetterNow(rm, id);
    expect((await offerLetterHistory(db, id)).length).toBe(1);
    expect((await db.query("SELECT count(*)::int n FROM documents WHERE application_id = $1 AND category = 'GENERATED_OFFER'", [id])).rows[0].n).toBe(1);
    expect((await audits("OFFER_LETTER_ISSUED")).length).toBe(1);
  });

  it("the bank's three Murabaha templates are approved for live use", async () => {
    const t = (await db.query("SELECT applicant_type, production_approved FROM offer_templates WHERE status = 'ACTIVE' AND doc_type = 'OFFER_LETTER' ORDER BY applicant_type")).rows;
    expect(t).toEqual([{ applicant_type: "ENTERPRISE", production_approved: true }, { applicant_type: "INDIVIDUAL", production_approved: true }, { applicant_type: "LIMITED", production_approved: true }]);
  });

  it("fail visibly (not issued) when the active template is not approved in production, then succeed after approval", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    // The bank's seeded templates are approved; simulate a newly activated, unapproved version.
    await db.query("UPDATE offer_templates SET production_approved = false WHERE status = 'ACTIVE' AND applicant_type = 'INDIVIDUAL'");
    await driveToOffer(id);
    process.env.APP_ENV = "production";
    try {
      expect(await processDueOfferLetters()).toBe(1);
    } finally {
      process.env.APP_ENV = "test";
    }
    const failed = (await liveOfferLetter(db, id))!;
    expect(failed.status).toBe("FAILED");
    expect(failed.last_error).toMatch(/not approved for production/);
    expect(failed.docx_document_id).toBeNull();
    expect(failed.next_attempt_at).not.toBeNull();
    expect((await audits("OFFER_LETTER_FAILED"))[0].outcome).toBe("FAILURE");
    // The pack cannot be submitted on a letter that was not issued.
    await expect(act(id, "SUBMIT_PACK")).rejects.toThrow(/has not been issued/);
    const sa = await ctxFor("superadmin@altbank.ng");
    await approveTemplate(sa, (await db.query("SELECT id FROM offer_templates WHERE status = 'ACTIVE' AND doc_type = 'OFFER_LETTER' AND applicant_type = 'INDIVIDUAL'")).rows[0].id);
    const r = await requestOfferLetterNow(await ctxFor("rm.ade@altbank.ng"), id);
    expect(r.templateVersion).toBe(1);
    expect((await liveOfferLetter(db, id))!.status).toBe("ISSUED");
  });

  it("record customer acceptance from the signed upload, and the pack needs it", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    const rm = await ctxFor("rm.ade@altbank.ng");
    // A signed copy cannot be uploaded before the letter exists.
    await expect(uploadDocument(rm, { applicationId: id, category: "SIGNED_OFFER", filename: "s.pdf", data: makePdf("signed") })).rejects.toThrow(/has not been issued yet/);
    await processDueOfferLetters();
    for (const c of ["KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"]) await uploadDocument(rm, { applicationId: id, category: c, filename: `${c}.pdf`, data: makePdf(c) });
    await expect(act(id, "SUBMIT_PACK")).rejects.toThrow(/customer-signed offer letter/);
    const signed = await uploadDocument(rm, { applicationId: id, category: "SIGNED_OFFER", filename: "s.pdf", data: makePdf("signed") });
    const l = (await liveOfferLetter(db, id))!;
    expect(l).toMatchObject({ acceptance_status: "SIGNED", signed_document_id: signed.id });
    expect((await audits("OFFER_LETTER_SIGNED"))[0].details).toMatchObject({ offerLetterId: l.id, templateVersion: 1 });
    await act(id, "SUBMIT_PACK");
    expect((await openTaskOf(id)).stage).toBe("CO3_PACK_REVIEW");
  });

  it("keep issued letters linked to their template version after a new version is activated", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await driveToOffer(id);
    await processDueOfferLetters();
    const before = (await liveOfferLetter(db, id))!;
    const sa = await ctxFor("superadmin@altbank.ng");
    const v2 = await createDocxTemplateVersion(sa, { name: "Murabaha Individual Offer", applicantType: "INDIVIDUAL", filename: "v2.docx", data: readFileSync("templates/offers/murabaha-individual.docx"), productionApproved: true });
    await activateTemplate(sa, v2);
    const after = (await liveOfferLetter(db, id))!;
    expect(after.template_version).toBe(before.template_version);
    expect(after.template_id).toBe(before.template_id);
    const doc = (await db.query("SELECT template_id, template_version FROM documents WHERE id = $1", [before.docx_document_id])).rows[0];
    expect(doc).toEqual({ template_id: before.template_id, template_version: 1 });
    expect((await db.query("SELECT status FROM offer_templates WHERE id = $1", [before.template_id])).rows[0].status).toBe("RETIRED");
  });
});

describe("Murabaha-only templates", () => {
  it("refuse a letter that is not Murabaha or that describes an interest rate", async () => {
    const tpl = readFileSync("templates/offers/murabaha-individual.docx");
    const swap = async (from: RegExp, to: string) => {
      const z = await JSZip.loadAsync(tpl);
      z.file("word/document.xml", (await z.file("word/document.xml")!.async("string")).replace(from, to));
      return z.generateAsync({ type: "nodebuffer" });
    };
    expect((await validateDocxTemplate(await swap(/Murabaha/gi, "Term Loan"), "INDIVIDUAL")).join(" ")).toMatch(/not a Murabaha offer letter/);
    expect((await validateDocxTemplate(await swap(/<w:t>([^<]*Murabaha)/, "<w:t>The interest rate is 25% p.a. $1"), "INDIVIDUAL")).join(" ")).toMatch(/interest rate/);
    const sa = await ctxFor("superadmin@altbank.ng");
    await expect(createDocxTemplateVersion(sa, { name: "Conventional", applicantType: "INDIVIDUAL", filename: "c.docx", data: await swap(/Murabaha/gi, "Term Loan"), productionApproved: true })).rejects.toThrow(/not a Murabaha offer letter/);
  });
});
