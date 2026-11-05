import type { Config, Context } from "@netlify/functions";
import {
  NetlifyApiError,
  env,
  getSite,
  getSiteRecord,
  hostOf,
  isSiteId,
  ownUrl,
  pulseTeams,
  readOrgHook,
  refreshTrackedSite,
  trackSite,
  upsertSite,
  verifyNetlifySignature,
} from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/**
 * Receiver for Netlify organization webhooks (site_created, site_published).
 *
 * Verifies the signature, then injects the tracker into new projects in PULSE_TEAMS right away.
 * Org webhooks fire for every team in the organization, so most events are for other teams:
 * those are cached as `ignored` and skipped cheaply next time.
 *
 * After a valid signature it always answers 202, even when the work fails. Netlify disables a
 * webhook after repeated failed deliveries; failures are recorded in hook_events instead and
 * shown on the dashboard, where the project can be tracked by hand.
 */
export default async (req: Request, context: Context) => {
  const secret = env("HOOK_SECRET");
  if (!secret) return new Response("HOOK_SECRET is not set", { status: 503 });
  const body = await req.text();
  if (!verifyNetlifySignature(req.headers.get("x-webhook-signature") || "", body, secret)) {
    return new Response("bad signature", { status: 401 });
  }

  const event = req.headers.get("x-netlify-event") || "unknown";
  let hook = { siteId: "", name: "", team: "" };
  let outcome = "error";
  let detail = "";
  try {
    hook = readOrgHook(JSON.parse(body));
    [outcome, detail] = await handle(hook, event, context);
  } catch (e: any) {
    detail = String(e?.message || e).slice(0, 300);
    console.error("site-hook failed", hook.siteId, e);
  }
  await db
    .query("INSERT INTO hook_events (event, site_id, site_name, team, outcome, detail) VALUES ($1, $2, $3, $4, $5, $6)", [
      event,
      hook.siteId || null,
      hook.name || null,
      hook.team || null,
      outcome,
      detail || null,
    ])
    .catch((e) => console.error("hook_events insert failed", e));
  return new Response(outcome, { status: 202 });
};

async function handle(hook: { siteId: string; name: string; team: string }, event: string, context: Context): Promise<[string, string]> {
  if (!isSiteId(hook.siteId)) return ["skipped", "no project id in payload"];
  const teams = pulseTeams();
  if (!teams.length) return ["skipped", "PULSE_TEAMS is not set"];

  // Already decided: tracked, untracked by a person, or outside our teams.
  const known = await getSiteRecord(db, hook.siteId);
  if (known?.status === "tracked" && event === "site_published") {
    // keep the thumbnail, creator, name and domains current; the snippet is already there
    await refreshTrackedSite(db, await getSite(hook.siteId));
    return ["refreshed", known.name];
  }
  if (known) return ["skipped", `already ${known.status}`];

  // site_created carries the team; skip other teams without an API call.
  if (hook.team && !teams.includes(hook.team)) {
    await upsertSite(db, { id: hook.siteId, name: hook.name, team: hook.team, url: "", host: "", hosts: [] }, "ignored");
    return ["ignored", `team ${hook.team}`];
  }

  // site_published has no team slug, so look the project up.
  let site;
  try {
    site = await getSite(hook.siteId);
  } catch (e) {
    if (e instanceof NetlifyApiError && [401, 403, 404].includes(e.status)) {
      await upsertSite(db, { id: hook.siteId, name: hook.name, team: hook.team, url: "", host: "", hosts: [] }, "ignored");
      return ["ignored", `token cannot read project (${e.status})`];
    }
    throw e;
  }
  if (!teams.includes(site.team)) {
    await upsertSite(db, site, "ignored");
    return ["ignored", `team ${site.team}`];
  }

  // Never inject into Proposal Pulse itself.
  const collectorUrl = ownUrl() || context.site?.url || "";
  const ownHosts = [hostOf(collectorUrl), hostOf(env("DASHBOARD_URL"))].filter(Boolean);
  if (site.id === context.site?.id || site.hosts.some((h) => ownHosts.includes(h))) {
    await upsertSite(db, site, "ignored");
    return ["ignored", "Proposal Pulse project"];
  }

  await trackSite(db, site, collectorUrl, "webhook");
  return ["tracked", site.name];
}

export const config: Config = { path: "/hooks/netlify-site", method: "POST" };
