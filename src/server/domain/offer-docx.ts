import JSZip from "jszip";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { invalid } from "../errors";
import type { ApplicantType } from "./application-data";

/**
 * DOCX offer templates (the bank's Word letters with {{placeholders}}).
 *  - `{{key}}` is replaced in document, header and footer parts (values are XML-escaped).
 *  - A paragraph containing `{{#list}} ... {{/list}}` is repeated once per item of `list`
 *    (used for directors 2..n of a Limited company); it is removed when the list is empty.
 * Placeholders must each sit inside one text run; `validateDocxTemplate` checks this.
 */
export type DocxValues = Record<string, string>;
export type DocxLoops = Record<string, DocxValues[]>;

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;
const TOKEN = /\{\{([#/]?)([a-z0-9_]+)\}\}/g;
const PARA = /<w:p[\s>](?:(?!<w:p[\s>]).)*?<\/w:p>/gs;

function xmlEscape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function fill(xml: string, values: DocxValues) {
  return xml.replace(TOKEN, (m, flag: string, key: string) => (flag ? m : key in values ? xmlEscape(values[key]) : m));
}

export async function renderDocx(template: Buffer, values: DocxValues, loops: DocxLoops = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(template);
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    let xml = await zip.file(name)!.async("string");
    xml = xml.replace(PARA, (p) => {
      const m = /\{\{#([a-z0-9_]+)\}\}/.exec(p);
      if (!m) return p;
      const items = loops[m[1]] ?? [];
      const body = p.replace(`{{#${m[1]}}}`, "").replace(`{{/${m[1]}}}`, "");
      return items.map((it) => fill(body, { ...values, ...it })).join("");
    });
    xml = fill(xml, values);
    const left = /\{\{[#/]?[a-z0-9_]+\}\}/.exec(xml.replace(/<[^>]+>/g, ""));
    if (left) throw new Error(`Offer template placeholder ${left[0]} has no value`);
    zip.file(name, xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Placeholders every DOCX template must contain, by applicant type. */
export const REQUIRED_DOCX_PLACEHOLDERS: Record<ApplicantType, string[]> = {
  INDIVIDUAL: ["offer_date", "customer_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "bvn"],
  ENTERPRISE: ["offer_date", "proprietor_name", "business_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "bvn", "tin"],
  LIMITED: ["offer_date", "company_name", "cost_price", "markup_rate_tenor", "cost_plus_markup", "apr", "tenor_months", "financed_items", "tin", "first_director_name", "first_director_bvn", "#directors_rest", "director_name", "director_bvn"],
};

/** All placeholders the renderer can supply (anything else in a template is rejected). */
export const KNOWN_DOCX_PLACEHOLDERS = new Set([
  "offer_date", "request_ref", "customer_name", "proprietor_name", "business_name", "company_name", "customer_address",
  "registration_number", "facility_type", "cost_price", "cost_price_words", "markup", "markup_rate_tenor", "markup_rate_annual",
  "cost_plus_markup", "cost_plus_markup_words", "apr", "tenor_months", "financed_items", "asset_cost", "instalment_frequency",
  "instalment_amount", "takaful_rate", "stamp_duty_rate", "bvn", "tin", "first_director_name", "first_director_bvn",
  "director_index", "director_name", "director_bvn", "signatory_1_name", "signatory_1_title", "signatory_2_name", "signatory_2_title",
  "supplier_name", "supplier_address", "supplier_phone", "supplier_account", "invoice_ref", "customer_phone", "customer_email", "pos_serial", "dao_code",
  "agreement_day", "agreement_month_year", "offer_letter_day", "offer_letter_month_year", "customer_account",
  "item_1_description", "item_1_units", "item_2_description", "item_2_units", "item_3_description", "item_3_units",
  "#directors_rest", "/directors_rest",
]);

/** Where each placeholder is populated from (shown to administrators as the variable mapping). */
export const PLACEHOLDER_SOURCES: Record<string, string> = {
  offer_date: "Date the letter is issued (Lagos)",
  request_ref: "Facility reference (WB-…)",
  customer_name: "Applicant legal name (Individual name / Name trading as Business / Company)",
  proprietor_name: "Proprietor legal name (Enterprise)",
  business_name: "Registered business name (Enterprise)",
  company_name: "Company name (Corporate)",
  customer_address: "Business address",
  registration_number: "CAC registration number",
  facility_type: "Always Murabaha",
  cost_price: "Approved asset cost (principal) from the approved assessment",
  cost_price_words: "Approved asset cost in words",
  markup: "Murabaha markup amount from the approved assessment",
  markup_rate_tenor: "Flat markup rate for the tenor (pricing settings)",
  markup_rate_annual: "Annual markup rate (legacy calculators only)",
  cost_plus_markup: "Total selling price (cost plus markup)",
  cost_plus_markup_words: "Total selling price in words",
  apr: "APR disclosure from the approved assessment",
  tenor_months: "Approved tenor in months",
  financed_items: "Goods financed (quantity and description)",
  asset_cost: "Sum of item costs on the request",
  instalment_frequency: "Monthly or weekly",
  instalment_amount: "Periodic instalment from the approved assessment",
  takaful_rate: "Takaful contribution %",
  stamp_duty_rate: "Stamp duty %",
  bvn: "Applicant / proprietor BVN (decrypted only into the letter)",
  tin: "TIN",
  first_director_name: "First director (Corporate)",
  first_director_bvn: "First director BVN (Corporate)",
  director_index: "Director number (repeating section)",
  director_name: "Director name (repeating section)",
  director_bvn: "Director BVN (repeating section)",
  signatory_1_name: "First signatory (endorser, or RM on Corporate letters)",
  signatory_1_title: "First signatory title",
  signatory_2_name: "Second signatory (Offer templates settings, or endorser on Corporate letters)",
  signatory_2_title: "Second signatory title",
  agreement_day: "Day the agreement is prepared, e.g. 17th (Lagos)",
  agreement_month_year: "Month and year the agreement is prepared, e.g. November 2026",
  offer_letter_day: "Day the Murabaha offer letter was issued",
  offer_letter_month_year: "Month and year the offer letter was issued",
  customer_account: "Customer's AltBank account number (dotted line when not captured)",
  item_1_description: "Goods line 1 (sale contract asset table)",
  item_1_units: "Goods line 1 quantity",
  item_2_description: "Goods line 2",
  item_2_units: "Goods line 2 quantity",
  item_3_description: "Goods line 3 (remaining lines combined when there are more than three)",
  item_3_units: "Goods line 3 quantity",
  "#directors_rest": "Start of repeating director paragraph",
  "/directors_rest": "End of repeating director paragraph",
};

/** Placeholders used by a template, in order of first appearance. */
export async function docxPlaceholders(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const out: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    for (const m of xml.replace(/<[^>]+>/g, "").matchAll(TOKEN)) if (!out.includes(m[1] + m[2])) out.push(m[1] + m[2]);
  }
  return out;
}

export type TemplateDocType = "OFFER_LETTER" | "PRE_DISBURSEMENT" | "POST_DISBURSEMENT" | "GSI_FORM" | "INSURANCE_SIGNED";
export const TEMPLATE_DOC_TYPES: TemplateDocType[] = ["OFFER_LETTER", "PRE_DISBURSEMENT", "POST_DISBURSEMENT", "GSI_FORM", "INSURANCE_SIGNED"];
/** Every disbursement form (not the offer letter) must name the customer with one of these. */
export const REQUIRED_FORM_PLACEHOLDERS = ["customer_name"];
const FORM_NAME_PLACEHOLDERS = ["customer_name", "proprietor_name", "company_name"];

/** Validate an uploaded DOCX template: readable, placeholders intact (one run each), required ones present. */
export async function validateDocxTemplate(buf: Buffer, type: ApplicantType | null, docType: TemplateDocType = "OFFER_LETTER"): Promise<string[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    return ["The file is not a valid .docx document."];
  }
  if (!zip.file("word/document.xml")) return ["The file is not a Word document (word/document.xml missing)."];
  const errors: string[] = [];
  const found = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    if (!PARTS.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    const intact = new Set([...xml.matchAll(TOKEN)].map((m) => m[1] + m[2]));
    const plain = new Set([...xml.replace(/<[^>]+>/g, "").matchAll(TOKEN)].map((m) => m[1] + m[2]));
    for (const t of plain) {
      if (!intact.has(t)) errors.push(`Placeholder {{${t}}} is split by Word formatting in ${name}. Retype it in one go (no formatting changes inside the braces).`);
      found.add(t);
    }
    if (/<w:drawing[\s\S]*?<\/w:drawing>/.test(xml) && /signature/i.test(xml)) errors.push("Templates must not contain signature images.");
  }
  // WakeelBoost is Murabaha (cost plus markup) only: refuse conventional or unrelated letters.
  const text = (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (docType === "OFFER_LETTER" && !/murabaha/i.test(text)) errors.push("This is not a Murabaha offer letter: the wording must name the Murabaha (cost plus markup) structure.");
  if (/interest\s+rate|rate\s+of\s+interest/i.test(text)) errors.push("The letter describes an interest rate. WakeelBoost letters use Murabaha markup terminology only.");
  for (const t of found) if (!KNOWN_DOCX_PLACEHOLDERS.has(t)) errors.push(`Unknown placeholder {{${t}}}.`);
  const required = docType === "OFFER_LETTER" ? (type ? REQUIRED_DOCX_PLACEHOLDERS[type] : []) : [];
  for (const r of required) if (!found.has(r)) errors.push(`Missing placeholder {{${r}}}.`);
  if (docType !== "OFFER_LETTER" && !FORM_NAME_PLACEHOLDERS.some((r) => found.has(r))) errors.push("Missing placeholder {{customer_name}} (or {{proprietor_name}} / {{company_name}}).");
  if (found.has("#directors_rest") !== found.has("/directors_rest")) errors.push("The {{#directors_rest}} … {{/directors_rest}} markers must both be in the same paragraph.");
  return [...new Set(errors)];
}

/**
 * Optional PDF copy for in-browser preview, using LibreOffice when available
 * (OFFER_PDF_CONVERTER=soffice, default when /usr/bin/soffice exists). The DOCX remains the
 * editable original; failure to convert never blocks offer generation.
 */
export async function docxToPdf(docx: Buffer): Promise<Buffer | null> {
  const mode = process.env.OFFER_PDF_CONVERTER ?? (existsSync("/usr/bin/soffice") ? "soffice" : "none");
  if (mode !== "soffice") return null;
  const bin = process.env.SOFFICE_PATH || "soffice";
  const dir = await mkdtemp(path.join(tmpdir(), "wb-offer-"));
  try {
    const src = path.join(dir, "offer.docx");
    await writeFile(src, docx);
    await new Promise<void>((resolve, reject) =>
      execFile(bin, ["--headless", "--norestore", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, src], { timeout: 90_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await readFile(path.join(dir, "offer.pdf"));
  } catch (e) {
    console.error("[offer] PDF conversion failed", e);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function assertDocx(buf: Buffer) {
  if (buf.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") throw invalid("Upload a .docx Word document.");
}

// ------------------------------------------------------------------ electronic signature page

export interface SignaturePageSigner {
  role: string; // e.g. "Customer", "Witness", "Authorised signatory 1"
  name: string;
  details?: [string, string][]; // extra lines (designation, address, occupation)
  png: Buffer; // signature drawn on the tablet
}
export interface SignaturePage {
  title: string;
  statement: string;
  signers: SignaturePageSigner[];
  record: [string, string][]; // signing record (document, checksum, time, captured by, device)
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, opts: { bold?: boolean; size?: number; pageBreak?: boolean; spacingAfter?: number } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="${opts.spacingAfter ?? 80}"/></w:pPr>${opts.pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : ""}${text ? `<w:r><w:rPr>${opts.bold ? "<w:b/>" : ""}<w:sz w:val="${(opts.size ?? 10) * 2}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>` : ""}</w:p>`;
function imagePara(rid: string, n: number, widthIn = 2.4, heightIn = 0.8) {
  const cx = Math.round(widthIn * 914400);
  const cy = Math.round(heightIn * 914400);
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9000 + n}" name="Signature ${n}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${9000 + n}" name="signature-${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Validate a signature drawn on the tablet: a PNG of sensible size. */
export function assertSignaturePng(buf: Buffer) {
  if (buf.length < 600 || buf.length > 400_000 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw invalid("Each signature must be drawn on the signature pad.");
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w < 100 || h < 40 || w > 4000 || h > 2000) throw invalid("The signature image has an unexpected size.");
}

/**
 * Append an electronic signature page to a Word document (after a page break, before the final
 * section settings). The original content is not changed.
 */
export async function appendSignaturePage(docx: Buffer, page: SignaturePage): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  const docPath = "word/document.xml";
  const relsPath = "word/_rels/document.xml.rels";
  let xml = await zip.file(docPath)!.async("string");
  let rels = (await zip.file(relsPath)?.async("string")) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  let ct = await zip.file("[Content_Types].xml")!.async("string");
  if (!/Extension="png"/i.test(ct)) ct = ct.replace("<Types ", "<Types ").replace(/<Default /, '<Default Extension="png" ContentType="image/png"/><Default ');
  const parts: string[] = [];
  parts.push(para("", { pageBreak: true }));
  parts.push(para(page.title, { bold: true, size: 14, spacingAfter: 160 }));
  parts.push(para(page.statement, { size: 10, spacingAfter: 200 }));
  page.signers.forEach((s, i) => {
    const n = i + 1;
    const rid = `rIdEsign${n}`;
    zip.file(`word/media/esign-${n}.png`, s.png);
    rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/esign-${n}.png"/></Relationships>`);
    parts.push(para(s.role, { bold: true, size: 11, spacingAfter: 40 }));
    parts.push(imagePara(rid, n));
    parts.push(para(`Name: ${s.name}`));
    for (const [k, v] of s.details ?? []) parts.push(para(`${k}: ${v}`));
    parts.push(para("", { spacingAfter: 160 }));
  });
  parts.push(para("Signing record", { bold: true, size: 11, spacingAfter: 40 }));
  for (const [k, v] of page.record) parts.push(para(`${k}: ${v}`, { size: 8, spacingAfter: 20 }));
  const block = parts.join("");
  const at = xml.lastIndexOf("<w:sectPr");
  const end = xml.lastIndexOf("</w:body>");
  const insertAt = at > -1 && at < end ? at : end;
  xml = xml.slice(0, insertAt) + block + xml.slice(insertAt);
  if (!xml.includes(W_NS.split("=")[0])) throw new Error("Unexpected Word document structure.");
  zip.file(docPath, xml);
  zip.file(relsPath, rels);
  zip.file("[Content_Types].xml", ct);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
