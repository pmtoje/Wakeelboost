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
import { prefillForms, prefillFormsNow, signOnTablet, requiredSigners } from "@/server/domain/disbursement-docs";
import { createSubmittedCase, ctxFor, driveToOffer, makePdf } from "@/server/demo/scenario";
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

async function offerReady(type: "INDIVIDUAL" | "LIMITED" = "INDIVIDUAL") {
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
  it("prefills each bank form that has an active template, and skips the rest", async () => {
    await installFormTemplate("PRE_DISBURSEMENT");
    const id = await offerReady();
    const r = await prefillForms(id);
    // Already prepared alongside the offer letter: nothing new to do.
    expect(r.skipped).toEqual(["PRE_DISBURSEMENT"]);
    expect(r.missingTemplate.sort()).toEqual(["GSI_FORM", "INSURANCE_SIGNED"]);
    const doc = (await db.query("SELECT * FROM documents WHERE application_id = $1 AND category = 'PREFILLED_PRE_DISBURSEMENT'", [id])).rows[0];
    expect(doc.filename).toMatch(/^Pre-disbursement/);
    const app = (await db.query("SELECT ref, customer_name FROM applications WHERE id = $1", [id])).rows[0];
    const { text } = await docText(doc.id, RM);
    expect(text).toContain(app.customer_name);
    expect((await audits("FORM_PREFILLED")).length).toBe(1);
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
    await expect(signOnTablet(ctx, id, "PRE_DISBURSEMENT", [{ role: "CUSTOMER", name: "Busayo Okon", signaturePng: signaturePng() }])).rejects.toThrow(/no prepared/i);
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
});
