import type { Config, Context } from "@netlify/functions";
import {
  BOT_UA,
  deepAlert,
  env,
  isValidEvent,
  openAlert,
  postSlack,
  trackedSiteForHost,
  type AlertType,
  type BeaconEvent,
  type Session,
} from "../../../../packages/core/src/index.mts";
import { db, pool } from "../../lib/db.mts";
import { claimAlert, recordBeacon, type Pool } from "../../lib/visits.mts";

/** Beacon endpoint for t.js. Public, cookieless, accepts events only for tracked projects. */

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const done = (status = 204) => new Response(null, { status, headers: cors });

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return done();
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const ua = req.headers.get("user-agent") || "";
  if (BOT_UA.test(ua)) return done();

  let ev: BeaconEvent;
  try {
    ev = JSON.parse(await req.text());
  } catch {
    return done(400);
  }
  if (!isValidEvent(ev)) return done(400);

  const site = await trackedSiteForHost(db, ev.h);
  if (!site) return done(); // not a tracked project: drop silently
  ev.h = site.host; // custom domains and aliases map to one canonical host

  const geo = {
    city: context.geo?.city,
    country: context.geo?.country?.name,
    cc: context.geo?.country?.code,
    tz: context.geo?.timezone,
    lat: context.geo?.latitude,
    lon: context.geo?.longitude,
  };
  try {
    const { session, pending } = await recordBeacon(pool as unknown as Pool, ev, ua, geo, Date.now());
    if (pending.length) context.waitUntil(sendAlerts(session, pending).catch((e) => console.error("alert failed", e)));
  } catch (e) {
    console.error("collect failed", e);
    return done(500);
  }
  return done();
};

async function sendAlerts(s: Session, types: AlertType[]) {
  const dashboard = env("DASHBOARD_URL");
  for (const type of types) {
    if (!(await claimAlert(db, s.sid, type))) continue;
    const text =
      type === "open" ? openAlert(s, dashboard) : deepAlert(s, dashboard);
    await postSlack(text);
  }
}

export const config: Config = {
  path: "/api/t",
  method: ["POST", "OPTIONS"],
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 200 },
};
