// Turns site checks and per-page results into five plain-language questions, each with its checks.
import { CAP, isPlaceholderTitle } from "./crawl";
import type { AreaResult, CheckRow, Contact, Level, LinkCheck, PageRec, Report, SiteInfo } from "./types";

type IssueLevel = "risk" | "review" | "note";
interface Issue extends Omit<CheckRow, "level"> {
  area: string;
  level: IssueLevel;
  sev: number;
}

const AREAS = [
  { id: "ai", n: "01", question: "Is my site ready for AI?", short: "AI" },
  { id: "seo", n: "02", question: "Is my site optimized for search engines?", short: "Search" },
  { id: "broken", n: "03", question: "Is my site broken?", short: "Broken" },
  { id: "fast", n: "04", question: "Is my site fast?", short: "Speed" },
  { id: "structure", n: "05", question: "Is my site structured properly?", short: "Structure" },
] as const;

const fmt = (n: number) => n.toLocaleString("en-US");
const pl = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
const path = (u: string) => {
  try { const x = new URL(u); return (x.pathname + x.search).slice(0, 60) || "/"; } catch { return u.slice(0, 60); }
};

/** Says where the affected pages sit, for example "38 are articles". */
function where(affected: PageRec[]): string {
  if (affected.length < 4) return "";
  const arts = affected.filter((p) => p.article).length;
  if (arts / affected.length >= 0.5 && arts >= 3) return ` ${fmt(arts)} are articles.`;
  const by = new Map<string, number>();
  for (const p of affected) by.set(p.section, (by.get(p.section) ?? 0) + 1);
  const [name, n] = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  if (by.size >= 2 && n / affected.length >= 0.5 && n >= 3) return ` ${fmt(n)} are in ${name}.`;
  return "";
}

const pctText = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

export function buildReport(site: SiteInfo, all: PageRec[], known: number, date: string, link: LinkCheck, contact: Contact): Report {
  const pages = all.filter((p) => p.html && p.status < 400);
  const N = pages.length;
  const issues: Issue[] = [];
  const oks: Record<string, string[]> = { ai: [], seo: [], broken: [], fast: [], structure: [] };
  const ok = (area: string, cond: boolean, text: string) => { if (cond) oks[area].push(text); };
  // Every check feeds the score of its area: weight by severity, health from 0 (fails everywhere) to 1 (passes everywhere).
  const tally: Record<string, { w: number; h: number }> = { ai: { w: 0, h: 0 }, seo: { w: 0, h: 0 }, broken: { w: 0, h: 0 }, fast: { w: 0, h: 0 }, structure: { w: 0, h: 0 } };
  const count = (area: string, w: number, health: number) => { tally[area].w += w; tally[area].h += w * Math.max(0, Math.min(1, health)); };

  const siteIssue = (area: string, level: "risk" | "review", name: string, why: string, tech: string) =>
    { count(area, level === "risk" ? 3 : 1.5, 0); issues.push({ area, level, sev: level === "risk" ? 2 : 1, share: 1, pct: "Site-wide", of: "", name, why, tech, examples: [] }); };

  // A share-based issue. `sev` 2 can reach At risk, `sev` 1 stops at Review.
  const pageIssue = (area: string, sev: 1 | 2, affected: PageRec[], total: number, name: string, why: string, tech: string) => {
    const n = affected.length;
    if (!total) return;
    count(area, sev === 2 ? 2 : 1, 1 - n / total);
    if (!n) return;
    const share = n / total;
    const level: IssueLevel = share >= 0.25 ? (sev === 2 ? "risk" : "review") : share >= 0.05 || (sev === 2 && n >= 1) ? "review" : "note";
    issues.push({
      area, level, sev, share, pct: pctText(share), of: `${fmt(n)} of ${fmt(total)} pages`, name, why,
      tech: tech + where(affected), examples: affected.slice(0, 3).map((p) => path(p.url)),
    });
  };

  // ================= 01 Is my site ready for AI?
  const noLd = pages.filter((p) => !p.ld);
  pageIssue("ai", 2, noLd, N, "Pages that do not say what they are",
    "AI assistants and search engines have to guess what each page is about and who is behind it.",
    "No schema markup (JSON-LD) found, such as Organization, Article or FAQPage.");
  pageIssue("ai", 2, pages.filter((p) => p.ldBad), N, "Pages with labels that cannot be read",
    "The labels were added, but they contain errors, so search engines ignore them.", "JSON-LD that fails to parse.");
  pageIssue("ai", 1, pages.filter((p) => p.ldThin), N, "Articles with incomplete labels",
    "Without the key details, AI assistants have little to quote or credit.", "Article schema missing headline, author or datePublished.");
  const nb = site.robots.aiBlocked.length;
  if (nb) siteIssue("ai", nb >= 4 ? "risk" : "review", `${nb} of 7 main AI crawlers are told to stay out`,
    "What they cannot read cannot be quoted in their answers. If this is a choice, confirm it. If not, it is a leftover.",
    `robots.txt disallows: ${site.robots.aiBlocked.join(", ")}.`);
  else { count("ai", 2, 1); ok("ai", site.robots.found, "No AI crawler is blocked in robots.txt."); }
  if (site.aiRefused.length) siteIssue("ai", "review", "Your server turns away AI crawlers",
    "Even where robots.txt allows them, a firewall can block AI assistants. This needs a closer look.",
    `Requests identifying as ${site.aiRefused.join(", ")} got 401, 403, 429 or 503.`);
  else { count("ai", 1, 1); ok("ai", true, "The server answers requests that identify as AI crawlers."); }
  pageIssue("ai", 2, pages.filter((p) => p.words < 150 && !p.noindex), N, "Pages with almost no readable text",
    "Many AI crawlers do not run scripts. Text that a script adds later may never reach them.", "Fewer than 150 words in the initial HTML.");
  const arts = pages.filter((p) => p.article);
  pageIssue("ai", 1, arts.filter((p) => !p.author), arts.length, "Articles without an author",
    "AI assistants weigh who wrote a page. Yours do not say.", "No author in schema or meta tags, and no rel=author link.");
  pageIssue("ai", 1, arts.filter((p) => !p.date), arts.length, "Articles without a date",
    "Readers and AI assistants cannot tell whether the content is current.", "No datePublished, article:published_time or time element.");
  if (!site.home.org) siteIssue("ai", "review", "The home page does not say who the business is",
    "AI assistants answer \"who is this company?\" from labels like these. Without them, they rely on guesses.", "No Organization or LocalBusiness schema on the home page.");
  else {
    ok("ai", true, "The home page labels the business.");
    count("ai", 1, 1);
    if (site.home.sameAs) count("ai", 1, 1);
    else siteIssue("ai", "review", "The business labels have no links to your profiles",
      "Profile links let search engines and AI assistants confirm that the business is real.", "Organization schema without sameAs.");
  }
  if (site.home.contact) count("ai", 1, 1);
  else siteIssue("ai", "review", "No contact details the machines can read",
    "Visitors and AI assistants look for a way to reach you before they trust you.", "No tel: or mailto: link and no contactPoint on the home page.");
  ok("ai", !noLd.length && N > 0, "Every page carries structured data.");

  // ================= 02 Is my site optimized for search engines?
  pageIssue("seo", 2, pages.filter((p) => !p.descLen), N, "Pages with no description in search results",
    "Google writes the summary for you. It can pick a menu or a cookie notice.", "Missing meta description.");
  pageIssue("seo", 2, pages.filter((p) => !p.title || isPlaceholderTitle(p.title)), N, "Pages with no real title",
    "The title is the headline in search results. Without a real one, Google writes it.", "Missing, empty or placeholder <title>.");
  pageIssue("seo", 1, pages.filter((p) => p.title.length > 60), N, "Titles that get cut off",
    "Visitors read a headline that ends mid-sentence.", "<title> longer than 60 characters.");
  const tc = new Map<string, number>();
  for (const p of pages) if (p.title) tc.set(p.title.toLowerCase(), (tc.get(p.title.toLowerCase()) ?? 0) + 1);
  pageIssue("seo", 1, pages.filter((p) => p.title && (tc.get(p.title.toLowerCase()) ?? 0) > 1), N, "Pages that share a title",
    "Search engines struggle to tell them apart and may list only one.", "Identical <title> on more than one page.");
  pageIssue("seo", 1, pages.filter((p) => !p.ogImage), N, "Pages with no preview image when shared",
    "Shared links appear as a bare address on LinkedIn or WhatsApp, and fewer people click them.", "Missing og:image.");
  if (!site.sitemap.found) siteIssue("seo", "risk", "No sitemap",
    "A sitemap lists the pages you want found. Without one, search engines depend on links alone and can miss new or deep pages.", "No sitemap.xml at the usual address or in robots.txt.");
  else {
    count("seo", 2, 1);
    ok("seo", true, `The sitemap lists ${pl(site.sitemap.count, "address", "addresses")}.`);
    pageIssue("seo", 2, pages.filter((p) => !p.inSitemap && !p.noindex && !p.redirected), N, "Pages missing from the sitemap",
      "Google may not list these pages. What is not listed cannot be found.", "Pages linked on the site but absent from sitemap.xml.");
  }
  if (!site.robots.blocksAll) count("seo", 2, 1);
  else siteIssue("seo", "risk", "Search engines are told to stay out of the whole site",
    "Pages will not be listed at all. This often stays behind after a staging phase.", "robots.txt: User-agent * with Disallow /.");
  pageIssue("seo", 2, pages.filter((p) => p.noindex), N, "Pages hidden from search results",
    "These pages tell search engines not to list them. It is a common leftover from the staging site.", "meta robots or X-Robots-Tag set to noindex.");
  pageIssue("seo", 1, pages.filter((p) => p.canonicalOther && !p.noindex), N, "Pages that point to another address as the main one",
    "Search engines may list the other address and leave these pages out.", "rel=canonical points to a different URL.");

  // ================= 03 Is my site broken?
  const errs = all.filter((p) => p.status >= 400 || p.status === 0);
  pageIssue("broken", 2, errs, all.length, "Pages that return an error or do not load",
    "Visitors and search engines hit a dead end. Pages that fail are dropped from search results.", "HTTP 4xx and 5xx responses, timeouts and redirect loops.");
  count("broken", 2, 1 - link.pages / Math.max(N, 1));
  if (link.links) {
    const share = link.pages / Math.max(N, 1);
    issues.push({
      area: "broken", level: share >= 0.25 || link.links >= 20 ? "risk" : "review", sev: 2, share, pct: pctText(share), of: `${fmt(link.pages)} of ${fmt(N)} pages`,
      name: "Links that lead nowhere", why: "Visitors land on an error page, and search engines read broken links as a sign of a neglected site.",
      tech: `${pl(link.links, "internal link points", "internal links point")} to a URL that returns 4xx or 5xx.`,
      examples: link.examples.map(([f, t]) => `${path(f)} -> ${path(t)}`),
    });
  }
  pageIssue("broken", 1, pages.filter((p) => p.hops >= 3), N, "Pages that bounce through several redirects",
    "Each hop adds a delay, and long chains can lose search value on the way.", "Redirect chains of 3 or more hops.");
  const stag = pages.filter((p) => p.staging);
  count("broken", 2, N ? 1 - stag.length / N : 1);
  if (stag.length || site.sitemap.staging) {
    const n = stag.length;
    issues.push({
      area: "broken", level: "risk", sev: 2, share: N ? n / N : 1, pct: n ? pctText(n / N) : "Site-wide", of: n ? `${fmt(n)} of ${fmt(N)} pages` : "",
      name: "Leftovers from the test site", why: "These send search engines and visitors to a test copy instead of your own site.",
      tech: `webflow.io addresses in canonical, og:url or links${site.sitemap.staging ? `, and ${pl(site.sitemap.staging, "address", "addresses")} in the sitemap` : ""}.${where(stag)}`,
      examples: stag.slice(0, 3).map((p) => path(p.url)),
    });
  }
  pageIssue("broken", 2, pages.filter((p) => p.lorem), N, "Pages with placeholder text",
    "Visitors and search engines read it as an unfinished site.", "\"Lorem ipsum\" found in the page, title or description.");
  if (!site.https) siteIssue("broken", "risk", "The site opens without a secure connection",
    "Browsers mark it as Not secure next to the address. Visitors see that before they see your page.", "The site is served over http, not https.");
  else if (site.httpRedirects === false) siteIssue("broken", "review", "The insecure address does not redirect",
    "Visitors who type the address without https get an unsecured page.", "http:// does not redirect to https://.");
  else { count("broken", 2, 1); ok("broken", site.httpRedirects === true, "The site opens over a secure connection."); }
  if (site.alt?.state === "split") siteIssue("broken", "risk", "The site opens on two addresses",
    "Search engines can treat them as two sites and split your visibility.", `Both ${site.host} and ${site.alt.host} answer without redirecting.`);
  else if (site.alt?.state === "down") siteIssue("broken", "review", `${site.alt.host} does not open`, "Visitors who type it that way reach nothing.", "The www / non-www twin does not resolve.");
  else if (site.alt?.state === "ok") count("broken", 1.5, 1);
  if (site.soft404) siteIssue("broken", "review", "Addresses that do not exist answer as normal pages",
    "Search engines can list empty pages as if they were real, which waters down the site.", "A made-up URL returns status 200 instead of 404.");
  else if (site.soft404 === false) count("broken", 1, 1);
  ok("broken", errs.length === 0 && N > 0, "Every page we reached loads.");

  // ================= 04 Is my site fast?
  const heavy = new Map<string, number>();
  for (const p of pages) for (const [s, b] of p.heavy) heavy.set(s, b);
  count("fast", 1.5, 1 - pages.filter((p) => p.heavy.length).length / Math.max(N, 1));
  if (heavy.size) {
    const max = Math.max(...heavy.values());
    const withHeavy = pages.filter((p) => p.heavy.length);
    const share = withHeavy.length / Math.max(N, 1);
    issues.push({
      area: "fast", level: share >= 0.05 ? "review" : "note", sev: 1, share, pct: pctText(share),
      of: `${fmt(withHeavy.length)} of ${fmt(N)} pages`, name: "Heavy images",
      why: "Large images are the most common reason a page is slow on a phone. Visitors wait for it to appear.",
      tech: `${pl(heavy.size, "image is", "images are")} over 300 KB; the largest is ${(max / 1_000_000).toFixed(1)} MB (first 3 images per page measured).`,
      examples: withHeavy.slice(0, 3).map((p) => path(p.url)),
    });
  } else ok("fast", N > 0, "No image we measured is over 300 KB.");
  pageIssue("fast", 2, pages.filter((p) => p.ttfb >= 1.8), N, "Pages slow to start",
    "Visitors on a phone wait before anything appears. Many leave a page that stays blank.", "Time to first byte over 1.8 s, measured from our servers.");
  pageIssue("fast", 1, pages.filter((p) => p.blocking >= 3), N, "Pages held up by scripts",
    "Visitors look at a blank screen while the scripts download.", "3 or more render-blocking scripts in the head.");
  pageIssue("fast", 1, pages.filter((p) => p.bytes > 250_000), N, "Pages with heavy code",
    "Heavy pages take longer to load on a mobile connection.", "HTML over 250 KB.");
  pageIssue("fast", 1, pages.filter((p) => p.noDims >= 3), N, "Pages that jump while loading",
    "Images load without reserved space, so the page shifts and visitors tap the wrong thing.", "3 or more images without width and height.");
  ok("fast", !pages.some((p) => p.ttfb >= 1.8) && N > 0, "Pages start responding quickly.");

  // ================= 05 Is my site structured properly?
  pageIssue("structure", 2, pages.filter((p) => p.h1 === 0), N, "Pages with no main heading",
    "The main heading tells search engines and AI assistants what the page is about.", "No <h1>.");
  pageIssue("structure", 1, pages.filter((p) => p.h1 > 1), N, "Pages with more than one main heading",
    "With several, the topic of the page is less clear.", "More than one <h1>.");
  pageIssue("structure", 1, pages.filter((p) => p.skips > 0), N, "Headings out of order",
    "AI assistants and screen readers follow headings like a table of contents. Gaps break the outline.", "Heading levels skipped, such as H2 followed by H4.");
  const noAlt = pages.reduce((a, p) => a + p.noAlt, 0);
  const imgs = pages.reduce((a, p) => a + p.imgs, 0);
  const altPages = pages.filter((p) => p.noAlt > 0);
  count("structure", 1, 1 - altPages.length / Math.max(N, 1));
  if (noAlt) {
    const share = altPages.length / Math.max(N, 1);
    issues.push({
      area: "structure", level: share >= 0.05 ? "review" : "note", sev: 1, share, pct: pctText(share), of: `${fmt(altPages.length)} of ${fmt(N)} pages`,
      name: "Images with no description", why: "Search engines and AI assistants cannot see images. The description is all they read.",
      tech: `${fmt(noAlt)} of ${fmt(imgs)} images have no alt attribute.`, examples: altPages.slice(0, 3).map((p) => path(p.url)),
    });
  }
  pageIssue("structure", 1, pages.filter((p) => !p.lang), N, "Pages that do not declare their language",
    "Search engines have to guess, and a wrong guess sends the page to the wrong audience.", "No lang attribute on <html>.");
  pageIssue("structure", 1, pages.filter((p) => p.navBad), N, "Menu items that are not real links",
    "Crawlers follow links, not clicks. They may never reach the pages behind those items.", "Links in <nav> with no href, \"#\" or javascript:.");
  pageIssue("structure", 2, pages.filter((p) => !p.viewport), N, "Pages not set up for phones",
    "Phones show the page at desktop width and visitors have to zoom. Google reads the phone version first.", "No viewport meta tag.");
  ok("structure", !pages.some((p) => p.h1 === 0) && N > 0, "Every page has a main heading.");

  // ================= Assemble
  const rank = { risk: 2, review: 1, note: 0 };
  const areas: AreaResult[] = AREAS.map((a) => {
    const shown = issues.filter((i) => i.area === a.id && i.level !== "note")
      .sort((x, y) => rank[y.level] - rank[x.level] || y.sev - x.sev || y.share - x.share);
    const t = tally[a.id];
    const hasRisk = shown.some((i) => i.level === "risk");
    // A critical problem (site-wide, or on half the pages or more) caps the score, so the number and the label always agree.
    const blocking = shown.some((i) => i.level === "risk" && (i.pct === "Site-wide" || i.share >= 0.5));
    const base = t.w ? Math.round((100 * t.h) / t.w) : 100;
    const score = blocking ? Math.min(base, 59) : base;
    const level: Level = !shown.length ? "good" : score < 60 ? "risk" : score >= 85 && !hasRisk ? "almost" : "review";
    const checks: CheckRow[] = shown.map(({ area: _a, sev: _s, level: lv, ...rest }) => ({ ...rest, level: lv as "risk" | "review" }));
    const summary = level === "good" ? GOOD[a.id] : level === "almost" ? `Nearly there. ${pl(shown.length, "small thing is", "small things are")} left to tidy up.`
      : level === "risk" ? RISK[a.id] : `Mostly in place, with ${pl(shown.length, "thing", "things")} to improve.`;
    return { ...a, level, score, summary, checks, oks: oks[a.id].slice(0, 3) };
  });

  const risk = areas.filter((a) => a.level === "risk").length;
  const attn = areas.filter((a) => a.level === "risk" || a.level === "review").length;
  const total = Math.max(known, all.length);
  const capped = total > all.length && all.length >= CAP;
  const checkedTxt = capped ? `${fmt(all.length)} of ${fmt(total)} pages` : pl(all.length, "page", "pages");
  const notes = [
    capped ? `This tool checks up to ${fmt(CAP)} pages. Your site has more, so this report covers ${fmt(all.length)} of ${fmt(total)}. For a complete scan of every page, contact us.`
      : `This report covers ${pl(all.length, "page", "pages")}, read the way a search engine reads them.`,
    "Speed is an estimate from one request per page, not a measure of real visitors.",
    "We have not seen your Google Search Console data, your content or your competitors.",
    "We have not asked AI assistants about your company.",
  ];
  return {
    host: site.host, date, checked: all.length, total, capped,
    headline: attn ? `${attn} of 5 areas can be improved.` : areas.some((a) => a.level === "almost") ? "Almost perfect." : "All good.",
    sub: `We checked ${checkedTxt} on ${site.host}. ` + (risk ? `${pl(risk, "area needs", "areas need")} fixing first.` : attn ? "Nothing is broken, but there is room to improve." : "The basics are in place."),
    areas, notes, contact,
  };
}

const GOOD: Record<string, string> = {
  ai: "AI assistants can read your site and tell who is behind it.",
  seo: "Search results show what you chose to show.",
  broken: "Nothing we checked is broken.",
  fast: "Pages load without heavy files.",
  structure: "Your pages are built in a clear order.",
};
const RISK: Record<string, string> = {
  ai: "AI assistants may not understand or quote your site.",
  seo: "Search engines may not list or show your pages the way you want.",
  broken: "Visitors and search engines hit dead ends.",
  fast: "Visitors on a phone wait longer than they should.",
  structure: "Search engines and AI assistants cannot follow how pages are built.",
};
