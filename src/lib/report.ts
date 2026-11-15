// Turns site checks and per-page results into the six areas of the report.
import { CAP, isPlaceholderTitle } from "./crawl";
import type { AreaResult, Level, PageRec, Report, SiteInfo } from "./types";

type IssueLevel = "risk" | "review" | "note";
interface Issue {
  area: string;
  level: IssueLevel;
  sev: number;
  share: number;
  text: string;
  why: string;
  stat: string;
  caption: string;
}

const AREAS = [
  { id: "listed", n: "01", name: "Listed", question: "Can people find your pages?" },
  { id: "results", n: "02", name: "Search results", question: "What do people see when you appear?" },
  { id: "clarity", n: "03", name: "Clarity", question: "Can search engines and AI tell what you do?" },
  { id: "phone", n: "04", name: "Phone", question: "How does the page feel on a phone?" },
  { id: "ai", n: "05", name: "AI access", question: "Can AI assistants read and quote you?" },
  { id: "trust", n: "06", name: "Trust", question: "Can visitors and AI trust who you are?" },
] as const;

const pl = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Says where the affected pages sit, for example "38 are articles". */
function where(affected: PageRec[]): string {
  if (affected.length < 4) return "";
  const arts = affected.filter((p) => p.article).length;
  if (arts / affected.length >= 0.5 && arts >= 3) return ` ${arts} are articles.`;
  const by = new Map<string, number>();
  for (const p of affected) by.set(p.section, (by.get(p.section) ?? 0) + 1);
  const [name, n] = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  if (by.size >= 2 && n / affected.length >= 0.5 && n >= 3) return ` ${n} are in ${name}.`;
  return "";
}

export function buildReport(site: SiteInfo, all: PageRec[], known: number, date: string): Report {
  const pages = all.filter((p) => p.html && p.status < 400);
  const N = pages.length;
  const issues: Issue[] = [];

  const siteIssue = (area: string, level: "risk" | "review", text: string, why: string, stat: string, caption: string) =>
    issues.push({ area, level, sev: level === "risk" ? 2 : 1, share: 1, text, why, stat, caption });

  // A share-based issue. `sev` 2 can reach At risk, `sev` 1 stops at Review.
  const pageIssue = (area: string, sev: 1 | 2, affected: PageRec[], total: number, text: (n: number) => string, caption: string, why: string) => {
    const n = affected.length;
    if (!n || !total) return;
    const share = n / total;
    const level: IssueLevel = share >= 0.25 ? (sev === 2 ? "risk" : "review") : share >= 0.05 || (sev === 2 && n >= 1) ? "review" : "note";
    issues.push({ area, level, sev, share, text: text(n) + where(affected), why, stat: `${n.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`, caption });
  };

  // ---- Listed
  if (!site.sitemap.found) siteIssue("listed", "risk", "No sitemap found at the usual address or in robots.txt.",
    "A sitemap lists the pages you want found. Without one, search engines depend on links alone and can miss new or deep pages.", "No", "sitemap found");
  else {
    const missing = pages.filter((p) => !p.inSitemap && !p.noindex && p.status < 300 && !p.redirected);
    pageIssue("listed", 2, missing, N, (n) => `${pl(n, "page is", "pages are")} linked on your site but missing from the sitemap.`,
      "pages are linked on your site but missing from the sitemap", "Google may not list these pages. What is not listed cannot be found.");
  }
  if (site.robots.blocksAll) siteIssue("listed", "risk", "robots.txt tells all crawlers to stay out of the site.",
    "Search engines that obey it will not list your pages. This often stays behind after a staging phase.", "Closed", "robots.txt turns crawlers away");
  const noidx = pages.filter((p) => p.noindex);
  pageIssue("listed", 2, noidx, N, (n) => `${pl(n, "page tells", "pages tell")} search engines not to list ${n === 1 ? "it" : "them"}.`,
    "pages tell search engines not to list them", "Pages marked this way do not appear in search results. It is a common leftover from the staging site.");
  const errs = all.filter((p) => p.status >= 400 || p.status === 0);
  pageIssue("listed", 2, errs, all.length, (n) => (n === 1 ? "1 page returns an error or does not load." : `${n.toLocaleString("en-US")} pages return an error or do not load.`),
    "pages return an error", "Visitors and search engines hit a dead end. Pages that fail are dropped from search results.");
  const errSet = new Set(all.filter((p) => p.status >= 400).flatMap((p) => [p.url, p.final]));
  const redirSet = new Set(all.filter((p) => p.redirected && p.status < 400).map((p) => p.url));
  let broken = 0, viaRedirect = 0;
  const bs = new Set<string>(), rs = new Set<string>();
  for (const p of all) for (const l of p.links) {
    if (errSet.has(l)) bs.add(p.url + " " + l);
    else if (redirSet.has(l)) rs.add(p.url + " " + l);
  }
  broken = bs.size; viaRedirect = rs.size;
  if (broken) issues.push({ area: "listed", level: broken >= 5 ? "risk" : "review", sev: 2, share: broken / Math.max(N, 1), stat: String(broken), caption: "links lead to pages that return an error",
    text: broken === 1 ? "1 link leads to a page that returns an error." : `${broken.toLocaleString("en-US")} links lead to pages that return an error.`, why: "Visitors land on an error page, and search engines treat broken links as a sign of a neglected site." });
  if (viaRedirect >= 3) issues.push({ area: "listed", level: "note", sev: 1, share: viaRedirect / Math.max(N, 1), stat: String(viaRedirect), caption: "links go through a redirect",
    text: `${pl(viaRedirect, "link goes", "links go")} through a redirect before reaching the page.`, why: "Each redirect adds a delay and passes less value to the page." });
  if (!site.https) siteIssue("listed", "risk", "The site opens over http, not https.",
    "Browsers mark it as Not secure next to the address. Visitors see that before they see your page.", "http", "is how your site opens");
  else if (site.httpRedirects === false) siteIssue("listed", "review", "The http version of the site does not redirect to https.",
    "Visitors who type the address without https get an unsecured page, and browsers flag it as Not secure.", "No", "redirect from http to https");
  if (site.alt?.state === "split") siteIssue("listed", "risk", `The site opens on two addresses: ${site.host} and ${site.alt.host}.`,
    "Search engines can treat the two as separate sites and split your visibility between them.", "2", "addresses open the same site");
  else if (site.alt?.state === "down") siteIssue("listed", "review", `${site.alt.host} does not open.`,
    "Visitors who type it that way reach nothing.", "No", `page at ${site.alt.host}`);
  if (site.soft404) siteIssue("listed", "review", "Addresses that do not exist answer as normal pages.",
    "Search engines can list empty pages as if they were real, which waters down the site.", "200", "is what a missing page answers");
  pageIssue("listed", 1, pages.filter((p) => p.canonicalOther && !p.noindex), N, (n) => `${pl(n, "page names", "pages name")} another address as the main one.`,
    "pages name another address as the main one", "Search engines may list the other address and leave these pages out.");
  const stag = pages.filter((p) => p.staging);
  if (stag.length || site.sitemap.staging) {
    const n = Math.max(stag.length, site.sitemap.staging);
    issues.push({ area: "listed", level: "risk", sev: 2, share: 1, stat: String(n), caption: "addresses still point to a webflow.io test site",
      text: `${pl(n, "address still points", "addresses still point")} to a webflow.io test site.`.concat(where(stag)),
      why: "These are staging leftovers. They send search engines and visitors to a test copy instead of your own site." });
  }

  // ---- Search results
  pageIssue("results", 2, pages.filter((p) => !p.desc), N, (n) => `${pl(n, "page has", "pages have")} no description.`,
    "pages have no description", "Google writes the summary for you. It can pick a menu or a cookie notice.");
  pageIssue("results", 2, pages.filter((p) => !p.title || isPlaceholderTitle(p.title)), N, (n) => `${pl(n, "page has", "pages have")} no title or a placeholder title.`,
    "pages have no real title", "The title is the headline in search results. Without a real one, Google writes it.");
  pageIssue("results", 1, pages.filter((p) => p.title.length > 60), N, (n) => `${pl(n, "title is", "titles are")} cut off in search results.`,
    "titles are cut off in search results", "Visitors read a headline that ends mid-sentence.");
  const tc = new Map<string, number>();
  for (const p of pages) if (p.title) tc.set(p.title.toLowerCase(), (tc.get(p.title.toLowerCase()) ?? 0) + 1);
  pageIssue("results", 1, pages.filter((p) => p.title && (tc.get(p.title.toLowerCase()) ?? 0) > 1), N, (n) => `${pl(n, "page shares", "pages share")} a title with another page.`,
    "pages share a title with another page", "Search engines struggle to tell them apart and may list only one.");
  pageIssue("results", 1, pages.filter((p) => !p.ogImage), N, (n) => `${pl(n, "page shows", "pages show")} no preview image when shared on LinkedIn or WhatsApp.`,
    "pages show no preview image when shared", "Shared links appear as a bare address, and fewer people click them.");
  pageIssue("results", 2, pages.filter((p) => p.lorem), N, (n) => `${pl(n, "page still contains", "pages still contain")} placeholder text (lorem ipsum).`,
    "pages still contain placeholder text", "Visitors and search engines read it as an unfinished site.");

  // ---- Clarity
  pageIssue("clarity", 2, pages.filter((p) => !p.ld), N, (n) => `${pl(n, "page has", "pages have")} no schema labels.`,
    "pages carry no labels for search engines", "Search engines and AI assistants have to guess what each page is about.");
  pageIssue("clarity", 2, pages.filter((p) => p.ldBad), N, (n) => `${pl(n, "page has", "pages have")} schema labels with errors.`,
    "pages have labels that cannot be read", "Search engines ignore labels they cannot read, so the work of adding them is lost.");
  pageIssue("clarity", 1, pages.filter((p) => p.ldThin), N, (n) => `${pl(n, "article has", "articles have")} labels without headline, author or date.`,
    "articles have incomplete labels", "Labels without the key details give AI assistants little to quote.");
  pageIssue("clarity", 2, pages.filter((p) => p.h1 === 0), N, (n) => `${pl(n, "page has", "pages have")} no main heading.`,
    "pages have no main heading", "The main heading tells search engines and AI assistants what the page is about.");
  pageIssue("clarity", 1, pages.filter((p) => p.h1 > 1), N, (n) => `${pl(n, "page has", "pages have")} more than one main heading.`,
    "pages have more than one main heading", "With several, the topic of the page is less clear.");
  pageIssue("clarity", 1, pages.filter((p) => p.skips > 0), N, (n) => `${pl(n, "page skips", "pages skip")} heading levels.`,
    "pages skip heading levels", "AI assistants and screen readers follow headings like a table of contents. Gaps break the outline.");
  const noAltImgs = pages.reduce((a, p) => a + p.noAlt, 0);
  const allImgs = pages.reduce((a, p) => a + p.imgs, 0);
  if (noAltImgs) {
    const share = noAltImgs / Math.max(allImgs, 1);
    issues.push({ area: "clarity", level: share >= 0.25 && noAltImgs >= 5 ? "review" : share >= 0.05 ? "review" : "note", sev: 1, share,
      stat: `${noAltImgs.toLocaleString("en-US")} of ${allImgs.toLocaleString("en-US")}`, caption: "images have no description (alt text)",
      text: `${pl(noAltImgs, "image has", "images have")} no description (alt text).`, why: "Search engines and AI assistants cannot see images. The description is all they read." });
  }
  pageIssue("clarity", 1, pages.filter((p) => !p.lang), N, (n) => `${pl(n, "page does", "pages do")} not declare ${n === 1 ? "its" : "their"} language.`,
    "pages do not declare their language", "Search engines have to guess, and a wrong guess sends the page to the wrong audience.");

  // ---- Phone
  pageIssue("phone", 2, pages.filter((p) => !p.viewport), N, (n) => `${pl(n, "page has", "pages have")} no phone layout setting.`,
    "pages have no phone layout setting", "Phones show the page at desktop width and visitors have to zoom. Google reads the phone version first.");
  const heavyMap = new Map<string, number>();
  for (const p of pages) for (const [s, b] of p.heavy) heavyMap.set(s, b);
  if (heavyMap.size) {
    const max = Math.max(...heavyMap.values());
    const level: IssueLevel = heavyMap.size >= 10 || max > 1_500_000 ? "review" : "note";
    issues.push({ area: "phone", level, sev: 1, share: Math.min(1, heavyMap.size / 20), stat: String(heavyMap.size), caption: "images are over 300 KB",
      text: `${pl(heavyMap.size, "image is", "images are")} over 300 KB. The largest is ${(max / 1_000_000).toFixed(1)} MB.`,
      why: "Large images slow the page on a phone. Visitors wait for it to appear." });
  }
  pageIssue("phone", 2, pages.filter((p) => p.ttfb >= 1.8), N, (n) => `${pl(n, "page took", "pages took")} over 1.8 seconds to start responding.`,
    "pages take over 1.8 seconds to start", "Visitors on a phone wait before anything appears. Many leave a page that stays blank.");
  pageIssue("phone", 1, pages.filter((p) => p.blocking >= 3), N, (n) => `${pl(n, "page loads", "pages load")} 3 or more scripts before it appears.`,
    "pages load scripts before they appear", "Visitors look at a blank screen while the scripts download.");
  pageIssue("phone", 1, pages.filter((p) => p.bytes > 250_000), N, (n) => `${pl(n, "page has", "pages have")} heavy HTML (over 250 KB).`,
    "pages have heavy HTML", "Heavy pages take longer to load on a mobile connection.");
  pageIssue("phone", 1, pages.filter((p) => p.noDims >= 3), N, (n) => `${pl(n, "page has", "pages have")} images without width and height.`,
    "pages have images without set size", "The page jumps as images load, and visitors tap the wrong thing.");

  // ---- AI access
  const nb = site.robots.aiBlocked.length;
  if (nb) siteIssue("ai", nb >= 4 ? "risk" : "review", `robots.txt tells ${nb} of 7 main AI crawlers to stay out: ${site.robots.aiBlocked.join(", ")}.`,
    "Content they cannot read cannot be quoted in their answers. If this is a choice, confirm it. If not, it is a leftover.", `${nb} of 7`, "main AI crawlers are told to stay out");
  if (site.aiRefused.length) siteIssue("ai", "review", `The server turned away requests that identify as ${site.aiRefused.join(", ")}.`,
    "Even where robots.txt allows them, a firewall can block AI assistants. Real crawlers may be treated differently, so this needs a closer look.",
    `${site.aiRefused.length} of 2`, "AI crawlers are turned away by your server");
  pageIssue("ai", 2, pages.filter((p) => p.words < 150 && !p.noindex), N, (n) => `${pl(n, "page holds", "pages hold")} almost no text in its HTML.`,
    "pages hold almost no text in their HTML", "Many AI crawlers do not run scripts. Text that scripts add later may never reach them.");
  pageIssue("ai", 1, pages.filter((p) => p.navBad), N, (n) => `${pl(n, "page has", "pages have")} menu items that are not real links.`,
    "pages have menu items that are not real links", "Crawlers follow links, not clicks. They may never reach the pages behind those items.");

  // ---- Trust
  const arts = pages.filter((p) => p.article);
  pageIssue("trust", 1, arts.filter((p) => !p.author), arts.length, (n) => `${pl(n, "article shows", "articles show")} no author.`,
    "articles show no author", "AI assistants weigh who wrote a page. Yours do not say.");
  pageIssue("trust", 1, arts.filter((p) => !p.date), arts.length, (n) => `${pl(n, "article shows", "articles show")} no date.`,
    "articles show no date", "Readers and AI assistants cannot tell whether the content is current.");
  if (!site.home.org) siteIssue("trust", "review", "The home page does not label who the business is.",
    "AI assistants answer who a company is from labels like these. Without them, they rely on guesses.", "No", "organization labels on the home page");
  else if (!site.home.sameAs) siteIssue("trust", "review", "The organization labels have no links to your profiles (LinkedIn and others).",
    "Profile links let search engines and AI assistants confirm that the business is real.", "No", "profile links in your labels");
  if (!site.home.contact) siteIssue("trust", "review", "No phone number or email appears as a link on the home page.",
    "Visitors and AI assistants look for a way to reach you before they trust you.", "No", "contact link on the home page");

  // ---- Assemble
  const rank = { risk: 2, review: 1, note: 0 };
  const areas: AreaResult[] = AREAS.map((a) => {
    const mine = issues.filter((i) => i.area === a.id).sort((x, y) => rank[y.level] - rank[x.level] || y.sev - x.sev || y.share - x.share);
    const level: Level = mine.some((i) => i.level === "risk") ? "risk" : mine.some((i) => i.level === "review") ? "review" : "good";
    const top = mine[0];
    if (level === "good") {
      const g = goodState(a.id, site, N, arts.length, nb);
      return { ...a, level, ...g, items: [...mine.map((i) => i.text), ...g.oks].slice(0, 4) };
    }
    return { ...a, level, stat: top.stat, caption: top.caption, line: top.why, items: mine.slice(0, 4).map((i) => i.text) };
  });

  const risk = areas.filter((a) => a.level === "risk").length;
  const review = areas.filter((a) => a.level === "review").length;
  const attn = risk + review;
  const total = Math.max(known, all.length);
  const capped = total > all.length && all.length >= CAP;
  return {
    host: site.host, date, checked: all.length, total, capped,
    headline: attn ? `${attn} of 6 areas need attention.` : "No area needs attention.",
    sub: `We checked ${capped ? `${all.length} of ${total.toLocaleString("en-US")}` : pl(all.length, "page", "pages")}${capped ? " pages" : ""} on ${site.host}. ` +
      (risk ? `${cap1(pl(risk, "area puts", "areas put"))} you at risk of not being found.` : review ? "Nothing is critical, but there is room to improve." : "The basics are in place."),
    areas: areas.sort((x, y) => x.n.localeCompare(y.n)),
  };
}

function goodState(id: string, site: SiteInfo, N: number, arts: number, nb: number) {
  const n = N.toLocaleString("en-US");
  switch (id) {
    case "listed": return { stat: `${n} of ${n}`, caption: "pages are listed and reachable", line: "Your pages can be found and reached.",
      oks: [site.sitemap.found ? `The sitemap lists ${pl(site.sitemap.count, "address", "addresses")}.` : "", "No page tells search engines to skip it."].filter(Boolean) };
    case "results": return { stat: `${n} of ${n}`, caption: "pages have a title and a description", line: "Search results show what you chose to show.", oks: ["Titles and descriptions are in place."] };
    case "clarity": return { stat: `${n} of ${n}`, caption: "pages are clearly labelled", line: "Search engines and AI assistants can tell what each page is about.", oks: ["Headings and labels are in place."] };
    case "phone": return { stat: `${n} of ${n}`, caption: "pages are set up for phones", line: "Pages are set up for phones and load without heavy images.", oks: ["No image we measured is over 300 KB."] };
    case "ai": return { stat: `${7 - nb} of 7`, caption: "main AI crawlers can read the site", line: "AI assistants can read your pages.",
      oks: ["No AI crawler is blocked in robots.txt.", site.llms ? "An llms.txt file is in place." : "There is no llms.txt file. It is optional."] };
    default: return { stat: arts ? `${arts} of ${arts}` : "Yes", caption: arts ? "articles show an author and a date" : "the home page says who you are", line: "Visitors and AI assistants can tell who is behind the site.", oks: ["The business is labelled on the home page."] };
  }
}
