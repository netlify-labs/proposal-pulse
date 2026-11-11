import { creatorName, ensureSnippet, removeSnippet, type NetlifySite } from "./netlify.mts";
import type { Db, SiteRecord, SiteStatus } from "./types.mts";

/** Shared reads and writes on the `sites` table, used by both apps. */

export type AuditAction = "snippet_added" | "snippet_updated" | "snippet_removed" | "site_forgotten" | "visits_deleted" | "visitor_opted_out" | "consent_given";

/**
 * Append to the audit log: every change Proposal Pulse makes to a live project (Snippet
 * Injection has no deploy to record it) and every deletion of visit data. Never purged by
 * the retention job. `via` is where the change came from: webhook, dashboard or visitor.
 */
export async function audit(db: Db, action: AuditAction, e: { siteId?: string | null; siteName?: string | null; host?: string | null; via: string; detail?: unknown }) {
  await db.query("INSERT INTO audit_log (action, site_id, site_name, host, via, detail) VALUES ($1, $2, $3, $4, $5, $6)", [
    action,
    e.siteId || null,
    e.siteName || null,
    e.host || null,
    e.via,
    e.detail === undefined ? null : JSON.stringify(e.detail),
  ]);
}

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
  screenshotUrl: r.screenshot_url ?? null,
  createdBy: r.created_by ?? null,
  createdByName: r.created_by_name ?? null,
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
  s: Pick<NetlifySite, "id" | "name" | "team" | "url" | "host" | "hosts"> & Partial<Pick<NetlifySite, "screenshotUrl" | "createdBy">>,
  status: SiteStatus,
  extra: { snippetId?: string; via?: string; createdByName?: string } = {},
) {
  await db.query(
    `INSERT INTO sites (id, name, team, url, host, hosts, status, snippet_id, via, tracked_at, updated_at, screenshot_url, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'tracked' THEN now() END, now(), $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, team = EXCLUDED.team, url = EXCLUDED.url, host = EXCLUDED.host, hosts = EXCLUDED.hosts,
       status = EXCLUDED.status,
       snippet_id = COALESCE(EXCLUDED.snippet_id, sites.snippet_id),
       via = COALESCE(EXCLUDED.via, sites.via),
       tracked_at = CASE WHEN EXCLUDED.status = 'tracked' THEN COALESCE(sites.tracked_at, now()) ELSE sites.tracked_at END,
       screenshot_url = COALESCE(EXCLUDED.screenshot_url, sites.screenshot_url),
       created_by = COALESCE(EXCLUDED.created_by, sites.created_by),
       created_by_name = COALESCE(EXCLUDED.created_by_name, sites.created_by_name),
       updated_at = now()`,
    [s.id, s.name, s.team, s.url, s.host, s.hosts, status, extra.snippetId ?? null, extra.via ?? null, s.screenshotUrl || null, s.createdBy || null, extra.createdByName || null],
  );
}

/** Inject the tracker into a project and record it as tracked, with its thumbnail and creator. */
export async function trackSite(db: Db, site: NetlifySite, collectorUrl: string, via: string) {
  const change = await ensureSnippet(site.id, collectorUrl);
  const snippetId = change.id;
  // record the live change first, so it's logged even if the bookkeeping below fails
  await audit(db, change.created ? "snippet_added" : "snippet_updated", {
    siteId: site.id,
    siteName: site.name,
    host: site.host,
    via,
    detail: { snippetId, team: site.team, html: change.html, previousHtml: change.previousHtml },
  });
  const createdByName = await creatorName(site.team, site.createdBy).catch(() => "");
  await upsertSite(db, site, "tracked", { snippetId, via, createdByName });
  return snippetId;
}

/** Refresh a tracked project's name, hosts, thumbnail and creator after a new production deploy. */
export async function refreshTrackedSite(db: Db, site: NetlifySite) {
  const createdByName = await creatorName(site.team, site.createdBy).catch(() => "");
  await upsertSite(db, site, "tracked", { createdByName });
}

/** Remove the tracker and mark the project excluded so webhooks never re-add it. */
export async function untrackSite(db: Db, id: string, via: string) {
  const removed = await removeSnippet(id);
  const rec = await getSiteRecord(db, id);
  await audit(db, "snippet_removed", { siteId: id, siteName: rec?.name, host: rec?.host, via, detail: { removed } });
  await db.query("UPDATE sites SET status = 'excluded', updated_at = now() WHERE id = $1", [id]);
}

/**
 * Drop a project and its visit data from Proposal Pulse without calling Netlify (e.g. the
 * project was deleted). A later webhook for the same project treats it as new.
 */
export async function forgetSite(db: Db, id: string, via: string) {
  const { rows } = await db.query<{ name: string; hosts: string[]; host: string; status: string }>("SELECT name, host, hosts, status FROM sites WHERE id = $1", [id]);
  let visits = 0;
  if (rows[0]) {
    const hosts = [...new Set([rows[0].host, ...(rows[0].hosts || [])].filter(Boolean))];
    await db.query("DELETE FROM alerts WHERE sid IN (SELECT sid FROM sessions WHERE host = ANY($1))", [hosts]);
    visits = (await db.query("DELETE FROM sessions WHERE host = ANY($1)", [hosts])).rowCount || 0;
    await db.query("DELETE FROM visitors WHERE host = ANY($1)", [hosts]);
  }
  await db.query("DELETE FROM sites WHERE id = $1", [id]);
  // Forget doesn't call Netlify: a tracked project keeps its snippet, which the log makes visible.
  await audit(db, "site_forgotten", { siteId: id, siteName: rows[0]?.name, host: rows[0]?.host, via, detail: { visits, status: rows[0]?.status ?? null } });
}

/**
 * Delete individual visits (e.g. your own test visits), their alert markers, and any visitor
 * record left with no visits, so return-visit and forward counts stay accurate.
 */
export async function deleteVisits(db: Db, sids: string[], via: string) {
  if (!sids.length) return 0;
  const { rows } = await db.query<{ host: string; vid: string }>("SELECT DISTINCT host, vid FROM sessions WHERE sid = ANY($1)", [sids]);
  await db.query("DELETE FROM alerts WHERE sid = ANY($1)", [sids]);
  const { rowCount } = await db.query("DELETE FROM sessions WHERE sid = ANY($1)", [sids]);
  for (const v of rows) {
    await db.query(
      "DELETE FROM visitors WHERE host = $1 AND vid = $2 AND NOT EXISTS (SELECT 1 FROM sessions WHERE host = $1 AND vid = $2)",
      [v.host, v.vid],
    );
  }
  const hosts = [...new Set(rows.map((v) => v.host))];
  await audit(db, "visits_deleted", { host: hosts.length === 1 ? hosts[0] : null, via, detail: { visits: rowCount || 0, hosts } });
  return rowCount || 0;
}

/**
 * A visitor opted out (t.js `?pp_optout`): delete every visit from that browser to the site.
 * The log keeps only the site and a count, not the browser ID.
 */
export async function forgetVisitor(db: Db, host: string, vid: string) {
  await db.query("DELETE FROM alerts WHERE sid IN (SELECT sid FROM sessions WHERE host = $1 AND vid = $2)", [host, vid]);
  const { rowCount } = await db.query("DELETE FROM sessions WHERE host = $1 AND vid = $2", [host, vid]);
  await db.query("DELETE FROM visitors WHERE host = $1 AND vid = $2", [host, vid]);
  // logged only when something was deleted, so anonymous requests can't fill the log
  if (rowCount) await audit(db, "visitor_opted_out", { host, via: "visitor", detail: { visits: rowCount } });
  return rowCount || 0;
}
