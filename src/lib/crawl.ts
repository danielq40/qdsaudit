// Site discovery and per-page analysis. Each call stays well under the Workers subrequest limit.
import {
  AI_BOTS, FetchError, Fetcher, ROBOTS_BOTS, canFetch, ldNodes, metaValue, parseHtml, parseRobots, type Resp,
} from "./audit";
import type { PageRec, SiteInfo, StartResponse } from "./types";

export const CAP = 1000;
export const BATCH = 50;
const SITEMAP_LIMIT = 2000;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|mp[34]|mov|webm|css|js|json|xml|txt|docx?|xlsx?|pptx?|woff2?|ttf|rss|atom)$/i;
const looksHtml = (s: string) => s.trimStart().startsWith("<");
const rand = () => Math.random().toString(36).slice(2, 10);
const bare = (h: string) => h.replace(/^www\./, "");

export function parseInput(input: string): string {
  let u = input.trim();
  if (!u) throw new FetchError("Enter your website address.");
  if (!u.includes("://")) u = "https://" + u;
  return u;
}

/** Keeps one address per page: same host as the site, no fragment, no tracking parameters. */
export function pageKey(raw: string, base: string, canonHost: string): string | null {
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (bare(u.host.toLowerCase()) !== bare(canonHost)) return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${u.protocol}//${canonHost}${path}${u.search}`;
}

export function sectionOf(finalUrl: string): string {
  const segs = new URL(finalUrl).pathname.split("/").filter(Boolean);
  if (!segs.length) return "Home";
  if (segs.length === 1) return "Main pages";
  let s = segs[0];
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  s = s.replace(/[-_]+/g, " ").slice(0, 40);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

/** Spreads the cap across the sections of the site so a large blog does not use every slot. */
function sample(urls: string[], first: string, cap: number): string[] {
  const rest = urls.filter((u) => u !== first);
  if (rest.length + 1 <= cap) return [first, ...rest];
  const groups = new Map<string, string[]>();
  for (const u of rest) {
    const segs = new URL(u).pathname.split("/").filter(Boolean);
    const k = segs.length < 2 ? "" : segs[0];
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(u);
  }
  const lists = [...groups.values()];
  const out = [first];
  for (let i = 0; out.length < cap; i++) {
    let any = false;
    for (const l of lists) if (i < l.length && out.length < cap) { out.push(l[i]); any = true; }
    if (!any) break;
  }
  return out;
}

async function readSitemap(net: Fetcher, url: string, depth = 0): Promise<string[]> {
  const r = await net.tryGet(url, { timeout: 10000 });
  if (!r || r.status !== 200) return [];
  const locs = [...r.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  if (r.text.includes("<sitemapindex") && depth === 0) {
    const kids = await pool(locs.slice(0, 8), 4, (l) => readSitemap(net, l, 1));
    return kids.flat();
  }
  return r.text.includes("<urlset") ? locs : [];
}

export async function start(input: string, allowPrivate: boolean): Promise<StartResponse> {
  const net = new Fetcher(allowPrivate);
  const home = await net.get(parseInput(input));
  if (home.status >= 400) throw new FetchError(`The address answered with an error (status ${home.status}). Check it and try again.`);
  const fu = new URL(home.finalUrl);
  const origin = fu.origin;
  const host = fu.host.toLowerCase();
  const pg = parseHtml(home.text);

  const robots = await net.tryGet(origin + "/robots.txt", { timeout: 8000 });
  const robotsOk = !!robots && robots.status === 200 && !looksHtml(robots.text);
  const rb = parseRobots(robotsOk ? robots!.text : "");
  const aiBlocked = robotsOk ? ROBOTS_BOTS.filter((b) => !canFetch(rb.groups, b, "/")) : [];

  const smUrls = rb.sitemaps.length ? rb.sitemaps.slice(0, 3) : [origin + "/sitemap.xml"];
  const smAll = (await Promise.all(smUrls.map((u) => readSitemap(net, u)))).flat();
  const keys = new Set<string>();
  let staging = 0;
  for (const l of smAll) {
    if (/\.webflow\.io/i.test(l) && !host.endsWith(".webflow.io")) staging++;
    const k = pageKey(l, origin, host);
    if (k && keys.size < SITEMAP_LIMIT) keys.add(k);
  }
  const sitemapUrls = [...keys];

  const [llms, refused, httpR, twin, nf] = await Promise.all([
    net.tryGet(origin + "/llms.txt", { timeout: 8000 }),
    Promise.all(Object.entries(AI_BOTS).map(async ([name, ua]) => {
      const r = await net.tryGet(home.finalUrl, { ua, body: false, timeout: 10000 });
      return r && [401, 403, 429, 503].includes(r.status) ? name : null;
    })),
    allowPrivate || fu.protocol !== "https:" ? null : net.tryGet(`http://${host}/`, { body: false, timeout: 8000 }),
    allowPrivate || host.endsWith(".webflow.io") ? null : (async () => {
      const alt = host.startsWith("www.") ? host.slice(4) : "www." + host;
      const r = await net.tryGet(`https://${alt}/`, { body: false, timeout: 8000 });
      const state: "ok" | "split" | "down" = !r ? "down" : new URL(r.finalUrl).hostname.toLowerCase() === host ? "ok" : "split";
      return { host: alt, state };
    })(),
    allowPrivate ? null : net.tryGet(`${origin}/qds-check-${rand()}`, { body: false, timeout: 8000 }),
  ]);

  const { nodes } = ldNodes(pg.jsonld);
  const orgNodes = nodes.filter((n) => n.types.some((t) => /organization|business|corporation|person|store|service/i.test(t)));
  const site: SiteInfo = {
    host, origin, finalUrl: home.finalUrl,
    https: fu.protocol === "https:",
    webflow: (metaValue(pg, "generator") ?? "").toLowerCase().includes("webflow") || /data-wf-|website-files\.com/i.test(home.text),
    httpRedirects: httpR ? new URL(httpR.finalUrl).protocol === "https:" : null,
    alt: twin ?? null,
    soft404: nf ? nf.status === 200 : null,
    robots: { found: robotsOk, blocksAll: robotsOk && !canFetch(rb.groups, "*", "/"), aiBlocked },
    aiRefused: refused.filter((x): x is string => !!x).sort(),
    sitemap: { found: sitemapUrls.length > 0, count: sitemapUrls.length, staging },
    llms: !!llms && llms.status === 200 && !looksHtml(llms.text) && llms.text.length > 20,
    home: {
      org: orgNodes.length > 0,
      sameAs: nodes.some((n) => n.keys.includes("sameAs")),
      contact: pg.links.some((l) => /^(tel|mailto):/i.test(l.href)) || nodes.some((n) => n.keys.some((k) => /telephone|email|contactPoint/i.test(k))),
    },
  };

  const homeKey = pageKey(home.finalUrl, origin, host) ?? origin;
  const links = pg.links.map((l) => pageKey(l.href, home.finalUrl, host)).filter((k): k is string => !!k);
  const known = new Set<string>([homeKey, ...sitemapUrls, ...links]);
  const pool0 = sitemapUrls.length ? sitemapUrls : [...new Set(links)];
  return { site, seeds: sample(pool0, homeKey, CAP), sitemapUrls, known: known.size };
}

// ------------------------------------------------------------ page analysis

const PLACEHOLDER = /^(home|untitled|new page|page|index|webflow|document)$/i;
export const isPlaceholderTitle = (t: string) => PLACEHOLDER.test(t) || /lorem ipsum/i.test(t);

function failedPage(url: string): PageRec {
  return {
    url, final: url, status: 0, html: false, redirected: false, hops: 0, section: "Main pages", inSitemap: false, title: "", descLen: 0, h1: 0, skips: 0,
    noindex: false, canonicalOther: false, ogImage: false, imgs: 0, noAlt: 0, noDims: 0, heavy: [], ld: 0, ldBad: 0, ldThin: false,
    article: false, author: false, date: false, words: 0, viewport: false, lang: false, blocking: 0, bytes: 0, ttfb: 0,
    navBad: false, staging: false, lorem: false, links: [],
  };
}

function analyze(url: string, r: Resp, host: string): { rec: PageRec; pg: ReturnType<typeof parseHtml> | null } {
  const rec = failedPage(url);
  rec.status = r.status;
  rec.final = r.finalUrl;
  rec.redirected = r.redirects > 0;
  rec.hops = r.redirects;
  rec.ttfb = r.ttfb;
  rec.bytes = r.size;
  const ctype = (r.headers.get("content-type") ?? "").toLowerCase();
  rec.html = r.status < 400 && (ctype.includes("html") || (!ctype && looksHtml(r.text)));
  rec.section = sectionOf(r.finalUrl);
  if (!rec.html) return { rec, pg: null };

  const pg = parseHtml(r.text);
  const fu = new URL(r.finalUrl);
  rec.title = (pg.title ?? "").slice(0, 120);
  const desc = metaValue(pg, "description") ?? "";
  rec.descLen = desc.length;
  rec.h1 = pg.headings.filter(([l]) => l === 1).length;
  const lv = pg.headings.map(([l]) => l);
  rec.skips = lv.filter((l, i) => i < lv.length - 1 && lv[i + 1] > l + 1).length;
  const robotsMeta = ((metaValue(pg, "robots") ?? "") + " " + (metaValue(pg, "googlebot") ?? "")).toLowerCase();
  rec.noindex = robotsMeta.includes("noindex") || (r.headers.get("x-robots-tag") ?? "").toLowerCase().includes("noindex");
  if (pg.canonical) {
    const ck = pageKey(pg.canonical, r.finalUrl, host);
    const own = pageKey(r.finalUrl, r.finalUrl, host);
    rec.canonicalOther = !ck || (own !== null && ck !== own);
  }
  rec.ogImage = !!metaValue(pg, "og:image", "property");
  rec.imgs = pg.images.length;
  rec.noAlt = pg.images.filter((i) => !("alt" in i)).length;
  rec.noDims = pg.images.filter((i) => !(i.width && i.height)).length;

  const { nodes, bad } = ldNodes(pg.jsonld);
  rec.ld = nodes.length;
  rec.ldBad = bad;
  const arts = nodes.filter((n) => n.types.some((t) => /article|blogposting|newsarticle/i.test(t)));
  rec.ldThin = arts.some((n) => !["headline", "author", "datePublished"].every((k) => n.keys.includes(k)));
  rec.article = arts.length > 0 || (metaValue(pg, "og:type", "property") ?? "").toLowerCase() === "article" ||
    (fu.pathname.split("/").filter(Boolean).length >= 2 && /^(blog|news|articles?|insights?|posts?|journal|resources)$/i.test(fu.pathname.split("/")[1]));
  rec.author = nodes.some((n) => n.keys.includes("author")) || !!metaValue(pg, "author") || /rel=["']?author/i.test(r.text);
  rec.date = nodes.some((n) => n.keys.includes("datePublished") || n.keys.includes("dateModified")) || pg.hasTime ||
    !!metaValue(pg, "article:published_time", "property");
  rec.words = pg.words;
  rec.viewport = !!metaValue(pg, "viewport");
  rec.lang = !!pg.lang;
  rec.blocking = pg.scripts.filter(({ attrs: s, inHead }) => inHead && !("async" in s) && !("defer" in s) && (s.type ?? "").toLowerCase() !== "module").length;
  rec.lorem = pg.lorem || /lorem ipsum/i.test(rec.title + " " + desc);
  rec.navBad = pg.links.some((l) => l.nav && (!l.href || l.href === "#" || /^javascript:/i.test(l.href)));

  const onStaging = !fu.hostname.endsWith(".webflow.io");
  const stagingRef = (v: string | null | undefined) => !!v && /(^|\/\/|\.)[a-z0-9-]+\.webflow\.io/i.test(v);
  rec.staging = onStaging && (stagingRef(pg.canonical) || stagingRef(metaValue(pg, "og:url", "property")) || pg.links.some((l) => stagingRef(l.href)));

  const seen = new Set<string>();
  for (const l of pg.links) {
    const k = pageKey(l.href, r.finalUrl, host);
    if (k && !seen.has(k) && seen.size < 80) seen.add(k);
  }
  rec.links = [...seen];
  return { rec, pg };
}

export async function checkPages(origin: string, urls: string[], allowPrivate: boolean): Promise<PageRec[]> {
  const base = new URL(origin);
  const host = base.host.toLowerCase();
  const net = new Fetcher(allowPrivate);
  const sizes = new Map<string, Promise<number | null>>();
  const imgSize = (abs: string) => {
    if (!sizes.has(abs)) {
      sizes.set(abs, net.tryGet(abs, { method: "HEAD", timeout: 6000 }).then((r) => {
        const n = Number(r?.headers.get("content-length"));
        return r && r.status === 200 && n > 0 ? n : null;
      }));
    }
    return sizes.get(abs)!;
  };
  const list = urls.filter((u) => pageKey(u, origin, host)).slice(0, BATCH);
  return pool(list, 6, async (u) => {
    let r: Resp | null = null;
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      try {
        r = await net.get(u, { timeout: 12000 });
      } catch (e) {
        if (e instanceof FetchError && /public internet|web address/i.test(e.message)) throw e;
      }
    }
    if (!r) return failedPage(u);
    const { rec, pg } = analyze(u, r, host);
    if (pg && rec.imgs) {
      const srcs = [...new Set(pg.images.map((i) => i.src ?? "").filter((s) => s && !s.startsWith("data:")))].slice(0, 3);
      for (const s of srcs) {
        let abs: string;
        try { abs = new URL(s, r.finalUrl).toString(); } catch { continue; }
        const n = await imgSize(abs);
        if (n && n > 300_000) rec.heavy.push([s.slice(0, 120), n]);
      }
    }
    return rec;
  });
}
