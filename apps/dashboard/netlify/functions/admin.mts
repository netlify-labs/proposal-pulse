import type { Config } from "@netlify/functions";
import {
  ORG_HOOK_EVENTS,
  authed,
  createOrgHook,
  env,
  forgetSite,
  getMe,
  json,
  listSiteRecords,
  postSlack,
  pulseTeams,
  slackMode,
  stripSlash,
  testAlert,
  untrackSite,
} from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/** Setup and admin operations for the dashboard: GET/POST /api/admin?op=... */
export default async (req: Request) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "status";
  const dashboard = stripSlash(env("DASHBOARD_URL") || url.origin);
  const collector = stripSlash(env("COLLECTOR_URL"));
  const post = req.method === "POST";

  try {
    if (op === "status") {
      let me = null;
      let tokenError = "";
      if (env("NETLIFY_TOKEN")) {
        try {
          me = await getMe();
        } catch (e: any) {
          tokenError = String(e?.message || e);
        }
      }
      let dbError = "";
      let counts: Record<string, number> = {};
      try {
        const { rows } = await db().query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM sites GROUP BY status");
        counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      } catch (e: any) {
        dbError = String(e?.message || e);
      }
      return json({
        dashboard,
        collector,
        teams: pulseTeams(),
        slack: slackMode(),
        token: !!env("NETLIFY_TOKEN"),
        tokenError,
        me: me && { name: me.full_name, email: me.email },
        db: !dbError,
        dbError,
        trackedCount: counts.tracked || 0,
        excludedCount: counts.excluded || 0,
      });
    }

    if (op === "sites") {
      // tracked and untracked projects; `ignored` (other teams) is internal bookkeeping
      const all = await listSiteRecords(db());
      return json({ sites: all.filter((s) => s.status !== "ignored") });
    }

    if (op === "hook-status") {
      const [recent, summary, subs] = await Promise.all([
        db().query("SELECT received_at, event, site_id, site_name, team, outcome, detail FROM hook_events ORDER BY received_at DESC LIMIT 25"),
        db().query<{ outcome: string; n: number }>(
          "SELECT outcome, count(*)::int AS n FROM hook_events WHERE received_at > now() - interval '24 hours' GROUP BY outcome",
        ),
        db().query("SELECT value FROM settings WHERE key = 'org_hooks'"),
      ]);
      return json({
        secret: !!env("HOOK_SECRET"),
        endpoint: collector ? `${collector}/hooks/netlify-site` : "",
        recent: recent.rows.map((r: any) => ({ ...r, at: new Date(r.received_at).getTime() })),
        last24h: Object.fromEntries(summary.rows.map((r) => [r.outcome, r.n])),
        subs: subs.rows[0]?.value || null,
      });
    }

    if (op === "hook-subscribe" && post) {
      const { orgId } = (await req.json()) as { orgId?: string };
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(orgId || "")) return json({ error: "Enter a valid organization ID" }, 400);
      const secret = env("HOOK_SECRET");
      if (!secret || !collector) return json({ error: "HOOK_SECRET and COLLECTOR_URL must be set on the dashboard" }, 500);
      // Org webhooks need an Organization Owner's token; use it if one was provided for this step.
      const tokenVar = env("NETLIFY_ORG_OWNER_TOKEN") ? "NETLIFY_ORG_OWNER_TOKEN" : "NETLIFY_TOKEN";
      const results = [];
      for (const event of ORG_HOOK_EVENTS) {
        try {
          const r = await createOrgHook(orgId!, event, `${collector}/hooks/netlify-site`, secret, tokenVar);
          results.push({ event, ok: true, id: r?.id, via: tokenVar });
        } catch (e: any) {
          results.push({ event, ok: false, via: tokenVar, error: String(e?.message || e).replaceAll(secret, "***") });
        }
      }
      if (results.some((r) => r.ok)) {
        await db().query(
          `INSERT INTO settings (key, value, updated_at) VALUES ('org_hooks', $1, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [JSON.stringify({ orgId, at: Date.now(), results })],
        );
      }
      return json({ results });
    }

    if (op === "test-alert" && post) return json(await postSlack(testAlert(dashboard)));

    if ((op === "untrack" || op === "forget") && post) {
      const { ids } = (await req.json()) as { ids?: string[] };
      if (!Array.isArray(ids) || !ids.length) return json({ error: "no ids" }, 400);
      const results = [];
      for (const id of ids.slice(0, 200)) {
        try {
          if (op === "untrack") await untrackSite(db(), id);
          else await forgetSite(db(), id);
          results.push({ id, ok: true });
        } catch (e: any) {
          results.push({ id, ok: false, error: String(e?.message || e) });
        }
      }
      return json({ results });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e: any) {
    console.error("admin failed", op, e);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/admin", method: ["GET", "POST"] };
