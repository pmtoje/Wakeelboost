import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { baseCtx } from "../../../../../_lib/auth";
import { lookupSession, SESSION_COOKIE } from "@/server/auth/session";
import { db } from "@/server/db";
import { holdsRole } from "@/server/domain/access";
import { objectStore } from "@/server/storage";
import { auditOutsideTx } from "@/server/audit";
import { DOCX_MIME, sampleOfferValues } from "@/server/domain/offer";
import { docxToPdf, renderDocx } from "@/server/domain/offer-docx";
import type { ApplicantType } from "@/server/domain/application-data";

/** Super Admin: render a template version with clearly marked sample data (PDF when available). Audited. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await baseCtx();
  const r = await lookupSession((await cookies()).get(SESSION_COOKIE)?.value, ctx, { touch: true });
  if (r.status !== "ok") return new NextResponse("Session expired.", { status: 401 });
  ctx.actor = { staffId: r.session.staffId, email: r.session.email, name: r.session.fullName, sessionId: r.session.sessionId, activeRole: r.session.activeRole };
  if (!(await holdsRole(db, r.session.staffId, "SUPER_ADMIN"))) {
    await auditOutsideTx(ctx, { action: "TEMPLATE_PREVIEW", outcome: "DENIED", details: { templateId: id } });
    return new NextResponse("Forbidden", { status: 403 });
  }
  const t = /^[0-9a-f-]{36}$/.test(id) ? (await db.query("SELECT * FROM offer_templates WHERE id = $1", [id])).rows[0] : null;
  if (!t || t.format !== "DOCX") return new NextResponse("Not found", { status: 404 });
  const { values, loops } = sampleOfferValues((t.applicant_type ?? "INDIVIDUAL") as ApplicantType);
  let docx: Buffer;
  try {
    docx = await renderDocx(await objectStore().get(t.storage_key), values, loops);
  } catch (e) {
    return new NextResponse(`The template could not be rendered: ${e instanceof Error ? e.message : "error"}`, { status: 422 });
  }
  const pdf = await docxToPdf(docx);
  await auditOutsideTx(ctx, { action: "TEMPLATE_PREVIEW", details: { templateId: id, name: t.name, version: t.version, pdf: !!pdf } });
  const base = `SAMPLE-${t.name.replace(/[^\w-]+/g, "-")}-v${t.version}`;
  return new NextResponse(new Uint8Array(pdf ?? docx), {
    headers: {
      "Content-Type": pdf ? "application/pdf" : DOCX_MIME,
      "Content-Disposition": `${pdf ? "inline" : "attachment"}; filename="${base}.${pdf ? "pdf" : "docx"}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
