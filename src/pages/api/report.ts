import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildReport } from "../../lib/report";
import type { Contact, LinkCheck } from "../../lib/types";

export const prerender = false;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Set BOOK_URL, QUOTE_URL and CONTACT_EMAIL as environment variables in Webflow Cloud. Until then the report shows placeholders.
function contact(): Contact {
  const e = env as unknown as Record<string, string | undefined>;
  return { bookUrl: e.BOOK_URL ?? "", quoteUrl: e.QUOTE_URL ?? "", email: e.CONTACT_EMAIL ?? "" };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const b: any = await request.json();
    if (!b?.site?.host || !Array.isArray(b.pages)) return json({ error: "Bad request." }, 400);
    const link: LinkCheck = {
      links: Number(b.link?.links) || 0,
      pages: Number(b.link?.pages) || 0,
      examples: Array.isArray(b.link?.examples) ? b.link.examples.slice(0, 3).map((x: string[]) => [String(x[0]), String(x[1])]) : [],
    };
    return json(buildReport(b.site, b.pages.slice(0, 1200), Number(b.known) || 0, new Date().toISOString().slice(0, 10), link, contact()));
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong on our side." }, 500);
  }
};
