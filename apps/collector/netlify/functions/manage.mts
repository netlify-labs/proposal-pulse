import type { Config, Context } from "@netlify/functions";
import {
  env,
  forgetSite,
  getMe,
  hostOf,
  json,
  ownUrl,
  pulseTeams,
  readManageRequest,
  resolveSite,
  slackMode,
  trackSite,
  untrackSite,
} from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/**
 * Admin calls from the dashboard, signed with HOOK_SECRET (see signManageRequest).
 * The collector is the only writer to the database and the only holder of NETLIFY_TOKEN;
 * the dashboard reads the database with a read-only role and asks here for changes.
 */
export default async (req: Request, context: Context) => {
  const secret = env("HOOK_SECRET");
  if (!secret) return json({ error: "HOOK_SECRET is not set" }, 503);
  const r = readManageRequest(await req.text(), req.headers.get("x-pulse-signature") || "", secret);
  if (!r) return json({ error: "bad signature or expired request" }, 401);
  const collectorUrl = ownUrl() || context.site?.url || "";

  try {
    if (r.op === "status") {
      let me = null;
      let tokenError = "";
      try {
        const u = await getMe();
        me = { name: u.full_name, email: u.email };
      } catch (e: any) {
        tokenError = String(e?.message || e);
      }
      return json({ me, tokenError, teams: pulseTeams(), slack: slackMode(), dashboardUrl: env("DASHBOARD_URL") });
    }

    if (r.op === "track") {
      // A person asked for these projects, so this also re-tracks projects that were untracked.
      const teams = pulseTeams();
      const ownHosts = [hostOf(collectorUrl), hostOf(env("DASHBOARD_URL"))].filter(Boolean);
      const results = [];
      for (const ref of (r.refs || []).slice(0, 50)) {
        try {
          const site = await resolveSite(ref);
          if (!teams.includes(site.team)) throw new Error(`${site.name} is in team ${site.team}, which is not in PULSE_TEAMS`);
          if (site.id === context.site?.id || site.hosts.some((h) => ownHosts.includes(h))) throw new Error(`${site.name} is part of Proposal Pulse`);
          await trackSite(db, site, collectorUrl, "dashboard");
          results.push({ ref, ok: true, id: site.id, name: site.name });
        } catch (e: any) {
          results.push({ ref, ok: false, error: String(e?.message || e) });
        }
      }
      return json({ results });
    }

    const results = [];
    for (const id of (r.ids || []).slice(0, 200)) {
      try {
        if (r.op === "untrack") await untrackSite(db, id);
        else await forgetSite(db, id);
        results.push({ id, ok: true });
      } catch (e: any) {
        results.push({ id, ok: false, error: String(e?.message || e) });
      }
    }
    return json({ results });
  } catch (e: any) {
    console.error("manage failed", r.op, e);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/manage", method: "POST" };
