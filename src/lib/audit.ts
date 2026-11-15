// Network and parsing helpers for the QDS AI & SEO readiness check. Runs on Cloudflare Workers (Webflow Cloud).
import { Parser } from "htmlparser2";

export class FetchError extends Error {}

export const UA = "Mozilla/5.0 (compatible; QDSAudit/0.1)";
export const AI_BOTS: Record<string, string> = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
};
export const ROBOTS_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"];

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

export interface Resp {
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
export interface Parsed {
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
  links: { href: string; nav: boolean }[];
  hasTime: boolean;
  lorem: boolean;
}

export function parseHtml(htmlText: string): Parsed {
  const p: Parsed = { title: null, meta: [], headings: [], images: [], scripts: [], jsonld: [], lang: null, words: 0, stylesheets: 0, canonical: null, links: [], hasTime: false, lorem: false };
  let navDepth = 0;
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
      else if (name === "a") p.links.push({ href: a.href ?? "", nav: navDepth > 0 });
      else if (name === "nav") navDepth++;
      else if (name === "time") p.hasTime = true;
    },
    onclosetag(name) {
      if (name === "nav") navDepth = Math.max(0, navDepth - 1);
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
        if (!p.lorem && /lorem ipsum/i.test(t)) p.lorem = true;
        p.words += t.split(/\s+/).filter(Boolean).length;
        if (h) h.buf += t;
      }
    },
  }, { decodeEntities: true });
  parser.write(htmlText);
  parser.end();
  return p;
}

export const metaValue = (p: Parsed, key: string, attr = "name") =>
  p.meta.find((m) => (m[attr] ?? "").toLowerCase() === key)?.content?.trim() ?? null;

export interface LdNode { types: string[]; keys: string[] }

export function ldNodes(blocks: string[]): { nodes: LdNode[]; bad: number } {
  const nodes: LdNode[] = [];
  let bad = 0;
  const walk = (x: any) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const t = x["@type"];
      if (t) nodes.push({ types: (Array.isArray(t) ? t : [t]).map(String), keys: Object.keys(x).filter((k) => x[k] != null && x[k] !== "" && !(Array.isArray(x[k]) && !x[k].length)) });
      Object.values(x).forEach((v) => typeof v === "object" && walk(v));
    }
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b)); } catch { bad++; }
  }
  return { nodes, bad };
}

// ------------------------------------------------------------- robots.txt

interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }

export function parseRobots(text: string): { groups: Group[]; sitemaps: string[] } {
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

export function canFetch(groups: Group[], ua: string, path: string): boolean {
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

