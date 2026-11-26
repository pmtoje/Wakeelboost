"use server";
import { redirect } from "next/navigation";
import { requireUser } from "../../_lib/auth";
import { toActionError, type ActionState } from "../../_lib/action";
import { createDraft, saveDraft, submitApplication, performTaskAction, sendReminder, type BookingInput } from "@/server/domain/workflow";
import { uploadDocument } from "@/server/domain/documents";
import { parseCalculatorForm, recordAssessment } from "@/server/domain/assessment";
import { generateOffer } from "@/server/domain/offer";
import { revealIdentifiers } from "@/server/domain/views";
import { creditCheckRequired, proceedWithReason, runCreditCheck } from "@/server/domain/credit-check";
import { retryArchive } from "@/server/domain/archive";
import { DOC_SLUGS, prefillFormsNow, signOnTablet, type SignerInput } from "@/server/domain/disbursement-docs";
import { invalid } from "@/server/errors";
import { parseNairaToKobo } from "@/server/money";
import type { TaskAction } from "@/server/domain/stages";
import type { ApplicantType } from "@/server/domain/application-data";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function createDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  let id: string;
  try {
    id = (await createDraft(ctx, { initiatorRole: str(fd, "initiatorRole"), applicantType: str(fd, "applicantType") as ApplicantType })).id;
  } catch (e) {
    return toActionError(e);
  }
  redirect(creditCheckRequired() ? `/requests/${id}/credit-check` : `/requests/${id}/edit`);
}

interface DraftPayload {
  data: Record<string, unknown>;
  items: { description: string; quantity: string; unitCost: string }[];
  directors: { id?: string | null; fullName: string; bvn: string; nin?: string }[];
  bvn: string;
  tin: string;
  nin?: string;
  amount: string;
  tenor: string;
}

function parsePayload(raw: string) {
  const p = JSON.parse(raw) as DraftPayload;
  const fields: Record<string, string> = {};
  const amount = p.amount ? parseNairaToKobo(p.amount) : null;
  if (p.amount && amount === null) fields.requestedAmountKobo = "Enter the amount in naira (up to 2 decimal places).";
  const items = p.items
    .filter((i) => i.description || i.quantity || i.unitCost)
    .map((i, idx) => {
      const unit = parseNairaToKobo(i.unitCost || "0");
      const qty = Number.parseInt(i.quantity || "0", 10);
      if (unit === null) fields[`items.${idx}.unitCost`] = `Item ${idx + 1}: enter the unit cost in naira.`;
      if (!Number.isInteger(qty) || qty < 0) fields[`items.${idx}.quantity`] = `Item ${idx + 1}: enter a whole quantity.`;
      return { description: i.description.trim(), quantity: Math.max(0, qty || 0), unitCostKobo: unit ?? 0 };
    });
  if (Object.keys(fields).length) throw invalid("Some fields are not valid.", fields);
  const tenor = p.tenor ? Number.parseInt(p.tenor, 10) : null;
  return {
    data: { ...p.data, requestedAmountKobo: amount, tenorMonths: Number.isFinite(tenor) ? tenor : null, items, rbeId: (p.data.rbeId as string) || null },
    bvn: p.bvn || null,
    tin: p.tin || null,
    nin: p.nin || null,
    directors: p.directors,
  };
}

export async function saveDraftAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = str(fd, "applicationId");
  const intent = str(fd, "intent");
  try {
    const parsed = parsePayload(str(fd, "payload"));
    await saveDraft(ctx, appId, { data: parsed.data, bvn: parsed.bvn, tin: parsed.tin, nin: parsed.nin, directors: parsed.directors });
    if (intent === "submit") {
      const taskId = str(fd, "taskId");
      if (taskId) await performTaskAction(ctx, { taskId, action: "RESUBMIT", idempotencyKey: str(fd, "idempotencyKey") });
      else await submitApplication(ctx, appId, str(fd, "idempotencyKey"));
    }
  } catch (e) {
    return toActionError(e);
  }
  if (intent === "submit") redirect(`/requests/${appId}?submitted=1`);
  return { ok: true, message: "Draft saved.", nonce: Date.now() };
}

export async function uploadDocumentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file to upload." };
  try {
    const r = await uploadDocument(ctx, {
      applicationId: str(fd, "applicationId"),
      category: str(fd, "category"),
      filename: file.name,
      data: Buffer.from(await file.arrayBuffer()),
      replacesDocumentId: str(fd, "replacesDocumentId") || null,
    });
    if (r.scanStatus === "REJECTED") return { ok: false, error: "The file failed the malware scan and was quarantined. It will not be used." };
    return { ok: true, message: r.scanStatus === "CLEAN" ? `Uploaded (version ${r.version}).` : "Uploaded. The file is in quarantine until the scan completes.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function taskActionAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const action = str(fd, "action") as TaskAction;
  let booking: BookingInput | undefined;
  try {
    if (action === "DISBURSED") {
      const sched = JSON.parse(str(fd, "schedule") || "[]") as { dueDate: string; amount: string }[];
      booking = {
        amountKobo: parseNairaToKobo(str(fd, "amount")) ?? -1,
        disbursedOn: str(fd, "disbursedOn"),
        transactionRef: str(fd, "transactionRef"),
        schedule: sched.map((s) => ({ dueDate: s.dueDate, amountKobo: parseNairaToKobo(s.amount) ?? -1 })),
      };
    }
    const lv = str(fd, "lockVersion");
    const r = await performTaskAction(ctx, {
      taskId: str(fd, "taskId"),
      action,
      reason: str(fd, "reason") || null,
      idempotencyKey: str(fd, "idempotencyKey"),
      expectedLockVersion: lv ? Number(lv) : null,
      invoiceLogged: fd.get("invoiceLogged") === "on" || fd.get("invoiceLogged") === "true",
      invoiceDialogConfirmed: fd.get("invoiceDialogConfirmed") === "true",
      crmsLogged: fd.get("crmsLogged") === "on" || fd.get("crmsLogged") === "true",
      packForwarded: fd.get("packForwarded") === "on" || fd.get("packForwarded") === "true",
      dsrExceptionJustification: str(fd, "dsrExceptionJustification") || null,
      booking,
    });
    return { ok: true, message: r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assessmentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const raw: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") raw[k] = v;
    const inputs = parseCalculatorForm(raw);
    const started = str(fd, "startedAt");
    const r = await recordAssessment(ctx, str(fd, "applicationId"), inputs, started ? new Date(started) : undefined);
    return { ok: true, message: `Assessment saved: APR ${r.aprPercent}%, DSR ${r.dsrPercent}%.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function generateOfferAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await generateOffer(ctx, str(fd, "applicationId"));
    return { ok: true, message: `Murabaha offer letter issued from template version ${r.templateVersion}.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function reminderAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await sendReminder(ctx, str(fd, "applicationId"), str(fd, "idempotencyKey"));
    return { ok: true, message: r.replayed ? "Reminder already sent." : r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revealAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const data = await revealIdentifiers(ctx, str(fd, "applicationId"));
    return { ok: true, data, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

/** Initiator: customer identification + consent, then the SeedFi credit check. */
export async function creditCheckAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = str(fd, "applicationId");
  try {
    const r = await runCreditCheck(
      ctx,
      appId,
      {
        firstName: str(fd, "firstName"),
        lastName: str(fd, "lastName"),
        bvn: str(fd, "bvn"),
        dateOfBirth: str(fd, "dateOfBirth"),
        gender: str(fd, "gender"),
        phone: str(fd, "phone"),
        consent: fd.get("consent") === "on",
        consentMethod: str(fd, "consentMethod"),
      },
      str(fd, "idempotencyKey"),
    );
    return r.status === "UNAVAILABLE" ? { ok: false, error: r.message, nonce: Date.now() } : { ok: true, message: r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function archiveAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    await retryArchive(ctx, str(fd, "applicationId"));
    return { ok: true, message: "Facility archive generated.", nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

export async function proceedWithReasonAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = str(fd, "applicationId");
  try {
    const r = await proceedWithReason(ctx, appId, str(fd, "reason"));
    return { ok: true, message: r.message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

/** Initiator at offer preparation: prepare (or refresh) the bank's prefilled disbursement forms. */
export async function prefillFormsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  try {
    const r = await prefillFormsNow(ctx, str(fd, "applicationId"));
    const n = r.prepared.length;
    const message = n ? `${n} form${n === 1 ? "" : "s"} prepared from the facility record.` : r.skipped.length ? "The prepared forms are already up to date." : "No bank form templates are active yet. Upload the bank's signed forms instead.";
    return { ok: true, message, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}

/** Initiator: the customer (and witness / signatories) sign a prepared document on the tablet. */
export async function signOnTabletAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireUser();
  const appId = str(fd, "applicationId");
  const docType = DOC_SLUGS[str(fd, "doc")];
  try {
    if (!docType) throw invalid("Unknown document.");
    const roles: SignerInput["role"][] = ["CUSTOMER", "WITNESS", "SIGNATORY_1", "SIGNATORY_2"];
    const signers: SignerInput[] = [];
    for (const role of roles) {
      const png = str(fd, `${role}.signature`);
      const name = str(fd, `${role}.name`);
      if (!png && !name) continue;
      if (!png) throw invalid("Check the signatures.", { [role]: "Sign in the box." });
      signers.push({ role, name, signaturePng: png, designation: str(fd, `${role}.designation`) || undefined, address: str(fd, `${role}.address`) || undefined, occupation: str(fd, `${role}.occupation`) || undefined });
    }
    if (fd.get("confirm") !== "on") throw invalid("Check the signatures.", { confirm: "Confirm the signer has read the document." });
    const r = await signOnTablet(ctx, appId, docType, signers);
    return { ok: true, message: `${r.label} signed. The signed copy is filed with the request.`, nonce: Date.now() };
  } catch (e) {
    return toActionError(e);
  }
}
