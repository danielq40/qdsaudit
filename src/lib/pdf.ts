// Builds the report PDF in the browser, so nothing has to be stored on the server.
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Level, Report } from "./types";

const W = 595, H = 842, M = 48, IN = W - 2 * M;
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  black: hex("#000000"), ink: hex("#16181C"), grey: hex("#5A606B"), light: hex("#A8AEBA"), line: hex("#D5D8DE"), track: hex("#ECEEF2"),
  white: hex("#FFFFFF"), blue: hex("#3D5AFE"), panel: hex("#F4F5F8"),
};
const LEVEL: Record<Level, { label: string; bar: ReturnType<typeof hex>; text: ReturnType<typeof hex> }> = {
  risk: { label: "NEEDS FIXING", bar: hex("#C8352B"), text: hex("#B02A21") },
  review: { label: "COULD IMPROVE", bar: hex("#D98E04"), text: hex("#8A5A00") },
  almost: { label: "ALMOST PERFECT", bar: hex("#B8E07A"), text: hex("#4C7A12") },
  good: { label: "ALL GOOD", bar: hex("#7DD98A"), text: hex("#1F7A3A") },
};

// Placeholders until the real details are set as environment variables.
const BOOK_PLACEHOLDER = "[booking link]";
const EMAIL_PLACEHOLDER = "[email]";

const STEPS: [string, string][] = [
  ["First report", "This report. You enter your URL and get it straight away."],
  ["Call", "We go through the report with you and agree the scope and price of the full check."],
  ["Full check", "We review every page and every check, and share the complete report in order of importance."],
  ["Fixes", "You approve them. We make them in your Webflow project. Changes do not disrupt how you manage the site."],
  ["Record", "You get a record of what changed."],
];

/** Standard PDF fonts only cover Latin-1, so other characters are replaced or dropped. */
const clean = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[  ]/g, " ").replace(/[^\x20-\x7E¡-ÿ]/g, "");

function wrap(text: string, font: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of clean(text).split(/\s+/).filter(Boolean)) {
    while (font.widthOfTextAtSize(word, size) > max) {
      // break very long words, such as URLs
      let cut = word.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > max) cut--;
      if (line) { out.push(line); line = ""; }
      out.push(word.slice(0, cut));
      word = word.slice(cut);
    }
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
  const mono = await doc.embedFont(StandardFonts.Courier);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H;

  const text = (t: string, x: number, yy: number, size: number, font = reg, color = C.ink) =>
    page.drawText(clean(t), { x, y: yy, size, font, color });
  const para = (t: string, x: number, size: number, max: number, font = reg, color = C.ink, lead = 1.4) => {
    for (const l of wrap(t, font, size, max)) { text(l, x, y - size, size, font, color); y -= size * lead; }
  };
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M + 28) newPage(); };
  const link = (url: string, x: number, yy: number, w: number, h: number) => {
    if (!/^https?:\/\/|^mailto:/i.test(url)) return;
    const ref = doc.context.register(doc.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, yy, x + w, yy + h], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }));
    page.node.addAnnot(ref);
  };
  const button = (label: string, x: number, yy: number, url: string, primary: boolean) => {
    const w = bold.widthOfTextAtSize(label, 10.5) + 36, h = 34;
    if (primary) page.drawRectangle({ x, y: yy, width: w, height: h, color: C.blue });
    else page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: C.blue, borderWidth: 1.2, color: C.white });
    text(label, x + 18, yy + 12, 10.5, bold, primary ? C.white : C.blue);
    link(url, x, yy, w, h);
    return w;
  };
  const bookUrl = r.contact.bookUrl, quoteUrl = r.contact.quoteUrl || r.contact.bookUrl;
  const mailUrl = r.contact.email ? `mailto:${r.contact.email}` : "";

  // ---- Hero: title, contact, headline
  const heroH = 330;
  page.drawRectangle({ x: 0, y: H - heroH, width: W, height: heroH, color: C.black });
  text("QUARANTA DESIGN STUDIO", M, H - 64, 9, bold, C.light);
  text("FIRST REPORT", W - M - bold.widthOfTextAtSize("FIRST REPORT", 9), H - 64, 9, bold, C.light);
  page.drawRectangle({ x: M, y: H - 84, width: IN, height: 0.6, color: hex("#4A505A") });
  text("AI & SEO", M, H - 140, 38, bold, C.white);
  text("readiness check", M, H - 182, 38, bold, C.white);
  text(`${r.host}  |  ${r.date}`, M, H - 210, 11, reg, hex("#C9CED8"));
  text("Want these fixed?", M, H - 252, 14, bold, C.white);
  text("We can run the full check on every page and make the fixes in your Webflow project.", M, H - 270, 10.5, reg, hex("#C9CED8"));
  {
    const by = H - 314;
    const w1 = bold.widthOfTextAtSize("Book a call", 10.5) + 36;
    page.drawRectangle({ x: M, y: by, width: w1, height: 34, color: C.blue });
    text("Book a call", M + 18, by + 12, 10.5, bold, C.white);
    link(bookUrl, M, by, w1, 34);
    const w2 = bold.widthOfTextAtSize("Request a quote", 10.5) + 36;
    page.drawRectangle({ x: M + w1 + 10, y: by, width: w2, height: 34, borderColor: C.white, borderWidth: 1.2, color: C.black });
    text("Request a quote", M + w1 + 28, by + 12, 10.5, bold, C.white);
    link(quoteUrl, M + w1 + 10, by, w2, 34);
  }
  y = H - heroH - 36;
  para(r.headline, M, 24, IN, bold, C.ink, 1.2);
  y -= 6;
  para(r.sub, M, 11.5, IN, reg, C.grey, 1.45);
  y -= 20;
  const colW = (IN - 4 * 10) / 5;
  r.areas.forEach((a, i) => {
    const x = M + i * (colW + 10);
    page.drawRectangle({ x, y: y - 6, width: colW, height: 6, color: LEVEL[a.level].bar });
    text(`${a.n} ${a.short}`.toUpperCase(), x, y - 22, 7.5, bold, C.ink);
    text(LEVEL[a.level].label, x, y - 34, 7.5, bold, LEVEL[a.level].text);
  });
  y -= 64;

  // ---- Cards, worst first, two per row
  const order = { risk: 0, review: 1, almost: 2, good: 3 };
  const sorted = [...r.areas].sort((p, q) => order[p.level] - order[q.level] || p.n.localeCompare(q.n));
  const gap = 14, cw = (IN - gap) / 2, ch = 232;
  const drawCard = (a: (typeof sorted)[number], x: number, top: number) => {
    const lv = LEVEL[a.level];
    page.drawRectangle({ x, y: top - ch, width: cw, height: ch, color: C.panel });
    page.drawRectangle({ x, y: top - 4, width: cw, height: 4, color: lv.bar });
    const ix = x + 16, iw = cw - 32;
    text(`${a.n}  ${a.short}`.toUpperCase(), ix, top - 26, 8, bold, C.grey);
    const pw = bold.widthOfTextAtSize(lv.label, 7.5) + 16;
    page.drawRectangle({ x: x + cw - 16 - pw, y: top - 31, width: pw, height: 16, color: lv.bar });
    text(lv.label, x + cw - 16 - pw + 8, top - 26, 7.5, bold, a.level === "risk" ? C.white : C.black);
    let cy = top - 44;
    for (const l of wrap(a.question, bold, 13.5, iw).slice(0, 2)) { text(l, ix, cy - 13, 13.5, bold, C.ink); cy -= 16; }
    cy -= 6;
    text(`${a.score}%`, ix, cy - 30, 34, bold, C.ink);
    cy -= 42;
    for (const l of wrap(a.summary, reg, 9.5, iw).slice(0, 3)) { text(l, ix, cy - 9.5, 9.5, reg, C.grey); cy -= 12; }
    cy -= 8;
    const good = a.level === "good" || a.level === "almost";
    text(a.level === "good" ? "WHAT IS FINE" : "WHAT WE FOUND", ix, cy - 7, 7, bold, a.level === "good" ? LEVEL.good.text : C.grey);
    cy -= 16;
    const rows = a.level === "good" ? a.oks.map((t) => ({ t })) : a.checks.slice(0, 3).map((c) => ({ t: c.name }));
    for (const row of rows) {
      const ls = wrap(row.t, reg, 9, iw - 12).slice(0, 2);
      page.drawRectangle({ x: ix, y: cy - 8, width: 3.5, height: 3.5, color: lv.bar });
      ls.forEach((l, i) => { text(l, ix + 12, cy - 9 - i * 11, 9, reg, C.ink); });
      cy -= ls.length * 11 + 3;
    }
  };
  for (let i = 0; i < sorted.length; i += 2) {
    need(ch + gap);
    drawCard(sorted[i], M, y);
    if (sorted[i + 1]) drawCard(sorted[i + 1], M + cw + gap, y);
    y -= ch + gap;
  }
  y -= 18;

  // ---- Notes
  need(120);
  text("WHAT THIS REPORT DOES NOT COVER", M, y - 10, 8.5, bold, C.grey);
  y -= 26;
  for (const n of r.notes) para("- " + n, M, 10, IN, reg, C.grey, 1.45);
  y -= 24;

  // ---- Contact, closing
  need(330);
  page.drawRectangle({ x: M, y: y - 0.5, width: IN, height: 0.6, color: C.ink });
  y -= 30;
  para("Talk to us about your report.", M, 22, IN, bold, C.ink, 1.2);
  y -= 6;
  para("We can run the full check on every page and make the fixes in your Webflow project. Changes go live after you approve them.", M, 11, IN, reg, C.grey, 1.45);
  y -= 16;
  text("HOW IT WORKS", M, y - 9, 8.5, bold, C.grey);
  y -= 20;
  STEPS.forEach(([t, d], i) => {
    need(40);
    page.drawRectangle({ x: M, y: y - 14, width: 20, height: 20, color: C.ink });
    text(String(i + 1), M + 7, y - 8, 10, bold, C.white);
    text(t, M + 32, y - 6, 11, bold, C.ink);
    y -= 14;
    para(d, M + 32, 10, IN - 32, reg, C.grey, 1.35);
    y -= 8;
  });
  y -= 4;
  para("Most projects take 7 to 14 days, depending on the size of the site. You get the price after the call, because it depends on the size of your site.", M, 10.5, IN, bold, C.ink, 1.4);
  y -= 10;
  para("What you get: a report of what we found, in order of importance and in plain language; the fixes, made in your Webflow project; a record of what changed. We need access to your Webflow project and to Google Search Console.", M, 10, IN, reg, C.grey, 1.4);
  y -= 18;
  need(80);
  const bw2 = button("Book a call", M, y - 34, bookUrl, true);
  button("Request a quote", M + bw2 + 10, y - 34, quoteUrl, false);
  y -= 34 + 22;
  if (!bookUrl || !r.contact.email) {
    para(`${bookUrl ? "" : `Book a call: ${BOOK_PLACEHOLDER}   `}${r.contact.email ? "" : `Write to us: ${EMAIL_PLACEHOLDER}`}`, M, 10, IN, mono, C.grey, 1.4);
  }
  if (r.contact.email) { para(`Write to us: ${r.contact.email}`, M, 10.5, IN, bold, C.blue, 1.4); link(mailUrl, M, y, 240, 14); }

  // ---- Footers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawRectangle({ x: M, y: 40, width: IN, height: 0.5, color: C.line });
    p.drawText("Quaranta Design Studio  |  Webflow Certified Partner", { x: M, y: 26, size: 8, font: reg, color: C.grey });
    const n = `${i + 1} / ${pages.length}`;
    p.drawText(n, { x: W - M - reg.widthOfTextAtSize(n, 8), y: 26, size: 8, font: reg, color: C.grey });
  });
  void PDFName;
  return doc.save();
}
