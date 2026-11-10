// Shop opening state for the pages that refresh themselves (table status, counter print, admin).
//
// The server decides (weekly schedule + manual open/close, see api/shop-status.js). This script
// only remembers the last answer so the pages can ask `isShopOpen()` before every automatic
// refresh without any network call. While the shop is open it asks the server again only when the
// next change is due; while it is closed it asks once every 5 minutes, so a manual "open now"
// pressed on another device is noticed. Outside opening hours the pages load once and stop
// repeating requests, which keeps the daily request quota for real work.
//
// Until the first answer arrives the shop counts as open, so a page never starts blank.
(function () {
  var TIME_ZONE = "Asia/Bangkok";
  var CLOSED_RECHECK_MS = 5 * 60 * 1000;
  var MIN_GAP_MS = 20 * 1000;
  var TICK_MS = 30 * 1000;

  var state = null; // last server answer
  var lastSyncAt = 0;
  var inFlight = null;

  function notify() {
    try {
      document.dispatchEvent(new CustomEvent("shop-state-change", { detail: state }));
    } catch (e) {
      /* no DOM (tests) */
    }
  }

  function remember(data) {
    if (!data || data.ok !== true || typeof data.open !== "boolean") return null;
    state = data;
    lastSyncAt = Date.now();
    notify();
    return data;
  }

  function readJson(response) {
    return response && response.ok ? response.json() : null;
  }

  // Latest known server answer (null until the first one arrives).
  window.shopStatus = function () {
    return state;
  };

  // true while the shop is open (use this before every automatic refresh)
  window.isShopOpen = function (date) {
    if (!state) return true;
    var at = (date || new Date()).getTime();
    if (state.changeAt && at >= state.changeAt) return !state.open; // the next change has passed
    return state.open;
  };

  // Ask the server now. Calls made while one is already running share it.
  window.syncShopStatus = function () {
    if (inFlight) return inFlight;
    inFlight = fetch("/api/shop-status", { cache: "no-store" })
      .then(readJson)
      .then(remember)
      .catch(function () {
        return null;
      })
      .then(function (data) {
        inFlight = null;
        return data;
      });
    return inFlight;
  };

  function post(body) {
    return fetch("/api/shop-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(
        function (data) {
          if (!response.ok || !data || data.ok !== true) {
            var error = new Error((data && (data.message || data.error)) || "save failed");
            error.code = data && data.error;
            throw error;
          }
          return remember(data);
        },
        function () {
          throw new Error("save failed");
        }
      );
    });
  }

  // Staff: open outside the schedule (hours optional before closing time) / close early / go back to the schedule.
  window.shopOpenNow = function (hours) {
    var body = { action: "open-now" };
    if (hours) body.hours = hours;
    return post(body);
  };
  window.shopCloseNow = function () {
    return post({ action: "close-now" });
  };
  window.shopClearOverride = function () {
    return post({ action: "clear-override" });
  };
  // Owner: save the weekly schedule.
  window.shopSaveSchedule = function (schedule) {
    return post({ action: "set-schedule", schedule: schedule });
  };

  function clock(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var parts = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .forEach(function (p) {
        parts[p.type] = p.value;
      });
    var time = parts.hour + ":" + parts.minute;
    var today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
    var target = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
    return target === today ? time : parts.day + "/" + parts.month + " " + time;
  }
  window.shopClock = clock;

  // One line describing the state, for banners and the admin button ("" is never returned).
  window.shopStatusText = function () {
    if (!state) return "";
    if (state.open) {
      var until = state.closesAt ? " (ถึง " + clock(state.closesAt) + ")" : "";
      return (state.reason === "manual-open" ? "เปิดร้านพิเศษ" : "ร้านเปิดอยู่") + until;
    }
    var next = state.opensAt ? " — เปิดอีกครั้ง " + clock(state.opensAt) : "";
    return (state.reason === "manual-closed" ? "ปิดร้านชั่วคราว" : "ร้านปิดอยู่") + next;
  };

  // Text for the "auto refresh is off" banner ("" while the shop is open).
  window.shopClosedNotice = function (date) {
    if (window.isShopOpen(date)) return "";
    return window.shopStatusText() + " — หน้านี้หยุดอัปเดตอัตโนมัติ รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด";
  };

  // Any element marked data-shop-closed-notice shows that text while the shop is closed.
  // Local only (no network): re-checked every 30 seconds and whenever the state changes.
  function renderNotices() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;
    var text = window.shopClosedNotice();
    var nodes = document.querySelectorAll("[data-shop-closed-notice]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = text;
      nodes[i].style.display = text ? "block" : "none";
    }
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("shop-state-change", renderNotices);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderNotices);
    else renderNotices();
  }

  function tick() {
    renderNotices();
    if (!state) {
      window.syncShopStatus();
      return;
    }
    var since = Date.now() - lastSyncAt;
    if (since < MIN_GAP_MS) return;
    if (state.changeAt && Date.now() >= state.changeAt) window.syncShopStatus(); // a scheduled change is due
    else if (!state.open && since >= CLOSED_RECHECK_MS) window.syncShopStatus(); // notice a manual "open now"
  }

  window.syncShopStatus();
  setInterval(tick, TICK_MS);
})();
