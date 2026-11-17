/**
 * Minimal, dependency-free PDF writer for system-generated records (A4, Helvetica, text, rules,
 * filled bands and one JPEG image). Text is encoded as WinAnsi; characters outside it are replaced.
 */

const A4 = { w: 595.28, h: 841.89 };
// Helvetica / Helvetica-Bold advance widths (per 1000 em) for printable ASCII 32–126 (Adobe AFM).
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

export function textWidth(s: string, size: number, bold = false) {
  const t = bold ? HELVB : HELV;
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (w * size) / 1000;
}

function enc(s: string) {
  const plain = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/₦/g, "NGN ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "*");
  let out = "";
  for (const ch of plain) {
    const c = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += "\\" + c.toString(8).padStart(3, "0");
    else out += "?";
  }
  return out;
}

export function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of String(s).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function jpegSize(buf: Buffer): { w: number; h: number } {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("Not a baseline JPEG");
}

export class PdfDoc {
  private pages: string[] = [];
  private cur: string[] = [];
  private image: { data: Buffer; w: number; h: number } | null = null;
  y = 0;
  readonly margin = 48;
  readonly width = A4.w - 96;
  constructor(private footer: (page: number, total: number) => string) {
    this.addPage();
  }
  addPage() {
    if (this.cur.length) this.pages.push(this.cur.join("\n"));
    this.cur = [];
    this.y = A4.h - this.margin;
  }
  ensure(h: number) {
    if (this.y - h < this.margin + 30) this.addPage();
  }
  text(s: string, x: number, y: number, size = 10, bold = false, rgb: [number, number, number] = [0.11, 0.11, 0.13]) {
    this.cur.push(`BT ${rgb.map((v) => v.toFixed(3)).join(" ")} rg /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${enc(s)}) Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
    this.cur.push(`${rgb.map((v) => v.toFixed(3)).join(" ")} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8) {
    this.cur.push(`${gray} G 0.5 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  logo(jpeg: Buffer, x: number, y: number, height: number) {
    const { w, h } = jpegSize(jpeg);
    this.image = { data: jpeg, w, h };
    const width = (height * w) / h;
    this.cur.push(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im1 Do Q`);
    return width;
  }
  /** Paragraph that flows across pages. */
  para(s: string, size = 10, bold = false, gap = 4, rgb?: [number, number, number]) {
    for (const l of wrap(s, size, this.width, bold)) {
      this.ensure(size + 3);
      this.text(l, this.margin, this.y - size, size, bold, rgb);
      this.y -= size + 3;
    }
    this.y -= gap;
  }
  heading(s: string) {
    this.ensure(30);
    this.y -= 6;
    this.text(s, this.margin, this.y - 12, 12, true);
    this.y -= 17;
    this.line(this.margin, this.y, this.margin + this.width, this.y, 0.75);
    this.y -= 5;
  }
  /** Two-column key/value rows. */
  rows(pairs: [string, string][], keyWidth = 170) {
    for (const [k, v] of pairs) {
      const lines = wrap(v || "-", 10, this.width - keyWidth - 8);
      const h = lines.length * 12.5 + 4.5;
      this.ensure(h);
      this.text(k, this.margin, this.y - 10, 9, true, [0.35, 0.35, 0.38]);
      lines.forEach((l, i) => this.text(l, this.margin + keyWidth, this.y - 10 - i * 12.5, 10));
      this.y -= h;
      this.line(this.margin, this.y + 2, this.margin + this.width, this.y + 2, 0.9);
    }
  }
  /** Simple table with fixed column widths (fractions of the content width). */
  table(head: string[], body: string[][], widths: number[]) {
    const xs: number[] = [];
    let acc = this.margin;
    for (const f of widths) {
      xs.push(acc);
      acc += f * this.width;
    }
    this.ensure(20);
    this.rect(this.margin, this.y - 16, this.width, 16, [0.95, 0.95, 0.93]);
    head.forEach((h, i) => this.text(h, xs[i] + 4, this.y - 11.5, 8.5, true, [0.3, 0.3, 0.33]));
    this.y -= 18;
    for (const r of body) {
      const cells = r.map((c, i) => wrap(c, 9.5, widths[i] * this.width - 8));
      const h = Math.max(...cells.map((c) => c.length)) * 12 + 4;
      this.ensure(h);
      cells.forEach((c, i) => c.forEach((l, j) => this.text(l, xs[i] + 4, this.y - 10 - j * 12, 9.5)));
      this.y -= h;
      this.line(this.margin, this.y + 2, this.margin + this.width, this.y + 2, 0.9);
    }
  }
  toBuffer(meta: { title: string; author: string; created: Date }): Buffer {
    this.pages.push(this.cur.join("\n"));
    const total = this.pages.length;
    const objs: (string | Buffer)[] = [];
    const add = (o: string | Buffer) => objs.push(o) - 1 + 1; // 1-based object number
    const catalog = add("");
    const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    let im = 0;
    if (this.image) {
      const head = `<< /Type /XObject /Subtype /Image /Width ${this.image.w} /Height ${this.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.image.data.length} >>\nstream\n`;
      im = add(Buffer.concat([Buffer.from(head, "latin1"), this.image.data, Buffer.from("\nendstream", "latin1")]));
    }
    const kids: number[] = [];
    this.pages.forEach((content, i) => {
      const foot = `BT 0.45 0.45 0.48 rg /F1 8 Tf ${this.margin} 26 Td (${enc(this.footer(i + 1, total))}) Tj ET`;
      const body = `${content}\n${foot}`;
      const stream = add(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
      const res = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${im ? ` /XObject << /Im1 ${im} 0 R >>` : ""} >>`;
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Contents ${stream} 0 R /Resources ${res} >>`));
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const d = meta.created.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const info = add(`<< /Title (${enc(meta.title)}) /Author (${enc(meta.author)}) /Producer (WakeelBoost Work Desk) /CreationDate (D:${d}Z) >>`);
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets: number[] = [];
    let len = parts[0].length;
    objs.forEach((o, i) => {
      offsets.push(len);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), typeof o === "string" ? Buffer.from(o, "latin1") : o, Buffer.from("\nendobj\n", "latin1")]);
      parts.push(b);
      len += b.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}
