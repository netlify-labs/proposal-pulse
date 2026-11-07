import { describe, expect, test } from "vitest";
import {
  applyEvent,
  isValidEvent,
  newAlerts,
  newSession,
  parseUA,
  readManageRequest,
  openAlert,
  hotAlert,
  composeAlert,
  linkId,
  linkTarget,
  readOrgHook,
  signManageRequest,
  signNetlifyWebhook,
  verifyNetlifySignature,
  type BeaconEvent,
} from "../packages/core/src/index.mts";

const SECRET = "test-secret";
const ev = (k: BeaconEvent["k"], extra: Partial<BeaconEvent> = {}): BeaconEvent => ({ k, h: "deal.example.com", sid: "abcd1234efgh", vid: "visitor1234", ...extra });

describe("webhook signature", () => {
  const body = JSON.stringify({ id: "11111111-2222-3333-4444-555555555555", account_slug: "acme" });

  test("accepts a correctly signed body", () => {
    expect(verifyNetlifySignature(signNetlifyWebhook(body, SECRET), body, SECRET)).toBe(true);
  });
  test("rejects a tampered body, wrong secret, missing secret and garbage", () => {
    const sig = signNetlifyWebhook(body, SECRET);
    expect(verifyNetlifySignature(sig, body + " ", SECRET)).toBe(false);
    expect(verifyNetlifySignature(sig, body, "other")).toBe(false);
    expect(verifyNetlifySignature(sig, body, "")).toBe(false);
    expect(verifyNetlifySignature("a.b.c", body, SECRET)).toBe(false);
    expect(verifyNetlifySignature("", body, SECRET)).toBe(false);
  });
});

describe("org webhook payloads", () => {
  test("site_created: project object with team", () => {
    expect(readOrgHook({ id: "s1", name: "deal", account_slug: "acme" })).toEqual({ siteId: "s1", name: "deal", team: "acme" });
  });
  test("site_published: deploy object, site_id wins over the deploy id, no team", () => {
    expect(readOrgHook({ id: "deploy1", site_id: "s1", name: "deal" })).toEqual({ siteId: "s1", name: "deal", team: "" });
  });
});

describe("beacon validation", () => {
  test("accepts a well-formed event", () => expect(isValidEvent(ev("view"))).toBe(true));
  test("rejects bad ids and hosts", () => {
    expect(isValidEvent({ ...ev("view"), sid: "x" })).toBe(false);
    expect(isValidEvent({ ...ev("view"), h: "<script>" })).toBe(false);
    expect(isValidEvent(null)).toBe(false);
  });
});

describe("session folding and alerts", () => {
  test("a password-page view is not an open", () => {
    const s = newSession(ev("view", { gate: 1 }), "", {}, 0);
    applyEvent(s, ev("view", { gate: 1 }), 0);
    expect(s.gate).toBe(true);
    expect(s.unlocked).toBe(false);
    expect(newAlerts(s, ev("view", { gate: 1 }))).toEqual([]);
  });

  test("open fires once after human engagement; clicks are recorded; 2 minutes is deep", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("view", { ref: "https://mail.google.com/" }), 0);
    expect(newAlerts(s, ev("view"))).toEqual([]); // not yet human
    applyEvent(s, ev("interact"), 1);
    expect(newAlerts(s, ev("interact"))).toEqual(["open"]);
    expect(newAlerts(s, ev("interact"))).toEqual([]); // once per session

    const click = ev("click", { v: 2, l: "Book a call", u: "https://calendly.com/acme/30min" });
    applyEvent(s, click, 2);
    expect(newAlerts(s, click)).toEqual([]); // clicked, but hasn't reached the end yet
    expect(s.clicks.at(-1)).toMatchObject({ label: "Book a call", href: "https://calendly.com/acme/30min" });

    for (let i = 0; i < 5; i++) applyEvent(s, ev("hb", { ms: 30_000, sc: 80 }), 3 + i);
    expect(s.engagedMs).toBe(150_000);
    expect(newAlerts(s, ev("hb"))).toEqual(["deep"]);
    expect(s.ref).toBe("mail.google.com");
    expect(s.maxScroll).toBe(80);
  });

  test("wrong password attempts are not counted (older trackers send gate: 2)", () => {
    const s = newSession(ev("view", { gate: 2 }), "", {}, 0);
    applyEvent(s, ev("view", { gate: 2 }), 0);
    expect(s.gate).toBe(true);
    expect(s).not.toHaveProperty("wrongPw");
  });

  test("engaged time per report is capped at 30s", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("hb", { ms: 10 * 60_000 }), 0);
    expect(s.engagedMs).toBe(30_000);
  });
});

test("visit locations are rounded to about 10 km, and optional", () => {
  expect(newSession(ev("view"), "", { lat: 51.50722, lon: -0.12751 }, 0)).toMatchObject({ lat: 51.5, lon: -0.1 });
  expect(newSession(ev("view"), "", {}, 0)).toMatchObject({ lat: null, lon: null });
});

test("parseUA", () => {
  expect(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1")).toEqual({
    device: "Mobile",
    browser: "Safari",
    os: "iOS",
  });
  expect(parseUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0")).toEqual({ device: "Desktop", browser: "Edge", os: "Windows" });
});

describe("signed admin requests (dashboard -> collector)", () => {
  test("round-trips a valid request", () => {
    const { body, signature } = signManageRequest({ op: "untrack", ids: ["a"] }, SECRET, 1_000_000);
    expect(readManageRequest(body, signature, SECRET, 1_000_000 + 60_000)).toMatchObject({ op: "untrack", ids: ["a"] });
  });
  test("rejects tampering, the wrong secret, expired requests and unknown ops", () => {
    const { body, signature } = signManageRequest({ op: "untrack", ids: ["a"] }, SECRET, 1_000_000);
    expect(readManageRequest(body.replace('"a"', '"b"'), signature, SECRET, 1_000_000)).toBeNull();
    expect(readManageRequest(body, signature, "other", 1_000_000)).toBeNull();
    expect(readManageRequest(body, signature, SECRET, 1_000_000 + 6 * 60_000)).toBeNull();
    const bad = signManageRequest({ op: "drop" as any }, SECRET, 1_000_000);
    expect(readManageRequest(bad.body, bad.signature, SECRET, 1_000_000)).toBeNull();
  });
});

describe("collect less", () => {
  test("click links lose query strings and fragments; mailto/tel keep only the scheme", () => {
    expect(linkTarget("https://acme.com/pricing?email=jane@acme.com&deal=42#top")).toBe("https://acme.com/pricing");
    expect(linkTarget("mailto:jane@acme.com?subject=Deal")).toBe("mailto:");
    expect(linkTarget("tel:+15551234567")).toBe("tel:");
    expect(linkTarget("javascript:void(0)")).toBe("");
    expect(linkTarget("not a url")).toBe("");
    expect(linkTarget(undefined)).toBe("");
  });

  test("click labels are kept only from v2 trackers (author-set labels), never older visible text", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("click", { l: "Email Jane Smith", u: "mailto:jane@acme.com" }), 1);
    applyEvent(s, ev("click", { v: 2, l: "Pricing CTA", u: "https://acme.com/p?x=1" }), 2);
    expect(s.clicks).toEqual([
      { t: 1, label: "", href: "mailto:" },
      { t: 2, label: "Pricing CTA", href: "https://acme.com/p" },
    ]);
  });

  test("link IDs that are email addresses are dropped", () => {
    expect(linkId("k7x2m9qa")).toBe("k7x2m9qa");
    expect(linkId("jane@acme.com")).toBe("");
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("view", { r: "jane@acme.com" }), 0);
    expect(s.r).toBe("");
  });
});

describe("🔥 alert and Slack format", () => {
  test("read to the end and clicked fires 🔥 once", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("view"), 0);
    applyEvent(s, ev("interact"), 1);
    expect(newAlerts(s, ev("interact"))).toEqual(["open"]);
    applyEvent(s, ev("hb", { sc: 95 }), 2);
    expect(newAlerts(s, ev("hb"))).toEqual([]); // reached the end, no click yet
    applyEvent(s, ev("click", { l: "Pricing" }), 3);
    expect(newAlerts(s, ev("click"))).toEqual(["hot"]);
    expect(newAlerts(s, ev("click"))).toEqual([]);
  });

  test("two compact lines with creator and a dashboard link only", () => {
    const s = { ...newSession(ev("view"), "", { city: "London", cc: "GB" }, 0), r: "jane", engagedMs: 196_000, clicks: [{ t: 0, label: "a" }, { t: 0, label: "b" }] };
    expect(hotAlert(s, "https://dash.example.com/", { createdByName: "Marina" })).toBe(
      ":fire: *deal.example.com* · by Marina · read to the end and clicked\n*jane* · London, GB · 3m 16s · 2 clicks → https://dash.example.com/#site=deal.example.com",
    );
    expect(openAlert({ ...s, r: "", newVisitor: true, visitorCount: 1 }, "https://dash.example.com", {})).toBe(
      ":eyes: *deal.example.com* · opened (first visit)\nLondon, GB → https://dash.example.com/#site=deal.example.com",
    );
  });
});

test("alerts earned together become one message led by the strongest", () => {
  const base = { ...newSession(ev("view"), "", { city: "Atlanta", cc: "US" }, 0), engagedMs: 3000, clicks: [{ t: 0, label: "a" }] };
  expect(composeAlert({ ...base, newVisitor: false, visitNo: 2 }, ["open", "hot"], "https://dash.test", { createdByName: "Ricky" })).toBe(
    ":fire: *deal.example.com* · by Ricky · read to the end and clicked · came back (visit #2)\nAtlanta, US · 3s · 1 click → https://dash.test/#site=deal.example.com",
  );
  // a plain first-visit open adds nothing next to 🔥
  expect(composeAlert({ ...base, newVisitor: true, visitorCount: 1 }, ["open", "hot"], "https://dash.test")).toBe(
    ":fire: *deal.example.com* · read to the end and clicked\nAtlanta, US · 3s · 1 click → https://dash.test/#site=deal.example.com",
  );
});
