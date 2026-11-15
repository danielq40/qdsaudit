import type { APIRoute } from "astro";
import { runAudit, FetchError } from "../lib/audit";
import { formPage, render } from "../lib/report";

export const prerender = false;

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export const GET: APIRoute = async ({ url }) => {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  const target = (url.searchParams.get("url") ?? "").trim();
  if (!target) return html(formPage(`${base}/audit`, "Enter a web address."), 400);
  try {
    // Private addresses are allowed only in local development.
    return html(render(await runAudit(target, import.meta.env.DEV)));
  } catch (err) {
    if (err instanceof FetchError) return html(formPage(`${base}/audit`, err.message), 502);
    console.error(err);
    return html(formPage(`${base}/audit`, "Something went wrong on our side. Try again."), 500);
  }
};
