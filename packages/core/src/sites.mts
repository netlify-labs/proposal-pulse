import { ensureSnippet, removeSnippet, type NetlifySite } from "./netlify.mts";
import type { Db, SiteRecord, SiteStatus } from "./types.mts";

/** Shared reads and writes on the `sites` table, used by both apps. */

const rowToSite = (r: any): SiteRecord => ({
  id: r.id,
  name: r.name,
  team: r.team,
  url: r.url,
  host: r.host,
  hosts: r.hosts || [],
  status: r.status,
  snippetId: r.snippet_id,
  via: r.via,
  trackedAt: r.tracked_at ? new Date(r.tracked_at).getTime() : null,
});

export async function getSiteRecord(db: Db, id: string): Promise<SiteRecord | null> {
  const { rows } = await db.query("SELECT * FROM sites WHERE id = $1", [id]);
  return rows[0] ? rowToSite(rows[0]) : null;
}

/** The tracked project that answers on `host`, if any. */
export async function trackedSiteForHost(db: Db, host: string): Promise<SiteRecord | null> {
  const { rows } = await db.query("SELECT * FROM sites WHERE status = 'tracked' AND (host = $1 OR $1 = ANY(hosts)) LIMIT 1", [host]);
  return rows[0] ? rowToSite(rows[0]) : null;
}

export async function listSiteRecords(db: Db, status?: SiteStatus): Promise<SiteRecord[]> {
  const { rows } = status
    ? await db.query("SELECT * FROM sites WHERE status = $1 ORDER BY tracked_at DESC NULLS LAST", [status])
    : await db.query("SELECT * FROM sites ORDER BY tracked_at DESC NULLS LAST");
  return rows.map(rowToSite);
}

export async function upsertSite(
  db: Db,
  s: Pick<NetlifySite, "id" | "name" | "team" | "url" | "host" | "hosts">,
  status: SiteStatus,
  extra: { snippetId?: string; via?: string } = {},
) {
  await db.query(
    `INSERT INTO sites (id, name, team, url, host, hosts, status, snippet_id, via, tracked_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'tracked' THEN now() END, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, team = EXCLUDED.team, url = EXCLUDED.url, host = EXCLUDED.host, hosts = EXCLUDED.hosts,
       status = EXCLUDED.status,
       snippet_id = COALESCE(EXCLUDED.snippet_id, sites.snippet_id),
       via = COALESCE(EXCLUDED.via, sites.via),
       tracked_at = CASE WHEN EXCLUDED.status = 'tracked' THEN COALESCE(sites.tracked_at, now()) ELSE sites.tracked_at END,
       updated_at = now()`,
    [s.id, s.name, s.team, s.url, s.host, s.hosts, status, extra.snippetId ?? null, extra.via ?? null],
  );
}

/** Inject the tracker into a project and record it as tracked. */
export async function trackSite(db: Db, site: NetlifySite, collectorUrl: string, via: string) {
  const snippetId = await ensureSnippet(site.id, collectorUrl);
  await upsertSite(db, site, "tracked", { snippetId, via });
  return snippetId;
}

/** Remove the tracker and mark the project excluded so webhooks never re-add it. */
export async function untrackSite(db: Db, id: string) {
  await removeSnippet(id);
  await db.query("UPDATE sites SET status = 'excluded', updated_at = now() WHERE id = $1", [id]);
}

/**
 * Drop a project and its visit data from Proposal Pulse without calling Netlify (e.g. the
 * project was deleted). A later webhook for the same project treats it as new.
 */
export async function forgetSite(db: Db, id: string) {
  const { rows } = await db.query<{ hosts: string[]; host: string }>("SELECT host, hosts FROM sites WHERE id = $1", [id]);
  if (rows[0]) {
    const hosts = [...new Set([rows[0].host, ...(rows[0].hosts || [])].filter(Boolean))];
    await db.query("DELETE FROM alerts WHERE sid IN (SELECT sid FROM sessions WHERE host = ANY($1))", [hosts]);
    await db.query("DELETE FROM sessions WHERE host = ANY($1)", [hosts]);
    await db.query("DELETE FROM visitors WHERE host = ANY($1)", [hosts]);
  }
  await db.query("DELETE FROM sites WHERE id = $1", [id]);
}
