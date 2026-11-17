import { beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { db } from "@/server/db";
import { NAIRA } from "@/server/money";
import { sha256Hex } from "@/server/crypto";
import { readDocumentForActor } from "@/server/domain/documents";
import { archiveFilename, archiveFor, processArchive, processDueArchives, retryArchive } from "@/server/domain/archive";
import { appRow, createSubmittedCase, ctxFor, driveToClosed, driveToOffer } from "@/server/demo/scenario";
import { audits, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

async function closedCase(customer?: string) {
  const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_500_000) });
  if (customer) await db.query("UPDATE applications SET customer_name = $2 WHERE id = $1", [id, customer]);
  await driveToOffer(id);
  await driveToClosed(id);
  return id;
}
async function zipOf(id: string, email = "rm.ade@altbank.ng") {
  const a = (await archiveFor(db, id))!;
  const { doc, data } = await readDocumentForActor(await ctxFor(email), a.document_id!, "download");
  return { a, doc, data, zip: await JSZip.loadAsync(data) };
}

describe("facility repository and archive lifecycle", () => {
  it("opens the repository with the facility reference and generates the ZIP automatically on completion", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_500_000) });
    expect((await archiveFor(db, id))!.status).toBe("IN_PROGRESS");
    expect((await audits("FACILITY_REPOSITORY_OPENED")).some((a) => a.application_id === id)).toBe(true);
    await driveToOffer(id);
    await driveToClosed(id);
    expect((await archiveFor(db, id))!.status).toBe("QUEUED");
    expect(await processDueArchives()).toBe(1);
    const a = (await archiveFor(db, id))!;
    expect(a).toMatchObject({ status: "COMPLETE", generation_no: 1 });
    expect((await audits("FACILITY_ARCHIVE_GENERATED"))[0].details.filename).toBe(a.filename);
  });

  it("names the archive after the customer and facility reference and files each document by section", async () => {
    const id = await closedCase();
    await processDueArchives();
    const app = await appRow(id);
    const { a, data, zip } = await zipOf(id);
    expect(a.filename).toBe(`HALIMA_YUSUF_${app.ref}.zip`);
    expect(sha256Hex(data)).toBe(a.sha256);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const root = `HALIMA_YUSUF_${app.ref}/`;
    expect(names.every((n) => n.startsWith(root))).toBe(true);
    expect(names.some((n) => n.includes("/02-KYC/"))).toBe(true);
    expect(names.some((n) => n.includes("/04-Supplier-invoice/"))).toBe(true);
    expect(names.some((n) => n.includes("/05-Credit-assessment/"))).toBe(true);
    expect(names.some((n) => n.includes("/06-Murabaha-offer-letter/"))).toBe(true);
    expect(names.some((n) => n.includes("/07-Signed-offer-letter/"))).toBe(true);
    expect(names).toContain(`${root}00-Facility-record/Facility-record-${app.ref}.xlsx`);
    // Only real records: the workbook is built from the system's data for this facility.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await zip.file(`${root}00-Facility-record/Facility-record-${app.ref}.xlsx`)!.async("nodebuffer")) as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Credit check", "Product Manager review", "Approvals", "Credit assessment", "Offer letter", "Disbursement", "Repayment schedule", "Completion", "Audit trail", "Document manifest"]);
    const summary = wb.getWorksheet("Summary")!.getSheetValues().flat().map(String).join(" ");
    expect(summary).toContain(app.ref);
    expect(summary).not.toMatch(/22212345678/); // BVN only ever masked
    expect(wb.getWorksheet("Approvals")!.rowCount).toBeGreaterThan(4);
    expect(wb.getWorksheet("Repayment schedule")!.rowCount).toBeGreaterThan(1);
    // Every stored document's checksum matches the manifest
    const manifest = (await zip.file(`${root}00-Facility-record/manifest.csv`)!.async("string")).split("\r\n").slice(1);
    for (const line of manifest) {
      const [p, , , sha] = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
      if (p === "(not included)") continue;
      expect(sha256Hex(await zip.file(root + p)!.async("nodebuffer"))).toBe(sha);
    }
  });

  it("keeps facilities of customers with the same name in separate archives", async () => {
    const a = await closedCase("Ada Obi");
    const b = await closedCase("Ada Obi");
    await processDueArchives();
    const za = await zipOf(a);
    const zb = await zipOf(b);
    expect(za.a.filename).not.toBe(zb.a.filename);
    // Each archive holds only its own facility's files: B's never mentions A's reference.
    const refA = (await appRow(a)).ref;
    const refB = (await appRow(b)).ref;
    const namesB = Object.keys(zb.zip.files).join("\n");
    expect(namesB).toContain(refB);
    expect(namesB).not.toContain(refA);
    const countB = (await db.query("SELECT count(*)::int n FROM documents WHERE application_id = $1 AND category <> 'FACILITY_ARCHIVE'", [b])).rows[0].n;
    expect(zb.a.file_count).toBe(countB + 2);
  });

  it("sanitises file names", () => {
    expect(archiveFilename("Ọlá & Sons / Ltd.", "WB-2026-000001")).toBe("OLA_SONS_LTD_WB-2026-000001.zip");
    expect(archiveFilename("", "WB-2026-000002")).toBe("CUSTOMER_WB-2026-000002.zip");
  });

  it("restricts downloads to people with access to the facility, and audits them", async () => {
    const id = await closedCase();
    await processDueArchives();
    const a = (await archiveFor(db, id))!;
    await expect(readDocumentForActor(await ctxFor("anm.south@altbank.ng"), a.document_id!, "download")).rejects.toThrow(/do not have access/);
    await readDocumentForActor(await ctxFor("rm.ade@altbank.ng"), a.document_id!, "download");
    const dl = await audits("FACILITY_ARCHIVE_DOWNLOADED");
    expect(dl.map((x) => x.outcome)).toEqual(["SUCCESS"]);
    expect((await audits("DOCUMENT_DOWNLOAD")).filter((x) => x.outcome === "DENIED").length).toBe(1);
  });

  it("retries a failed generation safely and keeps earlier archives when regenerated", async () => {
    const id = await closedCase();
    await db.query("UPDATE facility_archives SET status = 'FAILED', attempts = 1, last_error = 'Storage timeout', next_attempt_at = now() WHERE application_id = $1", [id]);
    expect(await processArchive(id)).toBe("COMPLETE");
    expect(await processArchive(id)).toBe("COMPLETE"); // idempotent: no second archive
    expect((await db.query("SELECT count(*)::int n FROM documents WHERE application_id = $1 AND category = 'FACILITY_ARCHIVE'", [id])).rows[0].n).toBe(1);
    await retryArchive(await ctxFor("rm.ade@altbank.ng"), id);
    const versions = (await db.query("SELECT version_no, superseded_at FROM documents WHERE application_id = $1 AND category = 'FACILITY_ARCHIVE' ORDER BY version_no", [id])).rows;
    expect(versions.length).toBe(2);
    expect(versions[0].superseded_at).not.toBeNull();
    expect((await archiveFor(db, id))!.generation_no).toBe(2);
    await expect(retryArchive(await ctxFor("co1@altbank.ng"), id)).rejects.toThrow(/Only the initiator or the Super Admin/);
  });

  it("is not generated for a facility that is not complete", async () => {
    const id = await createSubmittedCase({ initiator: "RM", amountKobo: NAIRA(1_000_000) });
    await expect(retryArchive(await ctxFor("rm.ade@altbank.ng"), id)).rejects.toThrow(/generated when the facility is complete/);
    expect(await processDueArchives()).toBe(0);
  });
});
