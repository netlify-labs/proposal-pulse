import type { Config } from "@netlify/functions";
import { env } from "../../../../packages/core/src/index.mts";
import { db } from "../../lib/db.mts";

/**
 * Daily data retention. Deletes visits older than RETENTION_DAYS (default 180), visitors with
 * no remaining visits, old alert markers, and webhook log entries older than 30 days.
 */
export default async () => {
  const days = Math.max(1, Number(env("RETENTION_DAYS")) || 180);
  const cutoff = `${days} days`;
  const s = await db.query("DELETE FROM sessions WHERE last_at < now() - $1::interval", [cutoff]);
  const a = await db.query("DELETE FROM alerts WHERE sent_at < now() - $1::interval", [cutoff]);
  const v = await db.query(
    `DELETE FROM visitors v WHERE v.first_at < now() - $1::interval
       AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.host = v.host AND s.vid = v.vid)`,
    [cutoff],
  );
  const h = await db.query("DELETE FROM hook_events WHERE received_at < now() - interval '30 days'");
  console.log(`retention (${days}d): ${s.rowCount} sessions, ${v.rowCount} visitors, ${a.rowCount} alerts, ${h.rowCount} hook events deleted`);
};

// daily at 03:23 UTC
export const config: Config = { schedule: "23 3 * * *" };
