import { describe, expect, test } from "vitest";
import {
  applyEvent,
  isValidEvent,
  newAlerts,
  newSession,
  parseUA,
  readOrgHook,
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

  test("open fires once after human engagement; booking click is hot; 2 minutes is deep", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("view", { ref: "https://mail.google.com/" }), 0);
    expect(newAlerts(s, ev("view"))).toEqual([]); // not yet human
    applyEvent(s, ev("interact"), 1);
    expect(newAlerts(s, ev("interact"))).toEqual(["open"]);
    expect(newAlerts(s, ev("interact"))).toEqual([]); // once per session

    const click = ev("click", { l: "Book a call", u: "https://calendly.com/acme/30min" });
    applyEvent(s, click, 2);
    expect(newAlerts(s, click)).toEqual(["hot"]);

    for (let i = 0; i < 5; i++) applyEvent(s, ev("hb", { ms: 30_000, sc: 80 }), 3 + i);
    expect(s.engagedMs).toBe(150_000);
    expect(newAlerts(s, ev("hb"))).toEqual(["deep"]);
    expect(s.ref).toBe("mail.google.com");
    expect(s.maxScroll).toBe(80);
  });

  test("engaged time per report is capped at 30s", () => {
    const s = newSession(ev("view"), "", {}, 0);
    applyEvent(s, ev("hb", { ms: 10 * 60_000 }), 0);
    expect(s.engagedMs).toBe(30_000);
  });
});

test("parseUA", () => {
  expect(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1")).toEqual({
    device: "Mobile",
    browser: "Safari",
    os: "iOS",
  });
  expect(parseUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0")).toEqual({ device: "Desktop", browser: "Edge", os: "Windows" });
});
