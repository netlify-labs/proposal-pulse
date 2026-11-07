import type { AlertType, BeaconEvent, Session } from "./types.mts";

/** Crawlers, link scanners and email security proxies that pre-open links. */
export const BOT_UA =
  /bot|crawl|spider|slurp|preview|scan|headless|phantom|python|curl|wget|java\/|okhttp|go-http|axios|node-fetch|safelinks|proofpoint|mimecast|barracuda|cisco|fortinet|trendmicro|symantec|lighthouse|pagespeed|gtmetrix|monitor|uptime|facebookexternalhit|slackbot|linkedinbot|whatsapp|telegrambot|discordbot|skypeuripreview|microsoft office|ms-office|google-read-aloud|googleother/i;

const ID = /^[a-z0-9]{8,32}$/;
const HOST = /^[a-z0-9.-]{3,253}$/;

/** Read time that triggers a "deep read" alert. */
export const DEEP_READ_MS = 120_000;

export function isValidEvent(ev: unknown): ev is BeaconEvent {
  const e = ev as BeaconEvent;
  return !!e && typeof e === "object" && ID.test(e.sid) && ID.test(e.vid) && HOST.test(e.h || "");
}

export function parseUA(ua: string) {
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|iPhone|Android/i.test(ua) ? "Mobile" : "Desktop";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Other";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iOS/.test(ua)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "Other";
  return { device, browser, os };
}

export type Geo = { city?: string; country?: string; cc?: string; tz?: string; lat?: number; lon?: number };

/** Round a coordinate to 1 decimal (about 10 km), so stored locations stay city-level. */
const coarse = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

export function newSession(ev: BeaconEvent, ua: string, geo: Geo, now: number): Session {
  return {
    sid: ev.sid,
    vid: ev.vid,
    host: ev.h,
    r: "",
    start: now,
    last: now,
    paths: [],
    gate: false,
    unlocked: false,
    human: false,
    engagedMs: 0,
    maxScroll: 0,
    clicks: [],
    sections: [],
    ref: "",
    ...parseUA(ua),
    city: geo.city || "",
    country: geo.country || "",
    cc: geo.cc || "",
    tz: geo.tz || "",
    lat: coarse(geo.lat),
    lon: coarse(geo.lon),
    visitNo: 0,
    visitorCount: 0,
    newVisitor: false,
    alerts: [],
    title: "",
  };
}

const clip = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/** A link ID from `?r=`, or "" if it looks like an email address. */
export const linkId = (v: unknown) => {
  const r = clip(v, 60);
  return r.includes("@") ? "" : r;
};

/**
 * Where a clicked link goes, without query string or fragment (they can carry personal or deal
 * data). mailto: and tel: links keep only the scheme; anything else is dropped.
 */
export function linkTarget(v: unknown): string {
  const raw = clip(v, 2000);
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "mailto:" || u.protocol === "tel:") return u.protocol;
    if (u.protocol === "http:" || u.protocol === "https:") return (u.origin + u.pathname).slice(0, 300);
  } catch {}
  return "";
}

/** Fold one beacon into the session. Pure: mutates and returns `s`, no I/O. */
export function applyEvent(s: Session, ev: BeaconEvent, now: number): Session {
  s.last = now;
  if (ev.r && !s.r) s.r = linkId(ev.r);
  if (ev.ti && !s.title && !ev.gate) s.title = clip(ev.ti, 120);
  const path = clip(ev.p || "/", 120);
  if (ev.k === "view") {
    if (ev.gate) {
      s.gate = true;
    } else {
      s.unlocked = true;
      if (!s.paths.includes(path) && s.paths.length < 30) s.paths.push(path);
    }
    if (ev.ref && !s.ref) {
      try {
        const rh = new URL(ev.ref).hostname;
        if (rh && rh !== s.host) s.ref = rh;
      } catch {}
    }
  }
  // cap each report so a stuck tab can't inflate read time
  if (typeof ev.ms === "number" && ev.ms > 0) s.engagedMs += Math.min(ev.ms, 30_000);
  if (typeof ev.sc === "number") s.maxScroll = Math.max(s.maxScroll, Math.min(100, Math.round(ev.sc)));
  if (ev.k === "click" && s.clicks.length < 60) {
    const href = linkTarget(ev.u);
    // trackers before v2 fell back to the element's visible text, so their labels are dropped
    const label = (ev.v ?? 0) >= 2 ? clip(ev.l, 80) : "";
    s.clicks.push({ t: now, label, href: href || undefined });
  }
  if (ev.k === "section") {
    const l = clip(ev.l, 70);
    if (l && !s.sections.includes(l) && s.sections.length < 40) s.sections.push(l);
  }
  if (!ev.gate && s.unlocked && (ev.k === "click" || ev.k === "interact" || s.engagedMs >= 8_000 || s.maxScroll >= 20)) {
    s.human = true;
  }
  return s;
}

/**
 * Alerts this event newly earns. Marks them on `s.alerts` so each fires once per session.
 * `open` needs visitor context (visit number, forwards), which the caller fills in first.
 */
export function newAlerts(s: Session, ev: BeaconEvent): AlertType[] {
  const out: AlertType[] = [];
  if (s.human && s.unlocked && !s.alerts.includes("open")) out.push("open");
  // 🔥 read to the end and clicked (same rule as the dashboard's hot visits)
  if (s.human && s.maxScroll >= 90 && s.clicks.length && !s.alerts.includes("hot")) out.push("hot");
  if (s.human && s.engagedMs >= DEEP_READ_MS && !s.alerts.includes("deep")) out.push("deep");
  s.alerts.push(...out);
  return out;
}

/** Session IDs start with a base36 millisecond timestamp (see t.js `rid()`). */
export const sidTime = (sid: string) => parseInt(sid.slice(0, 8), 36);
