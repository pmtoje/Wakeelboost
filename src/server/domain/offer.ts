import type { Db } from "../db";
import type { Ctx } from "../context";
import { decryptField } from "../crypto";
import { forbidden, gate, invalid } from "../errors";
import { formatKobo } from "../money";
import { formatDateOnly, lagosDate } from "../time";
import { approvedAssessment } from "./assessment";
import { objectStore } from "../storage";
import { nairaInWords } from "../words";
import { docxToPdf, renderDocx } from "./offer-docx";
import { currentSecondSignatory } from "./signatory";
import { assetCostKobo, type ApplicantType, type DraftData } from "./application-data";

/**
 * Offer template placeholders. Templates are bank-owned HTML with these tokens:
 *   {{customer_name}} {{markup}} {{markup_rate}} {{financed_items}} {{asset_cost}} {{bvn}}
 *   {{cost_plus_markup}} {{tin}} {{request_ref}} {{offer_date}} {{tenor_months}} {{registration_number}}
 *   {{#directors}} ... {{director_name}} ... {{director_bvn}} ... {{/directors}}   (Limited only; repeats per director)
 *   {{#if_bvn}} ... {{/if_bvn}}  {{#if_tin}} ... {{/if_tin}}  (rendered only when the value applies)
 */
export const PLACEHOLDERS = [
  "customer_name",
  "markup",
  "markup_rate",
  "financed_items",
  "asset_cost",
  "bvn",
  "cost_plus_markup",
  "tin",
  "request_ref",
  "offer_date",
  "tenor_months",
  "registration_number",
  "director_name",
  "director_bvn",
] as const;

export interface OfferContext {
  applicantType: ApplicantType;
  data: DraftData;
  bvn: string | null;
  tin: string | null;
  directors: { fullName: string; bvn: string }[];
  markupKobo: number;
  markupRate: string;
  costPlusMarkupKobo: number;
  assetCostKobo: number;
  ref: string;
  offerDate: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Legal name used on the offer: Individual name / "Name trading as Business" / company name. */
export function offerCustomerName(type: ApplicantType, d: DraftData): string {
  if (type === "ENTERPRISE") return `${d.customerName} trading as ${d.businessName}`;
  if (type === "LIMITED") return d.companyName;
  return d.customerName;
}

export function renderOffer(templateHtml: string, c: OfferContext): string {
  const itemsRows = c.data.items
    .map(
      (i) =>
        `<tr><td>${escapeHtml(i.description)}</td><td style="text-align:right">${i.quantity}</td><td style="text-align:right">${formatKobo(i.unitCostKobo)}</td><td style="text-align:right">${formatKobo(i.quantity * i.unitCostKobo)}</td></tr>`,
    )
    .join("");
  const itemsTable = `<table class="items" style="border-collapse:collapse;width:100%" border="1" cellpadding="6"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th>Total</th></tr></thead><tbody>${itemsRows}</tbody></table>`;

  const values: Record<string, string> = {
    customer_name: escapeHtml(offerCustomerName(c.applicantType, c.data)),
    markup: formatKobo(c.markupKobo),
    markup_rate: escapeHtml(c.markupRate),
    financed_items: itemsTable,
    asset_cost: formatKobo(c.assetCostKobo),
    bvn: escapeHtml(c.bvn ?? ""),
    cost_plus_markup: formatKobo(c.costPlusMarkupKobo),
    tin: escapeHtml(c.tin ?? ""),
    request_ref: escapeHtml(c.ref),
    offer_date: escapeHtml(c.offerDate),
    tenor_months: String(c.data.tenorMonths ?? ""),
    registration_number: escapeHtml(c.data.registrationNumber),
  };

  let html = templateHtml;
  // Repeating director section
  html = html.replace(/\{\{#directors\}\}([\s\S]*?)\{\{\/directors\}\}/g, (_m, inner: string) =>
    c.applicantType === "LIMITED"
      ? c.directors
          .map((d) => inner.replace(/\{\{director_name\}\}/g, escapeHtml(d.fullName)).replace(/\{\{director_bvn\}\}/g, escapeHtml(d.bvn)))
          .join("")
      : "",
  );
  html = html.replace(/\{\{#if_bvn\}\}([\s\S]*?)\{\{\/if_bvn\}\}/g, (_m, inner) => (c.bvn ? inner : ""));
  html = html.replace(/\{\{#if_tin\}\}([\s\S]*?)\{\{\/if_tin\}\}/g, (_m, inner) => (c.tin ? inner : ""));
  html = html.replace(/\{\{([a-z_]+)\}\}/g, (m, key: string) => (key in values ? values[key] : m));
  return html;
}

/** Validate a template before it can be saved: every required placeholder must be present. */
export function validateTemplate(html: string): string[] {
  const required = ["customer_name", "markup", "financed_items", "asset_cost", "bvn", "cost_plus_markup", "tin"];
  const missing = required.filter((p) => !html.includes(`{{${p}}}`));
  const errors = missing.map((m) => `Missing placeholder {{${m}}}`);
  if (!/\{\{#directors\}\}[\s\S]*\{\{director_name\}\}[\s\S]*\{\{director_bvn\}\}[\s\S]*\{\{\/directors\}\}/.test(html)) {
    errors.push("Missing repeating director section {{#directors}} … {{director_name}} … {{director_bvn}} … {{/directors}}");
  }
  if (/<script/i.test(html)) errors.push("Templates must not contain scripts.");
  return errors;
}

/** Active template for an applicant type (type-specific first, then an all-types fallback). */
export async function activeTemplate(q: Db, applicantType?: ApplicantType) {
  return (
    (
      await q.query(
        `SELECT * FROM offer_templates WHERE status = 'ACTIVE' AND (applicant_type = $1 OR applicant_type IS NULL)
          ORDER BY applicant_type NULLS LAST LIMIT 1`,
        [applicantType ?? null],
      )
    ).rows[0] ?? null
  );
}

const N = (kobo: number) => formatKobo(kobo).replace("₦", "N");
function pctText(v: string | number) {
  const n = Number(v);
  return `${Number.isFinite(n) ? Number(n.toFixed(4)).toString() : String(v)}%`;
}
function ordinalDate(d: Date) {
  const [y, m, day] = lagosDate(d).split("-").map(Number);
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${day}${suffix} ${month} ${y}`;
}
function itemsText(items: DraftData["items"]) {
  const parts = items.map((i) => `${i.quantity.toLocaleString("en-NG")} ${i.description}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

export interface OfferData {
  app: { ref: string; applicant_type: ApplicantType; initiator_id: string; endorser_id: string | null; initiator_role: string };
  data: DraftData;
  bvn: string | null;
  tin: string | null;
  directors: { fullName: string; bvn: string }[];
  assessment: { inputs: Record<string, unknown>; outputs: Record<string, unknown>; apr_percent: string; markup_kobo: string | number; cost_plus_markup_kobo: string | number };
  people: { initiatorName: string; initiatorTitle: string; endorserName: string; endorserTitle: string; secondSignatoryName?: string; secondSignatoryTitle?: string };
  now: Date;
}

/** Values for the bank's DOCX offer letters (see templates/offers and docs/OFFER_TEMPLATES.md). */
export function offerDocxValues(o: OfferData): { values: Record<string, string>; loops: Record<string, Record<string, string>[]> } {
  const inp = o.assessment.inputs;
  const out = o.assessment.outputs;
  const L = Number(out.amountApprovedKobo ?? inp.amountApprovedKobo ?? inp.assetCostKobo ?? o.data.requestedAmountKobo ?? 0);
  const markup = Number(o.assessment.markup_kobo);
  const cpm = Number(o.assessment.cost_plus_markup_kobo);
  const ft = String(inp.facilityType ?? "MURABAHA");
  const freq = String(out.frequency ?? inp.frequency ?? "Monthly");
  const limited = o.app.applicant_type === "LIMITED";
  const [first, ...rest] = o.directors;
  const values: Record<string, string> = {
    offer_date: ordinalDate(o.now),
    request_ref: o.app.ref,
    customer_name: offerCustomerName(o.app.applicant_type, o.data),
    proprietor_name: o.data.customerName,
    business_name: o.data.businessName,
    company_name: o.data.companyName,
    customer_address: o.data.address || "",
    registration_number: o.data.registrationNumber,
    facility_type: ft.charAt(0) + ft.slice(1).toLowerCase(),
    cost_price: N(L),
    cost_price_words: nairaInWords(L),
    markup: N(markup),
    // Flat markup for the whole tenor (exact configured rate when the WakeelBoost calculator was used)
    markup_rate_tenor: out.flatMarkupRatePercent !== undefined ? pctText(String(out.flatMarkupRatePercent)) : L ? pctText(((markup / L) * 100).toFixed(2)) : "0%",
    markup_rate_annual: inp.markupRatePercent !== undefined ? pctText(String(inp.markupRatePercent)) : "",
    cost_plus_markup: N(cpm),
    cost_plus_markup_words: nairaInWords(cpm),
    apr: pctText(Number(o.assessment.apr_percent).toFixed(2)),
    tenor_months: String(inp.tenorMonths ?? o.data.tenorMonths ?? ""),
    financed_items: itemsText(o.data.items),
    asset_cost: N(assetCostKobo(o.data.items)),
    instalment_frequency: freq === "Bullet" ? "bullet" : freq.toLowerCase(),
    instalment_amount: out.periodicInstalmentKobo !== undefined ? N(Number(out.periodicInstalmentKobo)) : N(Math.ceil(cpm / Number(o.data.tenorMonths || 1))),
    takaful_rate: pctText(String(inp.takafulPercent ?? "0")),
    stamp_duty_rate: pctText(String(inp.stampDutyPercent ?? "0")),
    bvn: o.bvn ?? "",
    tin: o.tin ?? "",
    first_director_name: first?.fullName ?? "",
    first_director_bvn: first?.bvn ?? "",
    // Corporate letter: RM + business endorser. Individual/Enterprise letters: endorser + Head, Payment & Collection.
    signatory_1_name: limited ? o.people.initiatorName : o.people.endorserName,
    signatory_1_title: limited ? o.people.initiatorTitle : o.people.endorserTitle,
    signatory_2_name: limited ? o.people.endorserName : (o.people.secondSignatoryName ?? ""),
    signatory_2_title: limited ? o.people.endorserTitle : (o.people.secondSignatoryTitle || "Head, Payment & Collection"),
  };
  return { values, loops: { directors_rest: rest.map((d, i) => ({ director_index: String(i + 2), director_name: d.fullName, director_bvn: d.bvn })) } };
}

export interface BuiltOffer {
  format: "DOCX" | "HTML";
  main: { filename: string; mime: string; data: Buffer };
  pdf: { filename: string; data: Buffer } | null;
  /** Values the letter was populated with (for validation and the audit trail; identifiers excluded). */
  values: Record<string, string>;
  /** The approved assessment whose figures the letter carries. */
  assessmentId: string;
}

/** Murabaha fields that must be present before a letter can be issued. */
export const REQUIRED_OFFER_VALUES = ["customer_name", "request_ref", "financed_items", "cost_price", "markup", "cost_plus_markup", "tenor_months", "instalment_amount", "offer_date"] as const;

/**
 * Populate the active Murabaha template for an application from its approved facility record.
 * Pure rendering: no rows are written here. Throws a gate error when mandatory data is missing.
 */
export async function buildOfferFiles(tx: Db, app: Record<string, unknown> & { id: string; ref: string; applicant_type: ApplicantType; current_version_id: string; initiator_id: string; endorser_id: string | null; initiator_role: string }, tpl: Record<string, unknown>, now: Date): Promise<BuiltOffer> {
  const version = (await tx.query("SELECT * FROM application_versions WHERE id = $1", [app.current_version_id])).rows[0];
  if (!version) throw gate("The facility record has no submitted version.");
  const directors = (await tx.query("SELECT * FROM application_directors WHERE version_id = $1 ORDER BY position", [version.id])).rows;
  const assessment = await approvedAssessment(tx, app.id);
  if (!assessment) throw gate("No approved credit assessment exists for this facility.");
  const facilityType = String((assessment.inputs as Record<string, unknown>).facilityType ?? "MURABAHA");
  if (facilityType !== "MURABAHA") throw gate("WakeelBoost issues Murabaha offer letters only. The approved assessment is not a Murabaha (cost plus markup) facility.");
  const data = version.data as DraftData;
  const bvn = version.bvn_enc ? decryptField(version.bvn_enc) : null;
  const tin = version.tin_enc ? decryptField(version.tin_enc) : null;
  const dirs = directors.map((d: { full_name: string; bvn_enc: string }) => ({ fullName: d.full_name, bvn: decryptField(d.bvn_enc) }));
  if (tpl.format === "DOCX") {
    const ppl = (await tx.query("SELECT id, full_name FROM staff WHERE id = ANY($1::uuid[])", [[app.initiator_id, app.endorser_id].filter(Boolean)])).rows;
    const sig = await currentSecondSignatory(tx);
    const nameOf = (id: string | null) => ppl.find((p: { id: string }) => p.id === id)?.full_name ?? "";
    const endorserRole = app.initiator_role === "RM" ? "Regional Business Executive" : app.initiator_role === "MERCHANT_OFFICER" ? "Merchant Officer Lead" : "ANM Lead";
    const initiatorTitle = app.initiator_role === "RM" ? "Relationship Manager" : app.initiator_role === "ANM" ? "Agent Network Manager" : "Merchant Officer";
    const { values, loops } = offerDocxValues({
      app,
      data,
      bvn,
      tin,
      directors: dirs,
      assessment: assessment as unknown as OfferData["assessment"],
      people: { initiatorName: nameOf(app.initiator_id), initiatorTitle, endorserName: nameOf(app.endorser_id), endorserTitle: endorserRole, secondSignatoryName: sig.name, secondSignatoryTitle: sig.title },
      now,
    });
    const missing = REQUIRED_OFFER_VALUES.filter((k) => !String(values[k] ?? "").trim() || values[k] === "N0.00");
    if (missing.length) throw gate(`The facility record is missing data required by the offer letter: ${missing.join(", ")}.`);
    const template = await objectStore().get(String(tpl.storage_key));
    const docx = await renderDocx(template, values, loops);
    const pdfBuf = await docxToPdf(docx);
    const safe = { ...values, bvn: values.bvn ? "(set)" : "", tin: values.tin ? "(set)" : "", first_director_bvn: values.first_director_bvn ? "(set)" : "" };
    return {
      format: "DOCX",
      main: { filename: `Offer-${app.ref}-${String(app.applicant_type).toLowerCase()}-t${tpl.version}.docx`, mime: DOCX_MIME, data: docx },
      pdf: pdfBuf ? { filename: `Offer-${app.ref}-t${tpl.version}.pdf`, data: pdfBuf } : null,
      values: safe,
      assessmentId: assessment.id,
    };
  }
  const html = renderOffer(String(tpl.body_html), {
    applicantType: app.applicant_type,
    data,
    bvn,
    tin,
    directors: dirs,
    markupKobo: Number(assessment.markup_kobo),
    markupRate: String((assessment.inputs as Record<string, unknown>).markupRatePercent ?? ""),
    costPlusMarkupKobo: Number(assessment.cost_plus_markup_kobo),
    assetCostKobo: Number((assessment.inputs as Record<string, unknown>).assetCostKobo ?? assetCostKobo(data.items)),
    ref: app.ref,
    offerDate: formatDateOnly(lagosDate(now)),
  });
  if (!html.trim()) throw invalid("Rendered offer is empty.");
  return { format: "HTML", main: { filename: `Offer-${app.ref}-t${tpl.version}.html`, mime: "text/html", data: Buffer.from(wrapOfferDocument(html, app.ref), "utf8") }, pdf: null, values: { request_ref: app.ref }, assessmentId: assessment.id };
}

/**
 * Initiator / Super Admin: generate (or retry) the facility's Murabaha offer letter now. Normally the
 * letter is issued automatically when the Divisional Head approves; this only re-runs that process.
 */
export async function generateOffer(ctx: Ctx, appId: string) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const { requestOfferLetterNow } = await import("./offer-letters");
  return requestOfferLetterNow(ctx, appId);
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function wrapOfferDocument(body: string, ref: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offer ${escapeHtml(ref)}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:24px auto;padding:0 16px;color:#111;line-height:1.5}
table{border-collapse:collapse}th{background:#f3f3f3}@media print{.noprint{display:none}}</style></head>
<body>${body}</body></html>`;
}

export const DEV_OFFER_TEMPLATE = `<div style="border-bottom:4px solid #FFC20E;padding-bottom:8px;margin-bottom:16px">
  <strong style="font-size:20px">WakeelBoost</strong> &middot; Alternative Bank
  <div style="color:#b00;font-weight:bold">DEVELOPMENT SAMPLE TEMPLATE &ndash; NOT BANK APPROVED &ndash; DO NOT ISSUE</div>
</div>
<p>Date: {{offer_date}}<br>Reference: {{request_ref}}</p>
<p>Dear <strong>{{customer_name}}</strong>,</p>
<h2>Offer of Murabaha Stock Financing (WakeelBoost)</h2>
<p>We are pleased to offer you stock financing on the following terms.</p>
<h3>Financed items</h3>
{{financed_items}}
<table cellpadding="6" style="margin-top:12px">
  <tr><td>Asset cost</td><td><strong>{{asset_cost}}</strong></td></tr>
  <tr><td>Markup ({{markup_rate}}% for the tenor)</td><td><strong>{{markup}}</strong></td></tr>
  <tr><td>Cost plus markup (sale price)</td><td><strong>{{cost_plus_markup}}</strong></td></tr>
  <tr><td>Tenor</td><td>{{tenor_months}} months</td></tr>
</table>
<h3>Customer identifiers</h3>
<p>{{#if_bvn}}BVN: {{bvn}}<br>{{/if_bvn}}{{#if_tin}}TIN: {{tin}}<br>{{/if_tin}}Registration number: {{registration_number}}</p>
{{#directors}}<p class="director">Director: {{director_name}} &mdash; BVN: {{director_bvn}}</p>{{/directors}}
<p style="margin-top:32px">Accepted by: ______________________ &nbsp; Date: __________</p>
<p>For: Alternative Bank &nbsp; ______________________</p>`;

/**
 * Clearly marked sample values for previewing a template version (Super Admin). Synthetic data only;
 * the customer name states that the document is a sample and not an offer.
 */
export function sampleOfferValues(type: ApplicantType): { values: Record<string, string>; loops: Record<string, Record<string, string>[]> } {
  const values: Record<string, string> = {
    offer_date: "1st January 2026",
    request_ref: "WB-SAMPLE-000000",
    customer_name: type === "LIMITED" ? "SAMPLE COMPANY LTD (SAMPLE - NOT AN OFFER)" : type === "ENTERPRISE" ? "SAMPLE PROPRIETOR trading as SAMPLE STORES (SAMPLE - NOT AN OFFER)" : "SAMPLE CUSTOMER (SAMPLE - NOT AN OFFER)",
    proprietor_name: "SAMPLE PROPRIETOR",
    business_name: "SAMPLE STORES",
    company_name: "SAMPLE COMPANY LTD (SAMPLE - NOT AN OFFER)",
    customer_address: "1 Sample Street, Lagos",
    registration_number: "BN000000",
    facility_type: "Murabaha",
    cost_price: "N1,000,000.00",
    cost_price_words: "One Million Naira Only",
    markup: "N100,000.00",
    markup_rate_tenor: "10%",
    markup_rate_annual: "",
    cost_plus_markup: "N1,100,000.00",
    cost_plus_markup_words: "One Million, One Hundred Thousand Naira Only",
    apr: "0.00%",
    tenor_months: "3",
    financed_items: "100 sample items",
    asset_cost: "N1,000,000.00",
    instalment_frequency: "monthly",
    instalment_amount: "N366,666.67",
    takaful_rate: "0%",
    stamp_duty_rate: "0.125%",
    bvn: "00000000000",
    tin: "00000000-0000",
    first_director_name: "SAMPLE DIRECTOR ONE",
    first_director_bvn: "00000000000",
    signatory_1_name: "SAMPLE SIGNATORY",
    signatory_1_title: "Regional Business Executive",
    signatory_2_name: "SAMPLE SIGNATORY",
    signatory_2_title: "Head, Payment & Collection",
  };
  return { values, loops: { directors_rest: type === "LIMITED" ? [{ director_index: "2", director_name: "SAMPLE DIRECTOR TWO", director_bvn: "00000000000" }] : [] } };
}
