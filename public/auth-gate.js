/* Shared login gate for the staff pages (admin.html, table-status.html).
   - If the server answers 401 to any /api/ call, a login box appears (staff or owner password).
   - If it answers 403 (signed in, but this action needs the owner), the same box offers an owner login.
   - On success the page reloads. The password is only ever sent to /api/auth/login. */
(function () {
  var realFetch = window.fetch.bind(window);
  var box = null;

  function isProtectedApi(input) {
    try {
      var url = new URL(typeof input === "string" ? input : input.url, location.href);
      return url.origin === location.origin && url.pathname.indexOf("/api/") === 0 && url.pathname.indexOf("/api/auth/") !== 0;
    } catch (error) {
      return false;
    }
  }

  function el(tag, style, text) {
    var node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
  }

  function show(reason) {
    if (box) {
      box.message.textContent = reason === "forbidden" ? "การทำรายการนี้ต้องเข้าสู่ระบบเป็นเจ้าของ" : "กรุณาเข้าสู่ระบบ";
      box.close.style.display = reason === "forbidden" ? "inline-block" : "none";
      box.wrap.style.display = "flex";
      return;
    }
    var wrap = el("div", "position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:inherit");
    var card = el("div", "background:#fff;color:#222;border-radius:12px;padding:20px;width:min(92vw,340px);display:flex;flex-direction:column;gap:10px");
    var title = el("div", "font-size:18px;font-weight:700", "เข้าสู่ระบบ");
    var message = el("div", "font-size:14px;color:#555");
    var role = el("select", "padding:10px;font-size:16px");
    [["staff", "พนักงาน"], ["owner", "เจ้าของ"]].forEach(function (pair) {
      var option = el("option", "", pair[1]);
      option.value = pair[0];
      role.appendChild(option);
    });
    var password = el("input", "padding:10px;font-size:16px");
    password.type = "password";
    password.placeholder = "รหัสผ่าน";
    password.autocomplete = "current-password";
    var error = el("div", "font-size:13px;color:#c0392b;min-height:16px");
    var go = el("button", "padding:10px;font-size:16px;border:0;border-radius:8px;background:#1f7a3f;color:#fff", "เข้าสู่ระบบ");
    var close = el("button", "padding:8px;font-size:14px;border:0;background:transparent;color:#555;display:none", "ปิด");

    var messages = {
      bad_credentials: "รหัสผ่านไม่ถูกต้อง",
      too_many_attempts: "ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาที",
      not_configured: "ระบบยังไม่ได้ตั้งรหัสผ่าน กรุณาติดต่อผู้ดูแล",
      bad_request: "ข้อมูลไม่ครบ",
    };
    function submit() {
      error.textContent = "";
      go.disabled = true;
      realFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: role.value, password: password.value }),
      })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (data) {
            if (response.ok) { location.reload(); return; }
            error.textContent = messages[data.error] || "เข้าสู่ระบบไม่สำเร็จ";
            go.disabled = false;
          });
        })
        .catch(function () {
          error.textContent = "เชื่อมต่อไม่ได้ ลองใหม่อีกครั้ง";
          go.disabled = false;
        });
    }
    go.onclick = submit;
    password.onkeydown = function (event) { if (event.key === "Enter") submit(); };
    close.onclick = function () { wrap.style.display = "none"; };

    [title, message, role, password, error, go, close].forEach(function (node) { card.appendChild(node); });
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    box = { wrap: wrap, message: message, close: close };
    show(reason);
  }

  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (response) {
      if (isProtectedApi(input)) {
        if (response.status === 401) show("login");
        else if (response.status === 403) show("forbidden");
      }
      return response;
    });
  };

  // Ask once on load, so that when the server enforces access control a signed-out page shows the
  // box immediately instead of failing quietly. When enforcement is off (or only logging) nothing
  // is blocked, so the page opens exactly as it did before: the box then appears only if a
  // protected request really comes back 401/403 (handled by the fetch wrapper above).
  function check() {
    realFetch("/api/auth/me", { cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.mode === "enforce" && data.role !== "staff" && data.role !== "owner") show("login");
      })
      .catch(function () {});
  }
  if (document.body) check();
  else document.addEventListener("DOMContentLoaded", check);
})();
