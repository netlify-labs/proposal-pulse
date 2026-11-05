import { env } from "./env.mts";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function same(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Dashboard API guard. The dashboard project sits behind Netlify team login, which already
 * covers every route. DASHBOARD_PASSWORD adds an optional in-app password on top.
 */
export function authed(req: Request) {
  const pw = env("DASHBOARD_PASSWORD");
  if (!pw) return true;
  return same(req.headers.get("x-pulse-key") || "", pw);
}
