import type { APIRoute } from "astro";
import { formPage } from "../lib/report";

export const prerender = false;

export const GET: APIRoute = () => {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return new Response(formPage(`${base}/audit`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
