import type { APIRoute } from "astro";
import { buildReport } from "../../lib/report";

export const prerender = false;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST: APIRoute = async ({ request }) => {
  try {
    const b: any = await request.json();
    if (!b?.site?.host || !Array.isArray(b.pages)) return json({ error: "Bad request." }, 400);
    return json(buildReport(b.site, b.pages.slice(0, 200), Number(b.known) || 0, new Date().toISOString().slice(0, 10)));
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong on our side." }, 500);
  }
};
