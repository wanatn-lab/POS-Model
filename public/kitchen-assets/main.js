import { createStore } from "./logic.js";
import { createView } from "./view.js";

const TIMEOUT_MS = 8000;

async function request(path, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, { cache: "no-store", ...options, signal: ctrl.signal });
    if (res.status === 410) { store.stop && store.stop(); throw new Error("kitchen screen is turned off"); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  get: () => request("/api/kitchen"),
  post: async (body) => {
    const out = await request("/api/kitchen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!out || out.ok !== true) throw new Error("rejected");
    return out;
  },
};

let view;
const store = createStore({
  api,
  onChange: () => view && view.render(store.model()),
  onError: (message) => view && view.toast(message),
});

view = createView(document, (a) => {
  switch (a.type) {
    case "toggle": {
      // tap circle: pending <-> done (look at the current state in the model)
      const item = findItem(a.lineId);
      if (item) store.setItems([a.lineId], item.st === "p" ? "d" : "p");
      break;
    }
    case "cancel": store.setItems([a.lineId], "c"); break;
    case "undo": store.setItems([a.lineId], "p"); break;
    case "finish": store.setItems(a.lineIds, "d"); break;
    case "rush": store.setRush(a.cardKey, a.rush); break;
    case "reorder": store.reorder(a.moved, a.target); break;
    case "undo-done": store.undoDone(a.cardKey); break;
  }
});

function findItem(lineId) {
  for (const t of store.model().tickets) for (const i of t.items) if (i.lineId === lineId) return i;
  return null;
}

// ---- keep the screen awake -------------------------------------------------
let lock = null;
async function keepAwake() {
  if (!("wakeLock" in navigator)) { view.setWakeState("unsupported"); return; }
  if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
  try {
    lock = await navigator.wakeLock.request("screen");
    view.setWakeState("on");
    lock.addEventListener("release", () => view.setWakeState("off"));
  } catch (err) {
    view.setWakeState("off");
  }
}
document.getElementById("wake").addEventListener("click", keepAwake);
document.addEventListener("pointerdown", () => { if (!lock || lock.released) keepAwake(); }, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); store.pollNow(); }
});

// ---- connection --------------------------------------------------------------
window.addEventListener("online", () => store.pollNow());
window.addEventListener("offline", () => store.markOffline());
setInterval(() => { store.tick(); view.tick(store.model()); }, 1000);

store.start();
keepAwake();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/kitchen-sw.js", { scope: "/kitchen" }).catch(() => {});
}
