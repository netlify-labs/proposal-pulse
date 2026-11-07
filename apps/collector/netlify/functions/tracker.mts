import type { Config, Context } from "@netlify/functions";
import { BOT_UA, geoFrom, privacySignal, refererPage, trackedSiteForHost } from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";
import { recordServerVisit } from "../../lib/visits.mts";

/**
 * Serves the tracker at /t.js (the script itself is public/tracker.js).
 *
 * Browsers that send Global Privacy Control or Do Not Track don't run the tracker, so for them
 * the visit is recorded here, as the script loads: the tracked site from the Referer header,
 * location from context.geo and device from the user agent. Other browsers are left to t.js,
 * so no visit is recorded twice.
 */

let source: { at: number; body: string } | undefined;

async function trackerSource(req: Request) {
  if (source && Date.now() - source.at < 60_000) return source.body;
  const res = await fetch(new URL("/tracker.js", req.url));
  if (!res.ok) throw new Error(`tracker.js returned ${res.status}`);
  source = { at: Date.now(), body: await res.text() };
  return source.body;
}

async function recordLoad(req: Request, context: Context, signal: "gpc" | "dnt") {
  const ua = req.headers.get("user-agent") || "";
  if (BOT_UA.test(ua)) return;
  const page = refererPage(req.headers.get("referer"));
  if (!page) return; // the page sent no Referer, so there's no way to tell which site it was
  const site = await trackedSiteForHost(db, page.host);
  if (!site) return;
  await recordServerVisit(db, { host: site.host, path: page.path }, ua, geoFrom(context.geo), Date.now(), signal);
}

export default async (req: Request, context: Context) => {
  const signal = privacySignal(req.headers);
  if (signal) context.waitUntil(recordLoad(req, context, signal).catch((e) => console.error("server visit failed", e)));
  let body: string;
  try {
    body = await trackerSource(req);
  } catch (e) {
    console.error("tracker source failed", e);
    return new Response("/* Proposal Pulse tracker unavailable */", { status: 503, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      // browsers may keep it 5 minutes; Netlify's CDN must not, or loads would skip this function
      "cache-control": "private, max-age=300",
      "netlify-cdn-cache-control": "no-store",
    },
  });
};

export const config: Config = { path: "/t.js", method: ["GET"] };
