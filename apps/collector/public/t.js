/* Proposal Pulse tracker: cookieless engagement beacon for shared sites. */
(function () {
  "use strict";
  if (window.__proposalPulse) return;
  window.__proposalPulse = 1;
  try {
    if (navigator.webdriver) return;
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
  function rid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  }
  var vid = store("localStorage", "_pp_v") || rid();
  store("localStorage", "_pp_v", vid);
  var sid = store("sessionStorage", "_pp_s") || rid();
  store("sessionStorage", "_pp_s", sid);

  var q = new URLSearchParams(location.search);
  var r = (q.get("r") || q.get("to") || "").slice(0, 60);
  if (r) store("localStorage", "_pp_r", r);
  else r = store("localStorage", "_pp_r") || "";

  var isGate = document.title === "Password Protection" && !!document.querySelector('input[type="password"][name="password"]');
  var gate = isGate ? (document.querySelector(".alert-box") ? 2 : 1) : 0;

  var queue = Promise.resolve();
  function base(k) {
    return { k: k, h: location.hostname, p: location.pathname, sid: sid, vid: vid, r: r || undefined, gate: gate || undefined };
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
      return fetch(END, { method: "POST", body: body, keepalive: true, mode: "cors", credentials: "omit", headers: { "content-type": "text/plain" } }).catch(function () {});
    });
  }

  send("view", { ref: document.referrer || undefined, ti: document.title });
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
      var label = (el.getAttribute("data-track") || el.getAttribute("aria-label") || el.innerText || el.title || el.getAttribute("href") || "").trim();
      var href = el.tagName === "A" ? el.href || el.getAttribute("href") || "" : "";
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
