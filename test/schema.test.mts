import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { claimAlert, recordBeacon, type Pool } from "../apps/collector/lib/visits.mts";
import { deleteVisits, forgetSite, getSiteRecord, listSiteRecords, trackedSiteForHost, upsertSite, type BeaconEvent, type Db } from "../packages/core/src/index.mts";

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
    expect(await deleteVisits(db, [sid])).toBe(1);
    const left = await pool.query(
      "SELECT (SELECT count(*) FROM sessions WHERE sid = $1)::int s, (SELECT count(*) FROM alerts WHERE sid = $1)::int a, (SELECT count(*) FROM visitors WHERE vid = 'lz0delvis01')::int v",
      [sid],
    );
    expect(left.rows[0]).toEqual({ s: 0, a: 0, v: 0 });
  });
});

describe("forget", () => {
  test("removes the project and all of its visit data", async () => {
    await forgetSite(db, site.id);
    expect(await getSiteRecord(db, site.id)).toBeNull();
    const counts = await pool.query(
      "SELECT (SELECT count(*) FROM sessions WHERE host = $1)::int s, (SELECT count(*) FROM visitors WHERE host = $1)::int v",
      [site.host],
    );
    expect(counts.rows[0]).toEqual({ s: 0, v: 0 });
  });
});
