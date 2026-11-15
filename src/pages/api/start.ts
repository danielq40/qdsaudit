import type { APIRoute } from "astro";
import { FetchError } from "../../lib/audit";
import { start } from "../../lib/crawl";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST: APIRoute = async ({ request }) => {
  let body: { url?: string; email?: string } = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const email = (body.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Enter a valid work email." }, 400);
  try {
    const res = await start(body.url ?? "", import.meta.env.DEV);
    const hook = (env as unknown as Record<string, string | undefined>).LEAD_WEBHOOK_URL;
    if (hook) fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, site: res.site.host, at: new Date().toISOString() }) }).catch(() => {});
    return json(res);
  } catch (e) {
    if (e instanceof FetchError) return json({ error: e.message }, 422);
    console.error(e);
    return json({ error: "Something went wrong on our side. Try again." }, 500);
  }
};
