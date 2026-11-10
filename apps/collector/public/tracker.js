/* Proposal Pulse tracker: cookieless engagement beacon for shared sites. */
(function () {
  "use strict";
  if (window.__proposalPulse) return;
  window.__proposalPulse = 1;
  var noTrack = false;
  try {
    if (navigator.webdriver) return;
    // Global Privacy Control / Do Not Track: record nothing (checked after the opt-out below)
    noTrack = navigator.globalPrivacyControl === true || navigator.doNotTrack === "1" || window.doNotTrack === "1";
  } catch (e) {}

  var me = document.currentScript;
  var HUB = me && me.src ? new URL(me.src).origin : "";
  if (!HUB || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  var END = HUB + "/api/t";

  function store(kind, k, v) {
    try {
      var s = window[kind];
      if (v === undefined) return s.getItem(k);
      s.setItem(k, v);
    } catch (e) {
      return null;
    }
  }
  function unstore(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {}
  }
  function rid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  }
  function post(body) {
    return fetch(END, { method: "POST", body: body, keepalive: true, mode: "cors", credentials: "omit", headers: { "content-type": "text/plain" } }).catch(function () {});
  }

  var q = new URLSearchParams(location.search);

  // Opt out: any page URL with ?pp_optout stops tracking in this browser for this site and
  // asks the collector to delete what it already recorded. Nothing is shown on the page.
  if (q.has("pp_optout")) {
    var old = store("localStorage", "_pp_v");
    store("localStorage", "_pp_off", "1");
    unstore("_pp_v");
    unstore("_pp_r");
    if (old) post(JSON.stringify({ k: "optout", h: location.hostname, sid: rid(), vid: old }));
    return;
  }
  if (noTrack || store("localStorage", "_pp_off") === "1") return;

  // The browser ID starts with its creation time (see rid). After 180 days, the same as visit
  // retention, it is replaced along with the saved link ID, so the browser counts as new.
  var vid = store("localStorage", "_pp_v");
  var born = vid ? parseInt(vid.slice(0, 8), 36) : NaN;
  if (!vid || !(Date.now() - born < 180 * 864e5)) {
    vid = rid();
    unstore("_pp_r");
  }
  store("localStorage", "_pp_v", vid);
  var sid = store("sessionStorage", "_pp_s") || rid();
  store("sessionStorage", "_pp_s", sid);

  // link ID from a unique link (?r=...); never an email address
  var r = (q.get("r") || q.get("to") || "").slice(0, 60);
  if (r.indexOf("@") > -1) r = "";
  if (r) store("localStorage", "_pp_r", r);
  else r = store("localStorage", "_pp_r") || "";
  if (r.indexOf("@") > -1) r = "";

  // Netlify password page: only whether it was shown, never attempts or input
  var gate = document.title === "Password Protection" && !!document.querySelector('input[type="password"][name="password"]') ? 1 : 0;

  var queue = Promise.resolve();
  function base(k) {
    return { v: 2, k: k, h: location.hostname, p: location.pathname, sid: sid, vid: vid, r: r || undefined, gate: gate || undefined };
  }
  function send(k, extra, beacon) {
    var ev = base(k);
    for (var x in extra) ev[x] = extra[x];
    var body = JSON.stringify(ev);
    if (beacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(END, new Blob([body], { type: "text/plain" }))) return;
      } catch (e) {}
    }
    queue = queue.then(function () {
      return post(body);
    });
  }
  /** Where a link goes, without query string or fragment; mailto/tel links keep only the scheme. */
  function linkTarget(href) {
    if (!href) return "";
    try {
      var u = new URL(href, location.href);
      if (u.protocol === "mailto:" || u.protocol === "tel:") return u.protocol;
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin + u.pathname;
    } catch (e) {}
    return "";
  }
  var ref = "";
  try {
    ref = document.referrer ? new URL(document.referrer).origin : "";
  } catch (e) {}

  send("view", { ref: ref || undefined, ti: document.title });
  if (gate) return; // on the password page only the view is recorded

  // ---------- engagement time ----------
  var engaged = 0;
  var lastTick = Date.now();
  var lastActive = Date.now();
  var IDLE = 120000;
  function active() {
    lastActive = Date.now();
  }
  function tick() {
    var now = Date.now();
    if (document.visibilityState === "visible" && now - lastActive < IDLE) engaged += now - lastTick;
    lastTick = now;
  }
  function scrollPct() {
    var d = document.documentElement;
    var h = Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (h <= window.innerHeight) return 100;
    return Math.min(100, Math.round(((window.scrollY + window.innerHeight) / h) * 100));
  }
  var maxScroll = scrollPct();
  var interacted = false;
  ["pointerdown", "keydown", "wheel", "touchstart", "mousemove", "scroll"].forEach(function (t) {
    window.addEventListener(
      t,
      function () {
        active();
        if (t === "scroll") maxScroll = Math.max(maxScroll, scrollPct());
        if (!interacted && t !== "mousemove" && t !== "scroll") {
          interacted = true;
          send("interact", {});
        }
      },
      { passive: true, capture: true },
    );
  });
  function flush(beacon) {
    tick();
    if (engaged < 1000 && !beacon) return;
    var ms = engaged;
    engaged = 0;
    send("hb", { ms: ms, sc: maxScroll }, beacon);
  }
  setInterval(function () {
    flush(false);
  }, 15000);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
    else {
      lastTick = Date.now();
      active();
    }
  });
  window.addEventListener("pagehide", function () {
    flush(true);
  });

  // ---------- clicks ----------
  document.addEventListener(
    "click",
    function (e) {
      var el = e.target && e.target.closest && e.target.closest('a,button,[role="button"],[role="tab"],summary,[data-track],select,label');
      if (!el) return;
      // labels the page author set on purpose only; never the element's visible text
      var label = (el.getAttribute("data-track") || el.getAttribute("aria-label") || "").trim();
      var href = el.tagName === "A" ? linkTarget(el.getAttribute("href")) : "";
      tick();
      send("click", { l: label.slice(0, 80), u: href || undefined, sc: maxScroll, ms: engaged });
      engaged = 0;
    },
    true,
  );

  // ---------- sections read ----------
  function initSections() {
    if (!("IntersectionObserver" in window)) return;
    var heads = document.querySelectorAll("h2,[data-section]");
    if (heads.length < 2) heads = document.querySelectorAll("h2,h3");
    var seen = {};
    var timers = new Map();
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          var el = en.target;
          if (en.isIntersecting) {
            if (timers.has(el)) return;
            timers.set(
              el,
              setTimeout(function () {
                var label = (el.getAttribute("data-section") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 70);
                if (label && !seen[label] && document.visibilityState === "visible") {
                  seen[label] = 1;
                  send("section", { l: label, sc: maxScroll });
                }
                io.unobserve(el);
              }, 2500),
            );
          } else if (timers.has(el)) {
            clearTimeout(timers.get(el));
            timers.delete(el);
          }
        });
      },
      { threshold: 0.6 },
    );
    heads.forEach(function (h) {
      io.observe(h);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initSections);
  else initSections();
})();
