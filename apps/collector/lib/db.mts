import { getDatabase } from "@netlify/database";
import type { Db } from "../../../packages/core/src/index.mts";

/**
 * The collector owns the database: Netlify provisions it for this project and applies
 * netlify/database/migrations on deploy. Created once at module scope so warm function
 * instances reuse the connection.
 */
const database = getDatabase();

/** pg.Pool: use `db.query` for single statements, `pool.connect()` for transactions. */
export const pool = database.pool;
export const db: Db = pool as unknown as Db;
