import pg from "pg";
import { env, type Db } from "../../../packages/core/src/index.mts";

/**
 * The dashboard reads the collector's Netlify Database directly, using the collector's
 * production connection string in PULSE_DATABASE_URL (a secret env var).
 *
 * It uses plain `pg` on purpose: installing @netlify/database here would make Netlify
 * provision a second, empty database for the dashboard project.
 *
 * This is the read-only role `netlify database status --show-credentials` hands out. Every
 * change (track, untrack, forget) goes to the collector as a signed request instead.
 */
let pool: pg.Pool | null = null;

export function db(): Db {
  if (!pool) {
    const connectionString = env("PULSE_DATABASE_URL");
    if (!connectionString) throw new Error("PULSE_DATABASE_URL is not set on the dashboard project");
    pool = new pg.Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000 });
    pool.on("error", (e) => console.error("pg pool error", e));
  }
  return pool as unknown as Db;
}
