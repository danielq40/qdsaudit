// QDS AI & SEO readiness check. Runs on Cloudflare Workers (Webflow Cloud).
import { Parser } from "htmlparser2";

export type Status = "pass" | "warn" | "fail" | "info";
export interface Finding {
  area: string;
  status: Status;
  weight: number;
  title: string;
  found: string;
  why: string;
}
export interface AuditResult {
  url: string;
  finalUrl: string;
  date: string;
  webflow: boolean;
  findings: Finding[];
}

export class FetchError extends Error {}

const UA = "Mozilla/5.0 (compatible; QDSAudit/0.1)";
const AI_BOTS: Record<string, string> = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};
const ROBOTS_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"];

// ---------------------------------------------------------------- fetching

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.startsWith("[")) return true; // IPv6 literals are not checked
  if (!host.includes(".")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

export function checkPublic(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("Enter a full web address, such as https://example.com.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError("Enter a full web address, such as https://example.com.");
  }
  if (allowPrivate) return u;
  if (isPrivateHost(u.hostname) || (u.port && u.port !== "80" && u.port !== "443")) {
    throw new FetchError("This address is not on the public internet.");
  }
  return u;
}

interface Resp {
  status: number;
  headers: Headers;
  text: string;
  finalUrl: string;
  ttfb: number;
  redirects: number;
  size: number;
}

async function readLimited(res: Response, max: number): Promise<{ text: string; size: number }> {
  if (!res.body) return { text: "", size: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), size };
}

export class Fetcher {
  constructor(private allowPrivate: boolean) {}

  async get(url: string, o: { ua?: string; method?: string; timeout?: number; body?: boolean } = {}): Promise<Resp> {
    let cur = checkPublic(url, this.allowPrivate).toString();
    let redirects = 0;
    const start = Date.now();
    for (;;) {
      let res: Response;
      try {
        res = await fetch(cur, {
          method: o.method ?? "GET",
          redirect: "manual",
          headers: { "User-Agent": o.ua ?? UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en" },
          signal: AbortSignal.timeout(o.timeout ?? 15000),
        });
      } catch (e: any) {
        if (e instanceof FetchError) throw e;
        throw new FetchError(e?.name === "TimeoutError" ? "The site took too long to answer." : "We could not load this address.");
      }
      const loc = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        if (++redirects > 8) throw new FetchError("The address redirects too many times.");
        res.body?.cancel().catch(() => {});
        cur = checkPublic(new URL(loc, cur).toString(), this.allowPrivate).toString();
        continue;
      }
      const ttfb = (Date.now() - start) / 1000;
      const { text, size } = o.body === false || o.method === "HEAD" ? { text: "", size: 0 } : await readLimited(res, 3_000_000);
      if (o.body === false || o.method === "HEAD") res.body?.cancel().catch(() => {});
      return { status: res.status, headers: res.headers, text, finalUrl: cur, ttfb, redirects, size };
    }
  }

  async tryGet(url: string, o: Parameters<Fetcher["get"]>[1] = {}): Promise<Resp | null> {
    try {
      return await this.get(url, o);
    } catch {
      return null;
    }
  }
}

// ----------------------------------------------------------------- parsing

interface Img { [k: string]: string }
interface Parsed {
  title: string | null;
  meta: Record<string, string>[];
  headings: [number, string][];
  images: Img[];
  scripts: { attrs: Record<string, string>; inHead: boolean }[];
  jsonld: string[];
  lang: string | null;
  words: number;
  stylesheets: number;
  canonical: string | null;
}

function parseHtml(htmlText: string): Parsed {
  const p: Parsed = { title: null, meta: [], headings: [], images: [], scripts: [], jsonld: [], lang: null, words: 0, stylesheets: 0, canonical: null };
  let inHead = false, inTitle = false, skip = 0;
  let titleBuf = "", ld: string[] | null = null, h: { lvl: number; buf: string } | null = null;
  const parser = new Parser({
    onopentag(name, a) {
      if (name === "html") p.lang = a.lang ?? null;
      else if (name === "head") inHead = true;
      else if (name === "body") inHead = false;
      else if (name === "title" && p.title === null) inTitle = true;
      else if (name === "meta") p.meta.push(a);
      else if (name === "link") {
        const rel = (a.rel ?? "").toLowerCase();
        if (rel.includes("stylesheet")) p.stylesheets++;
        if (rel.split(/\s+/).includes("canonical") && p.canonical === null) p.canonical = a.href ?? "";
      } else if (name === "script") {
        skip++;
        if ((a.type ?? "").toLowerCase() === "application/ld+json") ld = [];
        else if (a.src) p.scripts.push({ attrs: a, inHead });
      } else if (name === "style" || name === "noscript" || name === "template") skip++;
      else if (/^h[1-6]$/.test(name)) h = { lvl: Number(name[1]), buf: "" };
      else if (name === "img") p.images.push(a);
    },
    onclosetag(name) {
      if (name === "head") inHead = false;
      else if (name === "title" && inTitle) {
        inTitle = false;
        p.title = titleBuf.split(/\s+/).filter(Boolean).join(" ");
      } else if (name === "script") {
        skip = Math.max(0, skip - 1);
        if (ld) { p.jsonld.push(ld.join("")); ld = null; }
      } else if (name === "style" || name === "noscript" || name === "template") skip = Math.max(0, skip - 1);
      else if (h && name === `h${h.lvl}`) {
        p.headings.push([h.lvl, h.buf.split(/\s+/).filter(Boolean).join(" ")]);
        h = null;
      }
    },
    ontext(t) {
      if (inTitle) titleBuf += t;
      if (ld) ld.push(t);
      if (skip === 0 && !inHead) {
        p.words += t.split(/\s+/).filter(Boolean).length;
        if (h) h.buf += t;
      }
    },
  }, { decodeEntities: true });
  parser.write(htmlText);
  parser.end();
  return p;
}

const metaValue = (p: Parsed, key: string, attr = "name") =>
  p.meta.find((m) => (m[attr] ?? "").toLowerCase() === key)?.content?.trim() ?? null;

function jsonldTypes(blocks: string[]): { types: string[]; bad: number } {
  const types = new Set<string>();
  let bad = 0;
  const walk = (x: any) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const t = x["@type"];
      if (typeof t === "string") types.add(t);
      else if (Array.isArray(t)) t.forEach((i) => types.add(String(i)));
      Object.values(x).forEach((v) => typeof v === "object" && walk(v));
    }
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b)); } catch { bad++; }
  }
  return { types: [...types].sort(), bad };
}

// ------------------------------------------------------------- robots.txt

interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }

function parseRobots(text: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (!line || i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "user-agent") {
      if (!cur || !lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastAgent = true;
    } else if (k === "allow" || k === "disallow") {
      cur?.rules.push({ allow: k === "allow", path: v });
      lastAgent = false;
    } else if (k === "sitemap") sitemaps.push(v);
  }
  return { groups, sitemaps };
}

function canFetch(groups: Group[], ua: string, path: string): boolean {
  const u = ua.toLowerCase();
  let best: Group | null = null, bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a !== "*" && u.includes(a) && a.length > bestLen) { best = g; bestLen = a.length; }
    }
  }
  if (!best) best = groups.find((g) => g.agents.includes("*")) ?? null;
  if (!best) return true;
  let verdict = true, len = -1;
  for (const r of best.rules) {
    if (!r.path) continue;
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (r.path.length > len || (r.path.length === len && r.allow))) {
      verdict = r.allow;
      len = r.path.length;
    }
  }
  return verdict;
}

// ---------------------------------------------------------------- findings

const norm = (u: string) => {
  const p = new URL(u);
  return `${p.host.toLowerCase()}|${p.pathname.replace(/\/$/, "") || "/"}|${p.search}`;
};
const looksHtml = (s: string) => s.trimStart().startsWith("<");

export async function runAudit(input: string, allowPrivate = false): Promise<AuditResult> {
  let url = input.trim();
  if (!url.includes("://")) url = "https://" + url;
  const net = new Fetcher(allowPrivate);
  const main = await net.get(url);
  const final = main.finalUrl;
  const fu = new URL(final);
  const origin = fu.origin;
  const pg = parseHtml(main.text);
  const out: Finding[] = [];
  const add = (area: string, status: Status, weight: number, title: string, found: string, why = "") =>
    out.push({ area, status, weight, title, found, why });

  // ---- Listing
  let A = "Listing";
  if (main.status === 200) add(A, "pass", 3, "Page loads", "The page loads (status 200).");
  else add(A, "fail", 3, "Page loads", `The page returned status ${main.status}.`,
    "Search engines drop pages that return errors, and visitors see an error instead of your page.");
  if (final.startsWith("https://")) add(A, "pass", 2, "Secure connection", "The page is served over a secure connection.");
  else add(A, "fail", 2, "Secure connection", "The page is served over http, not https.",
    "Browsers mark the site as Not secure next to the address. Visitors see that before they see your page.");
  const robotsMeta = ((metaValue(pg, "robots") ?? "") + " " + (metaValue(pg, "googlebot") ?? "")).toLowerCase();
  if (robotsMeta.includes("noindex") || (main.headers.get("x-robots-tag") ?? "").toLowerCase().includes("noindex"))
    add(A, "fail", 3, "Page can be listed", "This page tells search engines not to list it.",
      "Pages marked this way do not appear in search results. It is a common leftover from the staging site.");
  else add(A, "pass", 3, "Page can be listed", "Nothing tells search engines to skip the page.");
  let canon: string | null = null;
  if (pg.canonical) { try { canon = new URL(pg.canonical, final).toString(); } catch { /* ignore */ } }
  if (!canon) add(A, "warn", 2, "Main address", "The page does not say which address is the main one.",
    "A page can be reached at several addresses, such as with and without www. Search engines choose one themselves and may treat them as separate pages.");
  else if (norm(canon) !== norm(final)) add(A, "warn", 2, "Main address", `The page names a different address as the main one: ${canon}`,
    "If that is not intended, this page can be left out of search results in favor of the other address.");
  else add(A, "pass", 2, "Main address", "The page names its own address as the main one.");

  const robots = await net.tryGet(origin + "/robots.txt", { timeout: 8000 });
  const robotsOk = !!robots && robots.status === 200 && !looksHtml(robots.text);
  const rb = parseRobots(robotsOk ? robots!.text : "");
  if (!robotsOk) add(A, "warn", 1, "robots.txt", "No robots.txt file found.",
    "This is the file crawlers read first. It tells them what to skip and where your sitemap is.");
  else if (!canFetch(rb.groups, "*", "/")) add(A, "fail", 3, "robots.txt", "The robots.txt file tells all crawlers to stay out of the site.",
    "Search engines that obey it will not list your pages. This often stays behind after a staging phase.");
  else add(A, "pass", 1, "robots.txt", "robots.txt is in place and does not block the site.");
  const sm = await net.tryGet(rb.sitemaps[0] ?? origin + "/sitemap.xml", { timeout: 10000 });
  if (sm && sm.status === 200 && (sm.text.includes("<urlset") || sm.text.includes("<sitemapindex")))
    add(A, "pass", 2, "Sitemap", `The sitemap lists ${(sm.text.match(/<loc>/g) ?? []).length} addresses.`);
  else add(A, "fail", 2, "Sitemap", "No sitemap found at the usual address or in robots.txt.",
    "A sitemap lists the pages you want found. Without one, search engines depend on links alone and can miss new or deep pages.");

  // ---- Titles and summaries
  A = "Titles and summaries";
  const t = pg.title ?? "";
  if (!t) add(A, "fail", 3, "Page title", "The page has no title.",
    "The title is the headline in search results. Without it, Google writes one from the page text, and the result is rarely what you would choose.");
  else if (t.length < 25) add(A, "warn", 2, "Page title", `The title is ${t.length} characters: "${t}"`,
    "A title this length says little about the page. Search results allow about 60 characters.");
  else if (t.length > 60) add(A, "warn", 1, "Page title", `The title is ${t.length} characters: "${t}"`,
    "Search results cut titles after about 60 characters. Visitors read a headline that ends mid-sentence.");
  else add(A, "pass", 3, "Page title", `The title is ${t.length} characters: "${t}"`);
  const d = metaValue(pg, "description") ?? "";
  if (!d) add(A, "fail", 2, "Search summary", "The page has no meta description.",
    "This is the summary under the title in search results. Without it, Google picks text from the page, which can be a menu or a cookie notice.");
  else if (d.length < 70) add(A, "warn", 1, "Search summary", `The summary is ${d.length} characters.`,
    "Search results show up to about 155 characters. The rest of the space goes unused.");
  else if (d.length > 160) add(A, "warn", 1, "Search summary", `The summary is ${d.length} characters.`,
    "Search results cut it after about 155 characters, so the end of your message is lost.");
  else add(A, "pass", 2, "Search summary", `The summary is ${d.length} characters.`);
  const ogKeys = ["og:title", "og:description", "og:image"];
  const missing = ogKeys.filter((k) => !metaValue(pg, k, "property"));
  if (missing.length) add(A, "warn", 1, "Link preview",
    missing.length === 3 ? "No preview image or text is set for shared links." : `Missing for shared links: ${missing.join(", ")}.`,
    "When someone shares the page on LinkedIn, Slack or WhatsApp, it appears as a bare link.");
  else add(A, "pass", 1, "Link preview", "Shared links show a title, text and image.");

  // ---- Page outline
  A = "Page outline";
  const h1s = pg.headings.filter(([l]) => l === 1).map(([, x]) => x);
  if (!h1s.length) add(A, "fail", 3, "Main heading", "The page has no main heading (H1).",
    "The main heading tells search engines and AI assistants what the page is about. Without it, they infer it.");
  else if (h1s.length > 1) add(A, "warn", 1, "Main heading", `The page has ${h1s.length} main headings.`,
    "Pages work best with one. With several, the topic of the page is less clear.");
  else add(A, "pass", 3, "Main heading", `The main heading is "${h1s[0]}"`);
  const levels = pg.headings.map(([l]) => l);
  const jumps: [number, number][] = [];
  for (let i = 0; i < levels.length - 1; i++) if (levels[i + 1] > levels[i] + 1) jumps.push([levels[i], levels[i + 1]]);
  if (jumps.length) add(A, "warn", 1, "Heading order", `Heading levels skip in ${jumps.length} places, for example H${jumps[0][0]} followed by H${jumps[0][1]}.`,
    "AI assistants and screen readers follow headings like a table of contents. Gaps break the outline.");
  else if (levels.length) add(A, "pass", 1, "Heading order", "Headings follow in order.");
  if (!pg.lang) add(A, "warn", 1, "Language", "The page does not declare its language.",
    "Search engines and screen readers have to guess. A wrong guess sends the page to the wrong audience.");
  else add(A, "pass", 1, "Language", `The page language is set to "${pg.lang}".`);
  if (!metaValue(pg, "viewport")) add(A, "fail", 2, "Phone layout", "The page has no mobile viewport setting.",
    "Phones show the page at desktop width and visitors have to zoom. Google reads the phone version first.");
  else add(A, "pass", 2, "Phone layout", "The page is set up for phone screens.");

  // ---- Labels
  A = "Labels";
  const { types, bad } = jsonldTypes(pg.jsonld);
  if (bad) add(A, "fail", 2, "Schema labels", `${bad} label block(s) contain errors and cannot be read.`,
    "Search engines ignore labels they cannot read, so the work of adding them is lost.");
  if (!pg.jsonld.length) add(A, "fail", 2, "Schema labels", "No schema labels found on this page.",
    "Without them, search engines and AI assistants guess what your business is, what you offer and where you work.");
  else if (types.length) {
    add(A, "pass", 2, "Schema labels", `Labels found: ${types.join(", ")}.`);
    if (fu.pathname === "/" || fu.pathname === "") {
      const ent = ["organization", "business", "corporation", "person", "store", "service"];
      if (!types.some((x) => ent.some((e) => x.toLowerCase().includes(e))))
        add(A, "warn", 2, "Business identity", "The labels do not say who the business is.",
          "AI assistants answer who a company is from labels like these. Without them, they rely on guesses.");
    }
  }
  const qs = pg.headings.filter(([, h]) => h.endsWith("?"));
  if (qs.length >= 2 && !types.includes("FAQPage")) add(A, "warn", 1, "Questions", `The page has ${qs.length} questions that are not labelled as questions.`,
    "AI assistants pull answers from labelled question-and-answer blocks. Unlabelled ones are harder to quote.");

  // ---- Speed
  A = "Speed";
  const tt = main.ttfb;
  if (tt < 0.8) add(A, "pass", 2, "Server response", `The server started responding in ${tt.toFixed(1)} seconds.`);
  else add(A, tt >= 1.8 ? "fail" : "warn", 2, "Server response", `The server took ${tt.toFixed(1)} seconds to start responding.`,
    "Visitors on a phone wait before anything appears. Many leave a page that stays blank.");
  const kb = Math.floor(main.size / 1024);
  if (kb > 250) add(A, "warn", 1, "Page weight", `The page HTML is ${kb} KB.`, "Heavy pages take longer to load on a mobile connection.");
  else add(A, "pass", 1, "Page weight", `The page HTML is ${kb} KB.`);
  const blocking = pg.scripts.filter(({ attrs: s, inHead }) => inHead && !("async" in s) && !("defer" in s) && (s.type ?? "").toLowerCase() !== "module");
  if (blocking.length >= 3) add(A, "warn", 2, "Blocking scripts", `${blocking.length} scripts in the page head must load before the page appears.`,
    "Visitors look at a blank screen while they download.");
  else add(A, "pass", 2, "Blocking scripts", `${blocking.length} scripts block the first view.`);
  if (pg.scripts.length + pg.stylesheets > 20) add(A, "warn", 1, "Files loaded", `The page loads ${pg.scripts.length} scripts and ${pg.stylesheets} stylesheets.`,
    "Each file is a separate request. On a phone connection they add up.");
  if (main.redirects >= 2) add(A, "warn", 1, "Redirects", `The address passes through ${main.redirects} redirects before the page loads.`,
    "Each redirect adds a round trip before the visitor sees anything.");

  // ---- Images
  A = "Images";
  const imgs = pg.images;
  if (imgs.length) {
    const noalt = imgs.filter((i) => !("alt" in i));
    if (noalt.length) add(A, noalt.length / imgs.length >= 0.5 && noalt.length >= 3 ? "fail" : "warn", 2, "Image descriptions",
      `${noalt.length} of ${imgs.length} images have no description (alt text).`,
      "Search engines and AI assistants cannot see images. The description is all they read. Screen-reader users hear a file name or nothing.");
    else add(A, "pass", 2, "Image descriptions", `All ${imgs.length} images carry a description attribute.`);
    const nodim = imgs.filter((i) => !(i.width && i.height));
    if (nodim.length >= 3) add(A, "warn", 1, "Image dimensions", `${nodim.length} images have no width and height set.`,
      "The page jumps as images load. Visitors tap the wrong thing, and Google measures this movement.");
    const eager = imgs.slice(3).filter((i) => (i.loading ?? "").toLowerCase() !== "lazy");
    if (eager.length >= 5) add(A, "warn", 1, "Image loading", `${eager.length} images far down the page load right away.`,
      "They compete with the content visitors see first, which slows the first view.");
    const srcs = [...new Set(imgs.map((i) => i.src ?? "").filter((s) => s && !s.startsWith("data:")))].slice(0, 12);
    const sizes = (await Promise.all(srcs.map(async (s) => {
      let abs: string;
      try { abs = new URL(s, final).toString(); } catch { return null; }
      const r = await net.tryGet(abs, { method: "HEAD", timeout: 6000 });
      const n = Number(r?.headers.get("content-length"));
      return r && r.status === 200 && n > 0 ? n : null;
    }))).filter((x): x is number => x !== null);
    const heavy = sizes.filter((x) => x > 300_000);
    if (heavy.length) add(A, "warn", 2, "Image weight",
      `${heavy.length} of ${sizes.length} images we measured are over 300 KB. The largest is ${(Math.max(...heavy) / 1_000_000).toFixed(1)} MB.`,
      "Large images are the most common reason a page is slow on a phone.");
    else if (sizes.length) add(A, "pass", 2, "Image weight", `None of the ${sizes.length} images we measured is over 300 KB.`);
  } else add(A, "info", 0, "Images", "No images found in the page HTML.");

  // ---- Access for AI
  A = "Access for AI";
  const path = fu.pathname + fu.search;
  const blocked = robotsOk ? ROBOTS_BOTS.filter((b) => !canFetch(rb.groups, b, path)) : [];
  if (blocked.length) add(A, blocked.length >= 4 ? "fail" : "warn", 2, "AI rules in robots.txt",
    `robots.txt tells these AI crawlers to stay out: ${blocked.join(", ")}.`,
    "Content they cannot read cannot be quoted in their answers. If this is a choice, it is worth confirming. If it is not, it is a leftover.");
  else add(A, "pass", 2, "AI rules in robots.txt", "robots.txt does not block the main AI crawlers.");
  const refused: string[] = [];
  await Promise.all(Object.entries(AI_BOTS).map(async ([name, ua]) => {
    const r = await net.tryGet(final, { ua, body: false, timeout: 10000 });
    if (r && [401, 403, 429, 503].includes(r.status) && main.status === 200) refused.push(name);
  }));
  if (refused.length) add(A, "warn", 2, "AI access at the server",
    `The server turned away requests that identify as ${refused.sort().join(", ")}.`,
    "Even where robots.txt allows them, a firewall can block AI assistants. Real crawlers may be treated differently, so this needs a closer look.");
  else add(A, "pass", 2, "AI access at the server", "The server answered requests that identify as AI crawlers.");
  if (pg.words < 150) add(A, "warn", 2, "Text in the page HTML", `The page HTML holds ${pg.words} words of text.`,
    "Many AI crawlers read the HTML and do not run scripts. Text that scripts add later may never reach them.");
  else add(A, "pass", 2, "Text in the page HTML", `The page HTML holds ${pg.words} words of text.`);
  const llms = await net.tryGet(origin + "/llms.txt", { timeout: 8000 });
  if (llms && llms.status === 200 && !looksHtml(llms.text) && llms.text.length > 20) add(A, "pass", 0, "llms.txt", "An llms.txt file is in place.");
  else add(A, "info", 0, "llms.txt", "No llms.txt file found.",
    "This plain-text guide to your site is written for AI assistants. It is new and no assistant promises to use it. Its absence is a gap, not a fault.");

  const low = main.text.toLowerCase();
  const webflow = (metaValue(pg, "generator") ?? "").toLowerCase().includes("webflow") || low.includes("data-wf-") || low.includes("website-files.com");
  return { url, finalUrl: final, date: new Date().toISOString().slice(0, 10), webflow, findings: out };
}
