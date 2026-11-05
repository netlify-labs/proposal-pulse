/** One click on a link or button on a tracked page. */
export type Click = { t: number; label: string; href?: string };

/**
 * One visit (a browser tab session) to a tracked site. Stored as JSON in `sessions.data`
 * and returned unchanged to the dashboard.
 */
export type Session = {
  sid: string;
  vid: string;
  host: string;
  /** Recipient label from the personal link (`?r=jane`), if any. */
  r: string;
  start: number;
  last: number;
  paths: string[];
  /** Saw the Netlify password page. */
  gate: boolean;
  wrongPw: number;
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
  visitNo: number;
  visitorCount: number;
  newVisitor: boolean;
  alerts: AlertType[];
  title: string;
};

export type AlertType = "open" | "deep";

/** Beacon sent by t.js. Short keys keep the payload small. */
export type BeaconEvent = {
  k: "view" | "hb" | "click" | "section" | "leave" | "interact";
  /** hostname */
  h: string;
  /** path */
  p?: string;
  sid: string;
  vid: string;
  r?: string;
  /** 0 content, 1 password page, 2 password page after a wrong attempt */
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
