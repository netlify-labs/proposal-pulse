import { randomBytes } from "node:crypto";
import {
  applyEvent,
  newAlerts,
  newSession,
  type AlertType,
  type BeaconEvent,
  type Db,
  type Geo,
  type Session,
} from "../../../packages/core/src/index.mts";

/** Anything that can hand out a dedicated connection for a transaction (pg.Pool). */
export type Pool = { connect(): Promise<Db & { release(): void }> };

/**
 * Fold one beacon into its session inside a transaction, so overlapping beacons from the same
 * tab never lose an update. The row is created first (ON CONFLICT DO NOTHING) and then locked
 * with FOR UPDATE: a visit's first beacons often arrive together, and a lock on a row that
 * doesn't exist yet would protect nothing. Returns the saved session and the alerts it newly
 * earned (not yet sent).
 */
export async function recordBeacon(pool: Pool, ev: BeaconEvent, ua: string, geo: Geo, now: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fresh = newSession(ev, ua, geo, now);
    await client.query(
      `INSERT INTO sessions (sid, vid, host, started_at, last_at, data)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0), $5)
       ON CONFLICT (sid) DO NOTHING`,
      [fresh.sid, fresh.vid, fresh.host, now, JSON.stringify(fresh)],
    );
    const { rows } = await client.query<{ data: Session }>("SELECT data FROM sessions WHERE sid = $1 FOR UPDATE", [ev.sid]);
    const s = rows[0].data;
    applyEvent(s, ev, now);
    const pending: AlertType[] = newAlerts(s, ev);
    if (pending.includes("open")) await addVisitorContext(client, s);
    await client.query("UPDATE sessions SET last_at = to_timestamp($2 / 1000.0), data = $3 WHERE sid = $1", [s.sid, s.last, JSON.stringify(s)]);
    await client.query("COMMIT");
    return { session: s, pending };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Count this browser's visits and how many different browsers opened the site. */
async function addVisitorContext(client: Db, s: Session) {
  const { rows } = await client.query<{ visits: number; recipient: string | null; inserted: boolean }>(
    `INSERT INTO visitors (host, vid, first_at, visits, recipient)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), 1, NULLIF($4, ''))
     ON CONFLICT (host, vid) DO UPDATE SET
       visits = visitors.visits + 1,
       recipient = COALESCE(visitors.recipient, EXCLUDED.recipient)
     RETURNING visits, recipient, (xmax = 0) AS inserted`,
    [s.host, s.vid, s.start, s.r],
  );
  const v = rows[0];
  if (v.recipient && !s.r) s.r = v.recipient; // same browser came back without the personal link
  s.newVisitor = v.inserted;
  s.visitNo = v.visits;
  const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM visitors WHERE host = $1", [s.host]);
  s.visitorCount = count.rows[0].n;
}

/**
 * Record a page load as a visit from the server alone (see Session.signal). No browser ID
 * exists for these browsers, so each load gets its own random IDs and isn't counted as a
 * person or a return visit, and no Slack alert fires.
 */
export async function recordServerVisit(db: Db, page: { host: string; path: string }, ua: string, geo: Geo, now: number, signal: "gpc" | "dnt") {
  const id = () => now.toString(36) + randomBytes(6).toString("hex");
  const ev: BeaconEvent = { k: "view", h: page.host, p: page.path, sid: id(), vid: id() };
  const s = newSession(ev, ua, geo, now);
  applyEvent(s, ev, now);
  s.signal = signal;
  await db.query(
    `INSERT INTO sessions (sid, vid, host, started_at, last_at, data)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0), $5)`,
    [s.sid, s.vid, s.host, now, JSON.stringify(s)],
  );
  return s;
}

/** True the first time an alert is claimed for a visit; the primary key makes it atomic. */
export async function claimAlert(db: Db, sid: string, type: AlertType) {
  const { rowCount } = await db.query("INSERT INTO alerts (sid, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sid, type]);
  return !!rowCount;
}
