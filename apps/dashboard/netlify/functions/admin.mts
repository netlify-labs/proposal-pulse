import type { Config } from "@netlify/functions";
import { authed, env, json, listSiteRecords, signManageRequest, stripSlash, type ManageRequest } from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/**
 * Setup and admin operations for the dashboard: GET/POST /api/admin?op=...
 * Reads come straight from the database (read-only role). Changes (untrack, forget) and the
 * collector's own health are requested from the collector with a request signed by HOOK_SECRET.
 */
async function collector(req: Omit<ManageRequest, "ts">) {
  const base = stripSlash(env("COLLECTOR_URL"));
  const secret = env("HOOK_SECRET");
  if (!base || !secret) throw new Error("COLLECTOR_URL and HOOK_SECRET must be set on the dashboard");
  const { body, signature } = signManageRequest(req, secret);
  const res = await fetch(`${base}/api/manage`, { method: "POST", headers: { "content-type": "application/json", "x-pulse-signature": signature }, body });
  const out = await res.json().catch(() => ({ error: `collector returned ${res.status}` }));
  if (!res.ok) throw new Error(out.error || `collector returned ${res.status}`);
  return out;
}

export default async (req: Request) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const op = new URL(req.url).searchParams.get("op") || "status";
  const post = req.method === "POST";

  try {
    if (op === "status") {
      let dbError = "";
      let counts: Record<string, number> = {};
      try {
        const { rows } = await db().query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM sites GROUP BY status");
        counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      } catch (e: any) {
        dbError = String(e?.message || e);
      }
      let col: any = null;
      let collectorError = "";
      try {
        col = await collector({ op: "status" });
      } catch (e: any) {
        collectorError = String(e?.message || e);
      }
      return json({
        db: !dbError,
        dbError,
        trackedCount: counts.tracked || 0,
        excludedCount: counts.excluded || 0,
        collectorUrl: stripSlash(env("COLLECTOR_URL")),
        collector: !collectorError,
        collectorError,
        me: col?.me || null,
        tokenError: col?.tokenError || "",
        teams: col?.teams || [],
        slack: col?.slack || "none",
      });
    }

    if (op === "sites") {
      // tracked and untracked projects; `ignored` (other teams) is internal bookkeeping
      const all = await listSiteRecords(db());
      return json({ sites: all.filter((s) => s.status !== "ignored") });
    }

    if (op === "hook-status") {
      const [recent, summary] = await Promise.all([
        db().query("SELECT received_at, event, site_id, site_name, team, outcome, detail FROM hook_events ORDER BY received_at DESC LIMIT 25"),
        db().query<{ outcome: string; n: number }>(
          "SELECT outcome, count(*)::int AS n FROM hook_events WHERE received_at > now() - interval '24 hours' GROUP BY outcome",
        ),
      ]);
      return json({
        recent: recent.rows.map((r: any) => ({ ...r, at: new Date(r.received_at).getTime() })),
        last24h: Object.fromEntries(summary.rows.map((r) => [r.outcome, r.n])),
      });
    }

    if (op === "candidates") return json(await collector({ op: "candidates" }));

    if (op === "track" && post) {
      const { refs } = (await req.json()) as { refs?: string[] };
      const list = (refs || []).map((r) => String(r).trim()).filter(Boolean);
      if (!list.length) return json({ error: "Enter a project name or URL" }, 400);
      return json(await collector({ op: "track", refs: list.slice(0, 50) }));
    }

    if (op === "delete-visits" && post) {
      const { ids } = (await req.json()) as { ids?: string[] };
      if (!Array.isArray(ids) || !ids.length) return json({ error: "no visits" }, 400);
      return json(await collector({ op: "delete-visits", ids: ids.slice(0, 500) }));
    }

    if ((op === "untrack" || op === "forget") && post) {
      const { ids } = (await req.json()) as { ids?: string[] };
      if (!Array.isArray(ids) || !ids.length) return json({ error: "no ids" }, 400);
      return json(await collector({ op, ids: ids.slice(0, 200) }));
    }

    return json({ error: "unknown op" }, 400);
  } catch (e: any) {
    console.error("admin failed", op, e);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/admin", method: ["GET", "POST"] };
