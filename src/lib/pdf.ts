// Builds the report PDF in the browser, so nothing has to be stored on the server.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Level, Report } from "./types";

const W = 595, H = 842, M = 48;
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  black: hex("#000000"), ink: hex("#16181C"), grey: hex("#5A606B"), line: hex("#D5D8DE"), white: hex("#FFFFFF"), blue: hex("#3D5AFE"),
};
const LEVEL: Record<Level, { label: string; bar: ReturnType<typeof hex>; text: ReturnType<typeof hex> }> = {
  risk: { label: "AT RISK", bar: hex("#C8352B"), text: hex("#B02A21") },
  review: { label: "REVIEW", bar: hex("#D98E04"), text: hex("#8A5A00") },
  good: { label: "GOOD", bar: hex("#7DD98A"), text: hex("#1F7A3A") },
};

/** Standard PDF fonts only cover Latin-1, so other characters are replaced or dropped. */
const clean = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[  ]/g, " ").replace(/[^\x20-\x7E¡-ÿ]/g, "");

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    const t = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(t, size) > max && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}

export async function makePdf(r: Report): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(clean(`AI & SEO readiness check: ${r.host}`));
  doc.setAuthor("Quaranta Design Studio");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H;

  const text = (t: string, x: number, yy: number, size: number, font = reg, color = C.ink) =>
    page.drawText(clean(t), { x, y: yy, size, font, color });
  const para = (t: string, x: number, size: number, max: number, font = reg, color = C.ink, lead = 1.4) => {
    for (const l of wrap(t, font, size, max)) { text(l, x, y - size, size, font, color); y -= size * lead; }
  };
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M + 24) newPage(); };

  // ---- Cover band
  page.drawRectangle({ x: 0, y: H - 250, width: W, height: 250, color: C.black });
  text("QUARANTA DESIGN STUDIO", M, H - 64, 9, bold, hex("#A8AEBA"));
  text("FIRST REPORT", W - M - bold.widthOfTextAtSize("FIRST REPORT", 9), H - 64, 9, bold, hex("#A8AEBA"));
  page.drawRectangle({ x: M, y: H - 84, width: W - 2 * M, height: 0.6, color: hex("#4A505A") });
  text("AI & SEO", M, H - 150, 40, bold, C.white);
  text("readiness check", M, H - 194, 40, bold, C.white);
  text(`${r.host}  |  ${r.date}`, M, H - 228, 11, reg, hex("#C9CED8"));
  y = H - 250 - 40;

  // ---- Headline and strip
  para(r.headline, M, 24, W - 2 * M, bold, C.ink, 1.2);
  y -= 6;
  para(r.sub, M, 11.5, W - 2 * M, reg, C.grey, 1.45);
  y -= 22;
  const colW = (W - 2 * M - 5 * 10) / 6;
  r.areas.forEach((a, i) => {
    const x = M + i * (colW + 10);
    page.drawRectangle({ x, y: y - 6, width: colW, height: 6, color: LEVEL[a.level].bar });
    text(`${a.n} ${a.name}`.toUpperCase(), x, y - 22, 6.8, bold, C.ink);
    text(LEVEL[a.level].label, x, y - 34, 7.5, bold, LEVEL[a.level].text);
  });
  y -= 56;

  // ---- Areas, worst first
  const order = { risk: 0, review: 1, good: 2 };
  for (const a of [...r.areas].sort((p, q) => order[p.level] - order[q.level] || p.n.localeCompare(q.n))) {
    const lv = LEVEL[a.level];
    const innerW = W - 2 * M - 20;
    const itemLines = a.items.reduce((n, t) => n + wrap(t, reg, 10, innerW - 12).length, 0);
    need(190 + itemLines * 14);
    const top = y;
    text(`${a.n}  ${a.name}`.toUpperCase(), M + 14, y - 10, 8.5, bold, C.grey);
    text(lv.label, W - M - bold.widthOfTextAtSize(lv.label, 9), y - 10, 9, bold, lv.text);
    y -= 30;
    para(a.question, M + 14, 15, innerW, bold, C.ink, 1.25);
    y -= 8;
    text(a.stat, M + 14, y - 26, 26, bold, C.ink);
    y -= 32;
    para(a.caption, M + 14, 10.5, innerW, reg, C.grey, 1.4);
    y -= 6;
    para(a.line, M + 14, 11.5, innerW, bold, C.ink, 1.4);
    y -= 8;
    for (const it of a.items) {
      const ls = wrap(it, reg, 10, innerW - 12);
      need(ls.length * 14 + 6);
      page.drawRectangle({ x: M + 14, y: y - 10.5, width: 3.5, height: 3.5, color: lv.bar });
      ls.forEach((l) => { text(l, M + 26, y - 10, 10, reg, C.ink); y -= 14; });
    }
    y -= 10;
    page.drawRectangle({ x: M, y, width: 4, height: top - y, color: lv.bar });
    page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 0.5, color: C.line });
    y -= 36;
  }

  // ---- What the report does not cover
  need(150);
  text("WHAT THIS REPORT DOES NOT COVER", M, y - 10, 8.5, bold, C.grey);
  y -= 26;
  const notes = [
    r.capped ? `This report covers ${r.checked} of ${r.total.toLocaleString("en-US")} pages, spread across the sections of the site.` : `This report covers ${r.checked} pages, read the way a search engine reads them.`,
    "Speed is an estimate from one request, not a measure of real visitors.",
    "We have not seen your Google Search Console data, your content or your competitors.",
    "We have not asked AI assistants about your company.",
  ];
  for (const n of notes) para("- " + n, M, 10, W - 2 * M, reg, C.grey, 1.45);

  // ---- Footers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawRectangle({ x: M, y: 40, width: W - 2 * M, height: 0.5, color: C.line });
    p.drawText("Quaranta Design Studio  |  Webflow Certified Partner", { x: M, y: 26, size: 8, font: reg, color: C.grey });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - reg.widthOfTextAtSize(n, 8), y: 26, size: 8, font: reg, color: C.grey });
  });
  return doc.save();
}
