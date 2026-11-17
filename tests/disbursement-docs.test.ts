import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { readDocumentForActor, uploadDocument } from "@/server/domain/documents";
import { activateTemplate, createDocxTemplateVersion } from "@/server/domain/admin";
import { liveOfferLetter, processDueOfferLetters } from "@/server/domain/offer-letters";
import { prefillForms, prefillFormsNow, processDueSaleContracts, signOnTablet, requiredSigners } from "@/server/domain/disbursement-docs";
import { act, createSubmittedCase, ctxFor, driveToOffer, makePdf, openTaskOf } from "@/server/demo/scenario";
import { audits, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

/** A real PNG (noisy strokes) so it passes the signature checks. */
function signaturePng(w = 300, h = 100): string {
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  const noise = randomBytes(w * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) if (noise[y * w + x] < 40) raw.fill(20, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function docText(docId: string, email: string) {
  const { data } = await readDocumentForActor(await ctxFor(email), docId, "download");
  const z = await JSZip.loadAsync(data);
  return { zip: z, text: (await z.file("word/document.xml")!.async("string")).replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "") };
}

async function offerReady(type: "INDIVIDUAL" | "ENTERPRISE" | "LIMITED" = "INDIVIDUAL") {
  const id = await createSubmittedCase({ initiator: "RM", type, amountKobo: NAIRA(2_000_000) });
  await driveToOffer(id);
  await processDueOfferLetters();
  return id;
}

/** Stand-in for a bank form template (the real Word forms come from the bank). */
async function installFormTemplate(docType: "PRE_DISBURSEMENT" | "GSI_FORM", approved = true) {
  const sa = await ctxFor("superadmin@altbank.ng");
  const tid = await createDocxTemplateVersion(sa, { name: `Test ${docType}`, applicantType: "ALL", docType, filename: "form.docx", data: readFileSync("templates/offers/murabaha-individual.docx"), productionApproved: approved });
  await activateTemplate(sa, tid);
  return tid;
}

const RM = "rm.ade@altbank.ng";

describe("disbursement documents", () => {
  it("prepares the bank's pre-disbursement agreement with the letter, filled from the facility record", async () => {
    const id = await offerReady();
    const r = await prefillForms(id);
    // Already prepared alongside the offer letter: nothing new to do. The sale contract waits for vendor payment.
    expect(r.skipped.sort()).toEqual(["POST_DISBURSEMENT", "PRE_DISBURSEMENT"]);
    expect(r.missingTemplate.sort()).toEqual(["GSI_FORM", "INSURANCE_SIGNED"]);
    const doc = (await db.query("SELECT * FROM documents WHERE application_id = $1 AND category = 'PREFILLED_PRE_DISBURSEMENT'", [id])).rows[0];
    expect(doc.filename).toMatch(/^Pre-disbursement/);
    const app = (await db.query("SELECT customer_name FROM applications WHERE id = $1", [id])).rows[0];
    const asmt = (await db.query("SELECT a.* FROM credit_assessments a JOIN offer_letters l ON l.assessment_id = a.id WHERE l.application_id = $1", [id])).rows[0];
    const { text } = await docText(doc.id, RM);
    const N = (k: number | string) => `N${(Number(k) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
    expect(text).toContain(app.customer_name);
    expect(text).toContain(N(NAIRA(2_000_000)));
    expect(text).toContain(N(asmt.cost_plus_markup_kobo));
    expect(text).toContain(N(asmt.markup_kobo));
    expect(text).toMatch(/OFFER LETTER dated the \d+(st|nd|rd|th) day of \w+ 20\d\d/);
    expect(text).toContain("HAMISH JIDDIYAH"); // bank wording unchanged; deposit left for completion by hand
    // Paper copy is complete: the bank's signatories are named, as on the offer letter
    const people = (await db.query("SELECT e.full_name AS endorser FROM applications a JOIN staff e ON e.id = a.endorser_id WHERE a.id = $1", [id])).rows[0];
    expect(text).toContain(`Name: ${people.endorser}`);
    expect(text).toMatch(/Title: Regional Business Executive/);
    expect(text).not.toMatch(/\{\{/);
    expect((await audits("FORM_PREFILLED")).length).toBe(1);
  });

  it("uses the Enterprise and Company agreements for those applicant types", async () => {
    const ent = await offerReady("ENTERPRISE");
    const e = (await db.query("SELECT d.id, v.data FROM documents d JOIN applications a ON a.id = d.application_id JOIN application_versions v ON v.id = a.current_version_id WHERE d.application_id = $1 AND d.category = 'PREFILLED_PRE_DISBURSEMENT'", [ent])).rows[0];
    const et = (await docText(e.id, RM)).text;
    expect(et).toContain(`${e.data.customerName} (trading in the Name and Style of ${e.data.businessName})`);
    const co = await offerReady("LIMITED");
    const c = (await db.query("SELECT d.id, v.data FROM documents d JOIN applications a ON a.id = d.application_id JOIN application_versions v ON v.id = a.current_version_id WHERE d.application_id = $1 AND d.category = 'PREFILLED_PRE_DISBURSEMENT'", [co])).rows[0];
    const ct = (await docText(c.id, RM)).text;
    expect(ct).toContain(`SIGNED FOR AND ON BEHALF OF ${c.data.companyName}`);
    const dirs = (await db.query("SELECT d.full_name FROM application_directors d JOIN applications a ON a.current_version_id = d.version_id WHERE a.id = $1 ORDER BY d.position", [co])).rows;
    expect(ct).toContain(`Name: ${dirs[0].full_name}`);
    expect(ct).toContain("Title: Relationship Manager");
  });

  it("prints the customer's AltBank account when captured, a dotted line when not", async () => {
    const id = await offerReady();
    const doc = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'PREFILLED_PRE_DISBURSEMENT'", [id])).rows[0];
    expect((await docText(doc.id, RM)).text).toMatch(/Account No\. …+/);
    await db.query("UPDATE application_versions SET data = data || '{\"customerAccount\":\"0123456789\"}' WHERE id = (SELECT current_version_id FROM applications WHERE id = $1)", [id]);
    await db.query("UPDATE documents SET superseded_at = now() WHERE application_id = $1 AND category LIKE 'PREFILLED_%'", [id]);
    await prefillForms(id);
    const fresh = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'PREFILLED_PRE_DISBURSEMENT' AND superseded_at IS NULL", [id])).rows[0];
    expect((await docText(fresh.id, RM)).text.match(/0123456789/g)).toHaveLength(2);
  });

  it("only lets the initiator holding offer preparation prepare forms or sign", async () => {
    const id = await offerReady();
    await expect(prefillFormsNow(await ctxFor("co1@altbank.ng"), id)).rejects.toThrow(/initiator/);
    await expect(signOnTablet(await ctxFor("co1@altbank.ng"), id, "OFFER_LETTER", [])).rejects.toThrow(/initiator/);
    expect((await audits("DOCUMENT_SIGNED_ON_TABLET")).some((a) => a.outcome === "DENIED")).toBe(true);
  });

  it("signs the offer letter on the tablet: signature page appended, filed as the signed offer, acceptance recorded", async () => {
    const id = await offerReady();
    const ctx = await ctxFor(RM, new Date(), { ip: "10.1.2.3", userAgent: "Tablet/1.0" });
    // Witness details are required on the offer letter
    await expect(signOnTablet(ctx, id, "OFFER_LETTER", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }])).rejects.toMatchObject({ fields: { WITNESS: expect.any(String) } });
    const r = await signOnTablet(ctx, id, "OFFER_LETTER", [
      { role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() },
      { role: "WITNESS", name: "Kemi Adeyemi", address: "12 Marina, Lagos", occupation: "Trader", signaturePng: signaturePng() },
    ]);
    const signed = (await db.query("SELECT * FROM documents WHERE id = $1", [r.documentId])).rows[0];
    expect(signed.category).toBe("SIGNED_OFFER");
    const { zip, text } = await docText(r.documentId, RM);
    expect(text).toContain("Electronic signature page");
    expect(text).toContain("Busayo Okon");
    expect(text).toContain("12 Marina, Lagos");
    expect(Object.keys(zip.files).filter((f) => f.startsWith("word/media/esign-"))).toHaveLength(2);
    expect((await liveOfferLetter(db, id))!.acceptance_status).toBe("SIGNED");
    const sig = (await db.query("SELECT * FROM e_signatures WHERE application_id = $1", [id])).rows[0];
    const letter = (await liveOfferLetter(db, id))!;
    expect(sig).toMatchObject({ doc_type: "OFFER_LETTER", source_document_id: letter.docx_document_id, signed_document_id: r.documentId, client_ip: "10.1.2.3", user_agent: "Tablet/1.0" });
    expect(sig.signers.map((s: { role: string }) => s.role)).toEqual(["CUSTOMER", "WITNESS"]);
    expect(sig.signers[0].signatureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.source_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("corporate letters take one or two authorised signatories with designations", async () => {
    expect(requiredSigners("OFFER_LETTER", "LIMITED")).toEqual({ required: ["SIGNATORY_1"], optional: ["SIGNATORY_2"] });
    const id = await offerReady("LIMITED");
    const ctx = await ctxFor(RM);
    await expect(signOnTablet(ctx, id, "OFFER_LETTER", [{ role: "SIGNATORY_1", name: "Ada Obi", signaturePng: signaturePng() }])).rejects.toMatchObject({ fields: { "SIGNATORY_1.designation": expect.any(String) } });
    await expect(signOnTablet(ctx, id, "OFFER_LETTER", [{ role: "CUSTOMER", name: "Ada Obi", signaturePng: signaturePng() }])).rejects.toMatchObject({ fields: { SIGNATORY_1: expect.any(String), CUSTOMER: expect.any(String) } });
    await signOnTablet(ctx, id, "OFFER_LETTER", [
      { role: "SIGNATORY_1", name: "Ada Obi", designation: "Managing Director", signaturePng: signaturePng() },
      { role: "SIGNATORY_2", name: "Uche Eze", designation: "Company Secretary", signaturePng: signaturePng() },
    ]);
    expect((await liveOfferLetter(db, id))!.acceptance_status).toBe("SIGNED");
  });

  it("rejects blank or forged signature images", async () => {
    const id = await offerReady();
    const ctx = await ctxFor(RM);
    const witness = { role: "WITNESS" as const, name: "Kemi Adeyemi", address: "Lagos", occupation: "Trader", signaturePng: signaturePng() };
    await expect(signOnTablet(ctx, id, "OFFER_LETTER", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: "data:image/png;base64,AAAA" }, witness])).rejects.toThrow();
    await expect(signOnTablet(ctx, id, "OFFER_LETTER", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: Buffer.from("<svg/>").toString("base64") }, witness])).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int AS n FROM e_signatures")).rows[0].n).toBe(0);
  });

  it("signs a prepared form, and a later paper upload replaces it while keeping both versions", async () => {
    await installFormTemplate("GSI_FORM");
    const id = await offerReady();
    const ctx = await ctxFor(RM);
    await expect(signOnTablet(ctx, id, "INSURANCE_SIGNED", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }])).rejects.toThrow(/no prepared/i);
    const r = await signOnTablet(ctx, id, "GSI_FORM", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }]);
    expect((await db.query("SELECT category FROM documents WHERE id = $1", [r.documentId])).rows[0].category).toBe("GSI_FORM");
    await uploadDocument(ctx, { applicationId: id, category: "GSI_FORM", filename: "gsi-paper.pdf", data: makePdf("GSI signed on paper") });
    const versions = (await db.query("SELECT version_no, superseded_at FROM documents WHERE application_id = $1 AND category = 'GSI_FORM' ORDER BY version_no", [id])).rows;
    expect(versions).toHaveLength(2);
    expect(versions[0].superseded_at).not.toBeNull();
    expect(versions[1].superseded_at).toBeNull();
  });

  it("does not let anyone upload a 'prepared' form by hand", async () => {
    const id = await offerReady();
    await expect(uploadDocument(await ctxFor(RM), { applicationId: id, category: "PREFILLED_GSI_FORM", filename: "x.pdf", data: makePdf("x") })).rejects.toThrow(/generated/i);
  });

  it("form templates still refuse interest-rate wording", async () => {
    const z = await JSZip.loadAsync(readFileSync("templates/offers/murabaha-individual.docx"));
    const xml = await z.file("word/document.xml")!.async("string");
    z.file("word/document.xml", xml.replace("Murabaha", "Interest rate"));
    const data = await z.generateAsync({ type: "nodebuffer" });
    await expect(createDocxTemplateVersion(await ctxFor("superadmin@altbank.ng"), { name: "Bad form", applicantType: "ALL", docType: "GSI_FORM", filename: "f.docx", data, productionApproved: true })).rejects.toThrow(/interest/i);
  });

  it("prepares the Murabaha sale contract only after the vendor is paid, and the initiator signs it there", async () => {
    const id = await offerReady();
    const ctx = await ctxFor(RM);
    await expect(signOnTablet(ctx, id, "POST_DISBURSEMENT", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }])).rejects.toThrow(/vendor payment confirmation/);
    expect((await db.query("SELECT count(*)::int AS n FROM documents WHERE application_id = $1 AND category = 'PREFILLED_POST_DISBURSEMENT'", [id])).rows[0].n).toBe(0);
    await driveToVendorConfirmation(id);
    // The worker prepares it (inline generation is off in tests).
    expect(await processDueSaleContracts()).toBe(1);
    expect(await processDueSaleContracts()).toBe(0);
    const doc = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category = 'PREFILLED_POST_DISBURSEMENT'", [id])).rows[0];
    const { text } = await docText(doc.id, RM);
    const items = (await db.query("SELECT v.data FROM applications a JOIN application_versions v ON v.id = a.current_version_id WHERE a.id = $1", [id])).rows[0].data.items;
    expect(text).toContain(items[0].description);
    expect(text).toMatch(/Tenor- \d+ months/);
    expect(text).toContain("RECEIPT OF ASSET");
    expect(text).not.toMatch(/\{\{/);
    const s = await signOnTablet(ctx, id, "POST_DISBURSEMENT", [
      { role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() },
      { role: "WITNESS", name: "Kemi Adeyemi", signaturePng: signaturePng() },
    ]);
    expect((await db.query("SELECT category FROM documents WHERE id = $1", [s.documentId])).rows[0].category).toBe("POST_DISBURSEMENT");
    // Offer-stage documents can no longer be signed
    await expect(signOnTablet(ctx, id, "PRE_DISBURSEMENT", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }])).rejects.toThrow(/offer pack preparation/);
  });

  it("the bank's agreement templates are seeded active and approved", async () => {
    const rows = (await db.query("SELECT doc_type, applicant_type, production_approved, status FROM offer_templates WHERE doc_type <> 'OFFER_LETTER' ORDER BY doc_type, applicant_type")).rows;
    expect(rows).toEqual([
      { doc_type: "POST_DISBURSEMENT", applicant_type: "ENTERPRISE", production_approved: true, status: "ACTIVE" },
      { doc_type: "POST_DISBURSEMENT", applicant_type: "INDIVIDUAL", production_approved: true, status: "ACTIVE" },
      { doc_type: "PRE_DISBURSEMENT", applicant_type: "ENTERPRISE", production_approved: true, status: "ACTIVE" },
      { doc_type: "PRE_DISBURSEMENT", applicant_type: "INDIVIDUAL", production_approved: true, status: "ACTIVE" },
      { doc_type: "PRE_DISBURSEMENT", applicant_type: "LIMITED", production_approved: true, status: "ACTIVE" },
    ]);
  });

  it("re-seeding installs a changed agreement file as a new version and keeps the old one for documents already made", async () => {
    const { seedAgreementTemplates } = await import("@/server/demo/seed");
    await seedAgreementTemplates(db);
    expect((await db.query("SELECT count(*)::int AS n FROM offer_templates WHERE doc_type <> 'OFFER_LETTER'")).rows[0].n).toBe(5);
    await db.query("UPDATE offer_templates SET notes = 'older file' WHERE doc_type = 'PRE_DISBURSEMENT' AND applicant_type = 'INDIVIDUAL'");
    await seedAgreementTemplates(db);
    const rows = (await db.query("SELECT version, status FROM offer_templates WHERE doc_type = 'PRE_DISBURSEMENT' AND applicant_type = 'INDIVIDUAL' ORDER BY version")).rows;
    expect(rows).toEqual([{ version: 1, status: "RETIRED" }, { version: 2, status: "ACTIVE" }]);
  });

  it("download, sign on paper and re-upload against the same document", async () => {
    const id = await offerReady();
    const ctx = await ctxFor(RM);
    const prepared = (await db.query("SELECT id FROM documents WHERE application_id = $1 AND category IN ('PREFILLED_PRE_DISBURSEMENT','PREFILLED_PRE_DISBURSEMENT_PDF') AND superseded_at IS NULL", [id])).rows;
    for (const d of prepared) expect((await readDocumentForActor(ctx, d.id, "download")).data.length).toBeGreaterThan(1000);
    await signOnTablet(ctx, id, "PRE_DISBURSEMENT", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }]);
    await uploadDocument(ctx, { applicationId: id, category: "PRE_DISBURSEMENT", filename: "signed-on-paper.pdf", data: makePdf("signed on paper") });
    const v = (await db.query("SELECT filename, superseded_at FROM documents WHERE application_id = $1 AND category = 'PRE_DISBURSEMENT' ORDER BY version_no", [id])).rows;
    expect(v.map((x) => [x.filename.startsWith("Signed-"), x.superseded_at === null])).toEqual([[true, false], [false, true]]);
  });
});

async function driveToVendorConfirmation(id: string) {
  const t = await openTaskOf(id);
  const ctx = await ctxFor(t.email!);
  for (const c of ["SIGNED_OFFER", "KYC", "PRE_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"]) await uploadDocument(ctx, { applicationId: id, category: c, filename: `${c}.pdf`, data: makePdf(c) });
  await act(id, "SUBMIT_PACK");
  const co3 = await ctxFor((await openTaskOf(id)).email!);
  await uploadDocument(co3, { applicationId: id, category: "INSURANCE_EVIDENCE", filename: "ev.pdf", data: makePdf("evidence") });
  await act(id, "FORWARD");
  await act(id, "OKAY", { crmsLogged: true });
  const app = (await db.query("SELECT requested_amount_kobo FROM applications WHERE id = $1", [id])).rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await act(id, "DISBURSED", { booking: { amountKobo: Number(app.requested_amount_kobo), disbursedOn: today, transactionRef: `TRX${Date.now()}`, schedule: [{ dueDate: due, amountKobo: Number(app.requested_amount_kobo) }] } });
  await act(id, "COMPLETE_PROCESS");
  expect((await openTaskOf(id)).stage).toBe("VENDOR_CONFIRMATION");
}
