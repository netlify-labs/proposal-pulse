import type { Config } from "@netlify/functions";
import { authed, json, listSiteRecords, type Session } from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/** Visits in the selected window plus the tracked projects. Feeds every dashboard tab. */
export default async (req: Request) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
  try {
    const [{ rows }, tracked] = await Promise.all([
      db().query<{ data: Session }>(
        "SELECT data FROM sessions WHERE last_at >= now() - $1::interval ORDER BY last_at DESC LIMIT 5000",
        [`${days} days`],
      ),
      listSiteRecords(db(), "tracked"),
    ]);
    return json({ now: Date.now(), days, sessions: rows.map((r) => r.data), tracked });
  } catch (e: any) {
    console.error("data failed", e);
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config: Config = { path: "/api/data", method: "GET" };
