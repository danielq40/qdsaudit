import type { APIRoute } from "astro";
import { FetchError } from "../../lib/audit";
import { checkPages } from "../../lib/crawl";

export const prerender = false;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST: APIRoute = async ({ request }) => {
  let body: { origin?: string; urls?: string[] } = {};
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  if (!body.origin || !Array.isArray(body.urls)) return json({ error: "Bad request." }, 400);
  try {
    return json({ pages: await checkPages(body.origin, body.urls.map(String), import.meta.env.DEV) });
  } catch (e) {
    if (e instanceof FetchError) return json({ error: e.message }, 422);
    console.error(e);
    return json({ error: "Something went wrong on our side." }, 500);
  }
};
