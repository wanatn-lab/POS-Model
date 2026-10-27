// Shop opening hours for automatic refreshing.
// Pages that poll the server (table status, counter print, admin panels) only ask for
// fresh data while the shop is open, so the database command quota is not used up.
//
// Rules (Bangkok time):
//   - open 11:20 (inclusive) to 21:00 (exclusive)
//   - closed all day on Mondays, unless someone pressed "เปิดพิเศษวันนี้" in the admin page
//     (the server remembers that date in /api/shop-status; it expires by itself at midnight)
//
// Outside these hours pages still load once when opened, but stop the repeating requests.
// On Mondays each page asks /api/shop-status every 5 minutes (1 command) so it notices
// when a special opening is switched on or off.
(function () {
  var OPEN_MINUTE = 11 * 60 + 20; // 11:20
  var CLOSE_MINUTE = 21 * 60; // 21:00
  var SYNC_FROM_MINUTE = 10 * 60; // on Mondays start checking for a special opening from 10:00
  var CLOSED_WEEKDAY = "Mon";
  var TIME_ZONE = "Asia/Bangkok";
  var SYNC_MS = 5 * 60 * 1000;

  var specialOpenDate = null; // "YYYY-MM-DD" (Bangkok) or null

  function bangkokParts(date) {
    var parts = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .forEach(function (p) {
        parts[p.type] = p.value;
      });
    return {
      weekday: parts.weekday,
      date: parts.year + "-" + parts.month + "-" + parts.day,
      minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    };
  }

  function notify() {
    try {
      document.dispatchEvent(new CustomEvent("shop-special-change", { detail: { date: specialOpenDate } }));
    } catch (e) {
      /* no DOM (tests) */
    }
  }

  // true while the shop is open (use this before every automatic refresh)
  window.isShopOpen = function (date) {
    var p = bangkokParts(date || new Date());
    if (p.minute < OPEN_MINUTE || p.minute >= CLOSE_MINUTE) return false;
    if (p.weekday === CLOSED_WEEKDAY && specialOpenDate !== p.date) return false;
    return true;
  };

  // "closed Monday" status for the admin button: { closedDay, special }
  window.shopDayInfo = function (date) {
    var p = bangkokParts(date || new Date());
    return {
      closedDay: p.weekday === CLOSED_WEEKDAY,
      special: p.weekday === CLOSED_WEEKDAY && specialOpenDate === p.date,
    };
  };

  window.setShopSpecialOpenDate = function (date) {
    var next = date || null;
    if (next === specialOpenDate) return;
    specialOpenDate = next;
    notify();
  };

  function readStatus(response) {
    return response && response.ok ? response.json() : null;
  }

  // Ask the server whether today was switched to a special opening.
  window.syncShopSpecial = function () {
    return fetch("/api/shop-status", { cache: "no-store" })
      .then(readStatus)
      .then(function (data) {
        if (data) window.setShopSpecialOpenDate(data.specialOpenDate);
        return data;
      })
      .catch(function () {
        return null;
      });
  };

  // Admin button: open (true) or cancel (false) today's special opening.
  window.setShopSpecialToday = function (open) {
    return fetch("/api/shop-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: open ? "open" : "cancel" }),
    })
      .then(readStatus)
      .then(function (data) {
        if (!data) throw new Error("save failed");
        window.setShopSpecialOpenDate(data.specialOpenDate);
        return data;
      });
  };

  // Text for the "auto refresh is off" banner ("" while the shop is open).
  window.shopClosedNotice = function (date) {
    if (window.isShopOpen(date)) return "";
    var info = window.shopDayInfo(date);
    var reason = info.closedDay && !info.special ? "วันนี้ร้านปิด (วันจันทร์)" : "นอกเวลาเปิดร้าน (11:20-21:00)";
    return reason + " — หน้านี้หยุดอัปเดตอัตโนมัติ รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด";
  };

  // Any element marked data-shop-closed-notice shows that text while the shop is closed.
  // Local only (no network): re-checked every 30 seconds and when the special opening changes.
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
    document.addEventListener("shop-special-change", renderNotices);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderNotices);
    else renderNotices();
  }
  setInterval(renderNotices, 30 * 1000);

  function syncIfMonday() {
    var p = bangkokParts(new Date());
    if (p.weekday === CLOSED_WEEKDAY && p.minute >= SYNC_FROM_MINUTE && p.minute < CLOSE_MINUTE) {
      window.syncShopSpecial();
    }
  }

  syncIfMonday();
  setInterval(syncIfMonday, SYNC_MS);
})();
