// Shapes shared by the API routes and the browser script.

export type Level = "good" | "almost" | "review" | "risk";

export interface SiteInfo {
  host: string;
  origin: string;
  finalUrl: string;
  https: boolean;
  webflow: boolean;
  httpRedirects: boolean | null; // http:// opens https://
  alt: { host: string; state: "ok" | "split" | "down" } | null; // www / non-www twin
  soft404: boolean | null;
  robots: { found: boolean; blocksAll: boolean; aiBlocked: string[] };
  aiRefused: string[];
  sitemap: { found: boolean; count: number; staging: number };
  llms: boolean;
  home: { org: boolean; sameAs: boolean; contact: boolean };
}

export interface StartResponse {
  site: SiteInfo;
  seeds: string[]; // pages to check first, at most the cap
  sitemapUrls: string[]; // every address in the sitemap, normalized
  known: number; // pages known so far (sitemap plus home page links)
}

export interface PageRec {
  url: string;
  final: string;
  status: number; // 0 = could not load
  html: boolean;
  redirected: boolean;
  hops: number;
  section: string;
  inSitemap: boolean;
  title: string;
  descLen: number;
  h1: number;
  skips: number;
  noindex: boolean;
  canonicalOther: boolean;
  ogImage: boolean;
  imgs: number;
  noAlt: number;
  noDims: number;
  heavy: [string, number][]; // images over 300 KB: [src, bytes]
  ld: number;
  ldBad: number;
  ldThin: boolean;
  article: boolean;
  author: boolean;
  date: boolean;
  words: number;
  viewport: boolean;
  lang: boolean;
  blocking: number;
  bytes: number;
  ttfb: number;
  navBad: boolean;
  staging: boolean;
  lorem: boolean;
  links: string[]; // internal pages this page links to
}

export interface CheckRow {
  name: string; // plain-language title
  why: string; // plain-language consequence
  tech: string; // one technical line
  pct: string; // "41%", "<1%" or "Site-wide"
  share: number; // 0 to 1, for the bar
  of: string; // "46 of 112 pages", empty for site-wide checks
  level: "risk" | "review";
  examples: string[];
}

export interface AreaResult {
  id: string;
  n: string;
  question: string; // what a visitor would ask
  short: string;
  level: Level;
  score: number; // percent, from every check of the area
  summary: string;
  checks: CheckRow[];
  oks: string[];
}

export interface Contact {
  bookUrl: string;
  quoteUrl: string;
  email: string;
}

export interface LinkCheck {
  links: number; // broken internal links
  pages: number; // pages that hold at least one
  examples: [string, string][]; // [from, to]
}

export interface Report {
  host: string;
  date: string;
  checked: number;
  total: number;
  capped: boolean;
  headline: string;
  sub: string;
  areas: AreaResult[]; // fixed order 01 to 05
  notes: string[];
  contact: Contact;
}
