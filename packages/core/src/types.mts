/**
 * One click on a link or button on a tracked page. `label` is only what the page author set
 * (data-track or aria-label), never visible text; `href` has no query string or fragment.
 */
export type Click = { t: number; label: string; href?: string };

/**
 * One visit (a browser tab session) to a tracked site. Stored as JSON in `sessions.data`
 * and returned unchanged to the dashboard.
 */
export type Session = {
  sid: string;
  vid: string;
  host: string;
  /** Link ID from a unique link (`?r=k7x2m9qa`), if any. Never an email address. */
  r: string;
  start: number;
  last: number;
  paths: string[];
  /** Saw the Netlify password page. */
  gate: boolean;
  /** Visits recorded before wrong password attempts stopped being counted; no longer written. */
  wrongPw?: number;
  /** Saw real content (got past any password page). */
  unlocked: boolean;
  /** Showed human engagement (click, keypress, 8s+ engaged, or 20%+ scroll). */
  human: boolean;
  engagedMs: number;
  maxScroll: number;
  clicks: Click[];
  sections: string[];
  ref: string;
  device: string;
  browser: string;
  os: string;
  city: string;
  country: string;
  cc: string;
  tz: string;
  /** Approximate location from Netlify's edge geolocation, rounded to 1 decimal (about 10 km). */
  lat?: number | null;
  lon?: number | null;
  visitNo: number;
  visitorCount: number;
  newVisitor: boolean;
  alerts: AlertType[];
  title: string;
  /**
   * Set when the server recorded this visit as t.js loaded, because the browser sends Global
   * Privacy Control or Do Not Track and the tracker doesn't run. Page, time and country only:
   * no city, map location, device, read time, scroll or clicks, and it may be the password
   * page. Each load is its own visit.
   */
  signal?: "gpc" | "dnt";
};

export type AlertType = "open" | "hot" | "deep";

/** Beacon sent by t.js. Short keys keep the payload small. */
export type BeaconEvent = {
  /** Tracker version. 2+ sends click labels only from data-track/aria-label. */
  v?: number;
  /** `optout` asks to delete this browser's visits to the site (see t.js `?pp_optout`). */
  k: "view" | "hb" | "click" | "section" | "leave" | "interact" | "optout";
  /** hostname */
  h: string;
  /** path */
  p?: string;
  sid: string;
  vid: string;
  r?: string;
  /** 0 content, 1 password page (older trackers send 2 after a wrong attempt; treated as 1) */
  gate?: 0 | 1 | 2;
  /** engaged ms since the last report */
  ms?: number;
  /** max scroll % */
  sc?: number;
  /** click label or section title */
  l?: string;
  /** click href */
  u?: string;
  ref?: string;
  /** document title */
  ti?: string;
};

export type SiteStatus = "tracked" | "excluded" | "ignored";

/** A Netlify project as Proposal Pulse sees it. */
export type SiteRecord = {
  id: string;
  name: string;
  team: string;
  url: string;
  host: string;
  hosts: string[];
  status: SiteStatus;
  snippetId?: string | null;
  via?: string | null;
  trackedAt?: number | null;
  /** Netlify's screenshot of the latest production deploy. */
  screenshotUrl?: string | null;
  /** Netlify user ID and display name of whoever created the project. */
  createdBy?: string | null;
  createdByName?: string | null;
};

/** Minimal query interface satisfied by both `pg.Pool` and `pg.PoolClient`. */
export type Db = {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};
