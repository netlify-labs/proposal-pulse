import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { claimAlert, recordBeacon, recordConsent, recordServerVisit, type Pool } from "../apps/collector/lib/visits.mts";
import {
  audit,
  deleteVisits,
  openOnlyEvent,
  forgetSite,
  forgetVisitor,
  getSiteRecord,
  listSiteRecords,
  trackedSiteForHost,
  upsertSite,
  type BeaconEvent,
  type Db,
} from "../packages/core/src/index.mts";

/**
 * Applies the real migrations and runs the apps' real queries.
 *
 * By default this uses the local Netlify Database emulator (PGlite). It is single-process and
 * does not isolate concurrent connections, so the concurrency test only runs against a real,
 * empty Postgres: TEST_DATABASE_URL=postgres://... npm test
 */
const REAL_PG = process.env.TEST_DATABASE_URL || "";

let local: NetlifyDB | undefined;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  let connectionString = REAL_PG;
  if (!connectionString) {
    local = new NetlifyDB();
    connectionString = await local.start();
    await local.applyMigrations("./apps/collector/netlify/database/migrations");
  }
  pool = new pg.Pool({ connectionString, max: 4 });
  db = pool as unknown as Db;
  if (REAL_PG) {
    const fs = await import("node:fs");
    const dir = "./apps/collector/netlify/database/migrations";
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pool.query(fs.readFileSync(`${dir}/${f}`, "utf8"));
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await local?.stop();
});

const site = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "acme-proposal",
  team: "sales",
  url: "https://acme-proposal.netlify.app",
  host: "acme-proposal.netlify.app",
  hosts: ["acme-proposal.netlify.app", "proposal.acme.com"],
};

const beacon = (k: BeaconEvent["k"], extra: Partial<BeaconEvent> = {}): BeaconEvent => ({
  k,
  h: site.host,
  sid: "lz0abc12xyz",
  vid: "lz0vis12xyz",
  r: "jane",
  ...extra,
});

describe("sites", () => {
  test("tracked projects are found by any of their hosts", async () => {
    await upsertSite(db, site, "tracked", { snippetId: "42", via: "webhook" });
    expect((await trackedSiteForHost(db, "proposal.acme.com"))?.id).toBe(site.id);
    expect(await trackedSiteForHost(db, "unknown.example.com")).toBeNull();
    const rec = await getSiteRecord(db, site.id);
    expect(rec).toMatchObject({ status: "tracked", snippetId: "42", via: "webhook" });
    expect(rec?.trackedAt).toBeTypeOf("number");
  });

  test("ignored projects are not tracked; re-tracking keeps the first tracked_at", async () => {
    await upsertSite(db, { ...site, id: "99999999-2222-3333-4444-555555555555", host: "other.netlify.app", hosts: [] }, "ignored");
    expect(await trackedSiteForHost(db, "other.netlify.app")).toBeNull();
    const before = (await getSiteRecord(db, site.id))?.trackedAt;
    await upsertSite(db, site, "tracked", {});
    const after = await getSiteRecord(db, site.id);
    expect(after?.trackedAt).toBe(before);
    expect(after?.snippetId).toBe("42"); // not overwritten by a null
    expect((await listSiteRecords(db, "tracked")).map((s) => s.id)).toEqual([site.id]);
  });
});

describe("thumbnail and creator", () => {
  test("are saved, and kept when a later update doesn't supply them", async () => {
    const id = "22222222-2222-3333-4444-555555555555";
    const base = { ...site, id, host: "thumbs.netlify.app", hosts: ["thumbs.netlify.app"] };
    await upsertSite(db, { ...base, screenshotUrl: "https://example.test/shot.webp", createdBy: "u1" }, "tracked", { createdByName: "Ada" });
    expect(await getSiteRecord(db, id)).toMatchObject({ screenshotUrl: "https://example.test/shot.webp", createdBy: "u1", createdByName: "Ada" });
    await upsertSite(db, base, "tracked", {});
    expect(await getSiteRecord(db, id)).toMatchObject({ screenshotUrl: "https://example.test/shot.webp", createdByName: "Ada" });
    await upsertSite(db, { ...base, screenshotUrl: "https://example.test/new.webp" }, "tracked", {});
    expect((await getSiteRecord(db, id))?.screenshotUrl).toBe("https://example.test/new.webp");
    await pool.query("DELETE FROM sites WHERE id = $1", [id]);
  });
});

describe("beacons", () => {
  test("a visit accumulates, earns open once, and counts the visitor", async () => {
    const p = pool as unknown as Pool;
    let r = await recordBeacon(p, beacon("view"), "Mozilla/5.0 (Macintosh) Chrome/130", { city: "Austin", cc: "US" }, 1_000);
    expect(r.pending).toEqual([]);
    r = await recordBeacon(p, beacon("interact"), "", {}, 2_000);
    expect(r.pending).toEqual(["open"]);
    expect(r.session).toMatchObject({ newVisitor: true, visitNo: 1, visitorCount: 1, r: "jane", city: "Austin", browser: "Chrome" });
    r = await recordBeacon(p, beacon("hb", { ms: 5_000 }), "", {}, 3_000);
    expect(r.pending).toEqual([]);
    const { rows } = await pool.query("SELECT data FROM sessions WHERE sid = $1", [beacon("view").sid]);
    expect(rows[0].data.engagedMs).toBe(5_000);
    expect(rows[0].data.alerts).toEqual(["open"]);
  });

  test.skipIf(!REAL_PG)("concurrent beacons on one session lose no updates (needs TEST_DATABASE_URL)", async () => {
    const p = pool as unknown as Pool;
    const sid = "lz0conc1xyz";
    await Promise.all(Array.from({ length: 10 }, (_, i) => recordBeacon(p, beacon("hb", { sid, ms: 1_000 }), "", {}, 10_000 + i)));
    const { rows } = await pool.query("SELECT data FROM sessions WHERE sid = $1", [sid]);
    expect(rows[0].data.engagedMs).toBe(10_000);
  });

  test("a second visit from the same browser is 'back again' and keeps the recipient", async () => {
    const p = pool as unknown as Pool;
    const sid = "lz0second1x";
    await recordBeacon(p, beacon("view", { sid, r: undefined }), "", {}, 20_000);
    const r = await recordBeacon(p, beacon("interact", { sid, r: undefined }), "", {}, 21_000);
    expect(r.pending).toEqual(["open"]);
    expect(r.session).toMatchObject({ newVisitor: false, visitNo: 2, r: "jane" });
  });

  test("each alert is claimed once", async () => {
    expect(await claimAlert(db, "lz0abc12xyz", "open")).toBe(true);
    expect(await claimAlert(db, "lz0abc12xyz", "open")).toBe(false);
  });
});

describe("delete visits", () => {
  test("removes the visit, its alerts, and a visitor left with no visits", async () => {
    const p = pool as unknown as Pool;
    const sid = "lz0delete01";
    await recordBeacon(p, beacon("view", { sid, vid: "lz0delvis01" }), "", {}, 30_000);
    await recordBeacon(p, beacon("interact", { sid, vid: "lz0delvis01" }), "", {}, 31_000);
    await claimAlert(db, sid, "open");
    expect(await deleteVisits(db, [sid], "dashboard")).toBe(1);
    const left = await pool.query(
      "SELECT (SELECT count(*) FROM sessions WHERE sid = $1)::int s, (SELECT count(*) FROM alerts WHERE sid = $1)::int a, (SELECT count(*) FROM visitors WHERE vid = 'lz0delvis01')::int v",
      [sid],
    );
    expect(left.rows[0]).toEqual({ s: 0, a: 0, v: 0 });
    const log = await pool.query("SELECT action, host, via, detail FROM audit_log WHERE action = 'visits_deleted' ORDER BY id DESC LIMIT 1");
    expect(log.rows[0]).toMatchObject({ action: "visits_deleted", host: site.host, via: "dashboard", detail: { visits: 1 } });
  });
});

describe("opt-out", () => {
  test("deletes every visit from that browser to the site and logs only a count", async () => {
    const p = pool as unknown as Pool;
    const vid = "lz0optout01";
    await recordBeacon(p, beacon("view", { sid: "lz0optses01", vid }), "", {}, 40_000);
    await recordBeacon(p, beacon("interact", { sid: "lz0optses01", vid }), "", {}, 41_000);
    await recordBeacon(p, beacon("view", { sid: "lz0optses02", vid }), "", {}, 42_000);
    await recordBeacon(p, beacon("interact", { sid: "lz0optses02", vid }), "", {}, 43_000);
    await claimAlert(db, "lz0optses01", "open");
    expect(await forgetVisitor(db, site.host, vid)).toBe(2);
    const left = await pool.query(
      "SELECT (SELECT count(*) FROM sessions WHERE vid = $1)::int s, (SELECT count(*) FROM alerts WHERE sid LIKE 'lz0optses%')::int a, (SELECT count(*) FROM visitors WHERE vid = $1)::int v",
      [vid],
    );
    expect(left.rows[0]).toEqual({ s: 0, a: 0, v: 0 });
    const log = await pool.query("SELECT via, detail::text AS detail FROM audit_log WHERE action = 'visitor_opted_out' ORDER BY id DESC LIMIT 1");
    expect(log.rows[0].via).toBe("visitor");
    expect(log.rows[0].detail).not.toContain(vid);
  });
});

describe("server-recorded loads (GPC / Do Not Track)", () => {
  test("store only the page, time and country with the signal", async () => {
    const s = await recordServerVisit(db, { host: site.host, path: "/" }, { city: "Austin", country: "United States", cc: "US", tz: "America/Chicago", lat: 30.27, lon: -97.74 }, 50_000, "gpc");
    const { rows } = await pool.query("SELECT vid, data FROM sessions WHERE sid = $1", [s.sid]);
    expect(rows[0].data).toMatchObject({ signal: "gpc", host: site.host, paths: ["/"], start: 50_000, country: "United States", cc: "US", city: "", tz: "", lat: null, lon: null, device: "", browser: "", os: "", unlocked: true, human: false, engagedMs: 0, clicks: [], alerts: [] });
    expect(rows[0].vid).toMatch(/^[a-z0-9]{8,32}$/);
    // not counted as a person
    expect((await pool.query("SELECT count(*)::int n FROM visitors WHERE vid = $1", [rows[0].vid])).rows[0].n).toBe(0);
    await pool.query("DELETE FROM sessions WHERE sid = $1", [s.sid]);
  });
});

describe("open-only visits (EU/UK/CH before a Sure)", () => {
  const sid = "lz0euopen01";
  const open = (k: BeaconEvent["k"], extra: Partial<BeaconEvent> = {}) =>
    openOnlyEvent({ k, h: site.host, sid, vid: sid, p: "/", r: "k7x2m9qa", o: 1, ti: "Acme deal", ref: "https://mail.example.com", ...extra })!;
  const geo = { city: "Berlin", country: "Germany", cc: "DE", lat: 52.52, lon: 13.4 };

  test("keep page, link ID, location and device; never count a person", async () => {
    const p = pool as unknown as Pool;
    await recordBeacon(p, open("view"), "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120", geo, 60_000);
    const { pending } = await recordBeacon(p, open("interact"), "", geo, 61_000);
    expect(pending).toEqual(["open"]);
    const { rows } = await pool.query("SELECT vid, data FROM sessions WHERE sid = $1", [sid]);
    expect(rows[0].vid).toBe(sid);
    expect(rows[0].data).toMatchObject({ basic: true, human: true, unlocked: true, r: "k7x2m9qa", city: "Berlin", cc: "DE", browser: "Chrome", os: "macOS", title: "", ref: "", visitNo: 0, newVisitor: false });
    expect((await pool.query("SELECT count(*)::int n FROM visitors WHERE vid = $1", [sid])).rows[0].n).toBe(0);
    // reading stats can't be added to an open-only visit
    expect(openOnlyEvent({ k: "hb", h: site.host, sid, vid: sid, ms: 9000, sc: 80 })).toBeNull();
    await recordBeacon(p, { k: "click", h: site.host, sid, vid: "lz0someone1", l: "Pricing", v: 2 }, "", geo, 62_000);
    expect((await pool.query("SELECT data FROM sessions WHERE sid = $1", [sid])).rows[0].data).toMatchObject({ clicks: [], engagedMs: 0, basic: true });
  });

  test("a Sure turns it into a normal visit and is logged", async () => {
    const p = pool as unknown as Pool;
    const vid = "lz0eubrowsr1";
    expect(await recordConsent(db, site.host, sid, vid, "DE", 63_000)).toBe(true);
    await recordBeacon(p, { k: "view", h: site.host, sid, vid, p: "/", ti: "Acme deal", v: 2 }, "", geo, 63_500);
    await recordBeacon(p, { k: "hb", h: site.host, sid, vid, ms: 9000, sc: 80, v: 2 }, "", geo, 64_000);
    const { rows } = await pool.query("SELECT vid, data FROM sessions WHERE sid = $1", [sid]);
    expect(rows[0].vid).toBe(vid);
    expect(rows[0].data.basic).toBeUndefined();
    expect(rows[0].data).toMatchObject({ vid, title: "Acme deal", engagedMs: 9000, maxScroll: 80 });
    expect((await pool.query("SELECT count(*)::int n FROM visitors WHERE vid = $1", [vid])).rows[0].n).toBe(1);
    const log = await pool.query("SELECT via, host, detail FROM audit_log WHERE action = 'consent_given' ORDER BY id DESC LIMIT 1");
    expect(log.rows[0]).toMatchObject({ via: "visitor", host: site.host, detail: { sid, vid, cc: "DE" } });
    // a second Sure, or one for a visit that isn't open-only, changes and logs nothing
    expect(await recordConsent(db, site.host, sid, vid, "DE", 65_000)).toBe(false);
    expect(await recordConsent(db, site.host, "lz0nosuch001", vid, "DE", 65_000)).toBe(false);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'consent_given'")).rows[0].n).toBe(1);
    await forgetVisitor(db, site.host, vid);
  });
});

describe("audit log", () => {
  test("records snippet changes and is untouched by the retention purge", async () => {
    await audit(db, "snippet_added", { siteId: site.id, siteName: site.name, host: site.host, via: "webhook", detail: { snippetId: "7", html: "<script>" } });
    const { rows } = await pool.query("SELECT action, site_id, via, detail FROM audit_log WHERE action = 'snippet_added' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toMatchObject({ action: "snippet_added", site_id: site.id, via: "webhook", detail: { snippetId: "7", html: "<script>" } });
    const fs = await import("node:fs");
    expect(fs.readFileSync("./apps/collector/netlify/functions/cleanup.mts", "utf8")).not.toMatch(/DELETE FROM audit_log/);
  });
});
