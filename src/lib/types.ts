// Shapes shared by the API routes and the browser script.

export type Level = "good" | "review" | "risk";

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
  section: string;
  inSitemap: boolean;
  title: string;
  desc: string;
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

export interface AreaResult {
  id: string;
  n: string;
  name: string;
  question: string;
  level: Level;
  stat: string;
  caption: string;
  line: string;
  items: string[];
}

export interface Report {
  host: string;
  date: string;
  checked: number;
  total: number;
  capped: boolean;
  headline: string;
  sub: string;
  areas: AreaResult[]; // in the fixed order 01 to 06
}
