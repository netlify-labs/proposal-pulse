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

  // 1 when the visitor is in the EU/EEA, UK or Switzerland. /t.js fills this in from the
  // visitor's location; served any other way it stays 0.
  var EU = /*@eu*/ 0;

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

  // Turn off: stops tracking in this browser for this site and asks the collector to delete
  // what it already recorded. Used by the pill's "Turn off" and by any page URL with ?pp_optout.
  function optOut() {
    var old = store("localStorage", "_pp_v");
    store("localStorage", "_pp_off", "1");
    unstore("_pp_v");
    unstore("_pp_r");
    if (old) post(JSON.stringify({ k: "optout", h: location.hostname, sid: rid(), vid: old }));
  }
  if (q.has("pp_optout")) return optOut();
  if (noTrack || store("localStorage", "_pp_off") === "1") return;

  // Reading stats (time, scroll, sections, clicks, and a browser ID kept in localStorage) run
  // everywhere except the EU/UK/CH, where they wait for a "Sure" on the pill. Until then only
  // the open is reported: no browser or tab ID is stored, and nothing but the page and link ID
  // is sent (the server adds location and device).
  var choice = store("localStorage", "_pp_c"); // EU answer: "y" or "n"
  var full = !EU || choice === "y";
  var stopped = false;

  var vid, sid, r;
  // link ID from a unique link (?r=...); never an email address
  r = (q.get("r") || q.get("to") || "").slice(0, 60);
  if (r.indexOf("@") > -1) r = "";

  function startIds(openSid) {
    // The browser ID starts with its creation time (see rid). After 180 days, the same as visit
    // retention, it is replaced along with the saved link ID, so the browser counts as new.
    vid = store("localStorage", "_pp_v");
    var born = vid ? parseInt(vid.slice(0, 8), 36) : NaN;
    if (!vid || !(Date.now() - born < 180 * 864e5)) {
      vid = rid();
      unstore("_pp_r");
    }
    store("localStorage", "_pp_v", vid);
    sid = openSid || store("sessionStorage", "_pp_s") || rid();
    store("sessionStorage", "_pp_s", sid);
    if (r) store("localStorage", "_pp_r", r);
    else r = store("localStorage", "_pp_r") || "";
    if (r.indexOf("@") > -1) r = "";
  }
  if (full) startIds();
  else sid = vid = rid(); // this page load only, never stored

  // Netlify password page: only whether it was shown, never attempts or input
  var gate = document.title === "Password Protection" && !!document.querySelector('input[type="password"][name="password"]') ? 1 : 0;

  var queue = Promise.resolve();
  function base(k) {
    return { v: 2, k: k, h: location.hostname, p: location.pathname, sid: sid, vid: vid, r: r || undefined, gate: gate || undefined, o: full ? undefined : 1 };
  }
  function send(k, extra, beacon) {
    if (stopped) return;
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

  if (full) startFull();
  else startOpen();
  if (!EU && store("localStorage", "_pp_n") !== "1") pill("notice");
  if (EU && !choice) pill("ask");

  // ---------- open only (EU/UK/CH before a "Sure") ----------
  function startOpen() {
    send("view", {});
    // one "interact" once someone is clearly there, so link scanners don't count as opens
    var sent = false;
    function seen() {
      if (sent || full) return;
      sent = true;
      send("interact", {});
    }
    ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(function (t) {
      window.addEventListener(t, seen, { passive: true, capture: true, once: true });
    });
    setTimeout(function () {
      if (document.visibilityState === "visible") seen();
    }, 8000);
  }

  // ---------- the pill ----------
  function pill(mode) {
    function show() {
      var host = document.createElement("div");
      host.setAttribute("data-proposal-pulse", "");
      host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483000;margin:0;padding:0;border:0";
      var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
      var css =
        ".p{position:relative;display:inline-flex;align-items:center;gap:6px;background:#181a1c;color:#e9ebec;border-radius:999px;padding:4px 4px 4px 11px;" +
        "font:500 11px/1 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.1);white-space:nowrap}" +
        ".n{padding:6px 6px 6px 11px;gap:7px}.d{width:6px;height:6px;border-radius:50%;background:#32e6e2}.s{opacity:.35}" +
        "button{all:unset;cursor:pointer;font-weight:600;border-radius:999px;font-size:10.5px}" +
        "button:focus-visible{outline:2px solid #32e6e2;outline-offset:2px}" +
        ".y{background:#32e6e2;color:#0b1a1a;padding:5px 9px}.no{border:1px solid #4a4e52;padding:4px 8px}" +
        ".l{color:#32e6e2}.x{color:#8b9095;padding:0 3px;font-size:12px}" +
        ".q{display:inline-block;width:15px;height:15px;border:1px solid #5a5e62;color:#9aa0a5;font-size:9px;text-align:center;line-height:15px;box-sizing:border-box}" +
        ".t{position:absolute;right:0;bottom:36px;width:230px;background:#181a1c;color:#c9cdd0;border-radius:10px;padding:9px 11px;" +
        "font:400 11px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);white-space:normal}.t b{color:#fff}";
      var what = "Reading stats are time on page, scroll depth and clicks, sent to Netlify. No cookies, no ads.";
      root.innerHTML =
        "<style>" + css + "</style>" +
        (mode === "ask"
          ? '<div class="p" role="region" aria-label="Reading stats"><span>Share reading stats?</span>' +
            '<button class="q" aria-expanded="false" aria-label="What are reading stats?">?</button>' +
            '<button class="y">Sure</button><button class="no">No</button>' +
            '<div class="t" hidden><b>' + what.replace(" are", "</b> are") + " Without them, only the open, rough location and device type are noted.</div></div>"
          : '<div class="p n" role="region" aria-label="Reading stats" title="' + what + '"><span class="d"></span><span>Reading stats on</span>' +
            '<span class="s">·</span><button class="l">Turn off</button><button class="x" aria-label="Dismiss">✕</button></div>');
      document.body.appendChild(host);
      lift(host);
      function close() {
        host.remove();
      }
      function on(sel, fn) {
        var b = root.querySelector(sel);
        if (b) b.addEventListener("click", fn);
      }
      on(".q", function () {
        var t = root.querySelector(".t");
        t.hidden = !t.hidden;
        this.setAttribute("aria-expanded", String(!t.hidden));
      });
      on(".y", function () {
        store("localStorage", "_pp_c", "y");
        close();
        upgrade();
      });
      on(".no", function () {
        store("localStorage", "_pp_c", "n");
        close();
      });
      on(".l", function () {
        optOut();
        stopped = true;
        close();
      });
      on(".x", function () {
        store("localStorage", "_pp_n", "1");
        close();
      });
    }
    if (document.body) setTimeout(show, 1200);
    else document.addEventListener("DOMContentLoaded", function () {
      setTimeout(show, 1200);
    });
  }
  // keep clear of the page's own fixed controls (slide arrows, chat bubbles) in that corner
  function lift(host) {
    try {
      var els = document.elementsFromPoint(window.innerWidth - 24, window.innerHeight - 24);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el === host || el === document.body || el === document.documentElement) continue;
        for (var a = el; a && a !== document.body; a = a.parentElement) {
          var pos = getComputedStyle(a).position;
          if (pos === "fixed" || pos === "sticky") {
            var box = a.getBoundingClientRect();
            // only small corner controls; a full-screen slide container doesn't count
            if (box.height < window.innerHeight / 3 && box.width < window.innerWidth / 2) {
              host.style.bottom = Math.max(12, window.innerHeight - box.top + 8) + "px";
            }
            return;
          }
        }
      }
    } catch (e) {}
  }
  // "Sure" in the EU: record the consent, then turn the open into a full visit in place
  function upgrade() {
    full = true;
    startIds(sid);
    send("consent", {});
    startFull(true);
  }

  // ---------- full tracking ----------
  function startFull(upgraded) {
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
    var interacted = !!upgraded; // tapping "Sure" already counts
    if (upgraded) send("interact", {});
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
        if (!el || el.closest("[data-proposal-pulse]")) return;
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
  }
})();
