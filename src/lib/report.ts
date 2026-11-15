// Report and form pages, as plain HTML strings.
import type { AuditResult, Finding } from "./audit";

// TODO: set to the real booking link
export const BOOK_URL = "#";

const CSS = `
:root{--bg:#f7f6f3;--ink:#1b1b1a;--mut:#63625e;--line:#e1dfd9;--card:#fff;--fail:#b3261e;--warn:#9a5b00;--ok:#1d6b3a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:820px;margin:0 auto;padding:48px 20px 80px}
h1{font-size:2rem;line-height:1.15;margin:0 0 6px}h2{font-size:1.25rem;margin:44px 0 14px}
.mut{color:var(--mut)}.top{font-size:.85rem;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin-bottom:10px}
.hero{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;margin-top:22px}
.big{font-size:3.2rem;line-height:1;font-weight:700}.big small{font-size:1.1rem;font-weight:400;color:var(--mut)}
.chip{display:inline-block;font-size:.78rem;font-weight:600;padding:2px 9px;border-radius:99px;border:1px solid currentColor;white-space:nowrap}
.c-fail{color:var(--fail)}.c-warn{color:var(--warn)}.c-pass{color:var(--ok)}
table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:10px 0;border-top:1px solid var(--line);vertical-align:top}
td:last-child{text-align:right}.area{font-weight:600}.desc{font-size:.88rem;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:18px 20px;margin:12px 0}
.card.fail{border-left-color:var(--fail)}.card.warn{border-left-color:var(--warn)}
.card h3{margin:6px 0 8px;font-size:1.05rem}.card p{margin:4px 0}.lbl{font-size:.78rem;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
ul.ok{list-style:none;padding:0;margin:0}ul.ok li{padding:8px 0;border-top:1px solid var(--line)}ul.ok b{display:inline-block;min-width:11em}
.cta{background:var(--ink);color:#fff;border-radius:14px;padding:28px;margin-top:44px}.cta h2{margin:0 0 8px;color:#fff}
.cta a{display:inline-block;margin-top:12px;background:#fff;color:var(--ink);padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}
form{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}input[type=text]{flex:1;min-width:240px;padding:12px 14px;font-size:1rem;border:1px solid var(--line);border-radius:8px}
button{padding:12px 22px;font-size:1rem;border:0;border-radius:8px;background:var(--ink);color:#fff;font-weight:600;cursor:pointer}
.err{color:var(--fail);margin-top:14px}
@media print{body{background:#fff}.cta a{border:1px solid #fff}}
`;

const AREAS: [string, string][] = [
  ["Listing", "Whether search engines list your pages, and which version they keep."],
  ["Titles and summaries", "What people see in search results."],
  ["Page outline", "The order of headings, and how the page works on a phone."],
  ["Labels", "Code that tells search engines and AI assistants what your business, services and questions are."],
  ["Speed", "How fast the page loads on a phone. This is an estimate from one request."],
  ["Images", "Size and descriptions."],
  ["Access for AI", "Whether AI assistants are allowed to read the site."],
];
const LABEL: Record<string, [string, string]> = { fail: ["Serious", "\u2715"], warn: ["Review", "!"], pass: ["Good", "\u2713"] };

const e = (s: unknown) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(body: string, title = "AI & SEO readiness check") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function formPage(action: string, error = "") {
  const err = error ? `<p class="err">${e(error)}</p>` : "";
  return page('<div class="top">QDS</div><h1>AI &amp; SEO readiness check</h1>' +
    '<p class="mut">See how search engines and AI assistants read your site. Enter your URL to get a first report.</p>' +
    `<form action="${e(action)}" method="get"><input type="text" name="url" placeholder="https://yoursite.com" aria-label="Website URL" required>` +
    `<button>Check my site</button></form>${err}`);
}

export function render(r: AuditResult) {
  const scored = r.findings.filter((f) => f.status !== "info");
  const fails = scored.filter((f) => f.status === "fail");
  const warns = scored.filter((f) => f.status === "warn");
  const byWeight = (a: Finding, b: Finding) => b.weight - a.weight;
  const attn = [...fails.sort(byWeight), ...warns.sort(byWeight)];
  let rows = "";
  for (const [name, desc] of AREAS) {
    const mine = scored.filter((f) => f.area === name);
    if (!mine.length) continue;
    const st = mine.some((f) => f.status === "fail") ? "fail" : mine.some((f) => f.status === "warn") ? "warn" : "pass";
    const bad = mine.filter((f) => f.status !== "pass").length;
    const [txt, ic] = LABEL[st];
    rows += `<tr><td><div class="area">${e(name)}</div><div class="desc">${e(desc)}</div></td>` +
      `<td><span class="chip c-${st}">${ic} ${txt}</span><div class="desc">${bad} of ${mine.length} checks</div></td></tr>`;
  }
  const cards = attn.map((f) => {
    const [txt, ic] = LABEL[f.status];
    return `<div class="card ${f.status}"><span class="chip c-${f.status}">${ic} ${txt}</span> <span class="mut"> ${e(f.area)}</span>` +
      `<h3>${e(f.title)}</h3><p><span class="lbl">What we found</span><br>${e(f.found)}</p>` +
      `<p><span class="lbl">Why it matters</span><br>${e(f.why)}</p></div>`;
  }).join("");
  const good = scored.filter((f) => f.status === "pass").map((f) => `<li><b>${e(f.title)}</b> <span class="mut">${e(f.found)}</span></li>`).join("");
  const info = r.findings.filter((f) => f.status === "info").map((f) => `<li><b>${e(f.title)}</b> <span class="mut">${e(f.found)} ${e(f.why)}</span></li>`).join("");
  const head = attn.length
    ? `<div class="big">${attn.length} <small>of ${scored.length} checks need attention</small></div><p>${fails.length} are serious. ${warns.length} are worth reviewing. Each one below says what we found and why it matters.</p>`
    : `<div class="big">0 <small>of ${scored.length} checks need attention</small></div><p>Nothing needs attention on this page.</p>`;
  const wf = r.webflow ? "" : '<p class="mut">This site does not look like it is built on Webflow. The full check is made for Webflow sites.</p>';
  const notes = ["This report covers one page. Other pages can differ.",
    "Speed is an estimate from one request, not a lab test or real visitor data.",
    "We have not seen Google Search Console: which pages Google lists and what people search for.",
    "We have not reviewed your content or compared you with other sites.",
    "We have not asked AI assistants about your company to see what they answer."];
  const body = `<div class="top">QDS \u00b7 AI &amp; SEO readiness \u00b7 first report</div><h1>${e(r.finalUrl)}</h1>` +
    `<p class="mut">Checked on ${e(r.date)}</p><div class="hero">${head}<table>${rows}</table></div>${wf}` +
    (cards ? `<h2>What needs attention</h2>${cards}` : "") +
    (good ? `<h2>What is working</h2><ul class="ok">${good}</ul>` : "") +
    (info ? `<h2>Worth knowing</h2><ul class="ok">${info}</ul>` : "") +
    `<h2>What this report does not cover</h2><ul>${notes.map((n) => `<li>${e(n)}</li>`).join("")}</ul>` +
    `<div class="cta"><h2>Tell us about your site.</h2><div>We go through the report with you and agree the scope of the full check.</div>` +
    `<a href="${e(BOOK_URL)}">Book a call</a></div>`;
  return page(body, `AI & SEO readiness: ${r.finalUrl}`);
}
