// Rehearsal and test stand-in for Firebase: the whole game lives in this
// browser's localStorage and every tab on this computer sees it. Loaded only
// when the address has ?local in it. ?local&uid=name pins this tab's device id.
// It also enforces the one rule players notice: answers lock with their round.
(() => {
  const KEY = "gsab-local-db";
  const chan = "BroadcastChannel" in window ? new BroadcastChannel(KEY) : null;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let db = read();
  const watchers = new Set();
  const parts = p => String(p || "").split("/").filter(Boolean);
  const getAt = p => parts(p).reduce((o, k) => (o == null ? null : (o[k] === undefined ? null : o[k])), db);
  function setAt(p, v) {
    const ks = parts(p);
    if (!ks.length) { db = v == null ? {} : JSON.parse(JSON.stringify(v)); return; }
    let o = db;
    for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
    const last = ks[ks.length - 1];
    if (v == null) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
  }
  function notify() {
    for (const w of watchers) {
      const j = JSON.stringify(getAt(w.p));
      if (j !== w.last) { w.last = j; w.cb(j == null || j === "null" ? null : JSON.parse(j)); }
    }
  }
  function changed() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} if (chan) chan.postMessage(1); notify(); }
  if (chan) chan.onmessage = () => { db = read(); notify(); };
  window.addEventListener("storage", e => { if (e.key === KEY) { db = read(); notify(); } });
  function guard(p) {
    const m = /^answers\/[^/]+\/(\d+)\//.exec(p);
    if (m && getAt(`live/locked/${m[1]}`) === true) throw new Error("PERMISSION_DENIED: round locked");
  }
  const pinned = new URLSearchParams(location.search).get("uid");
  window.GSAB_BACKEND = {
    async init() {
      if (pinned) return pinned;
      let id = null;
      try { id = sessionStorage.getItem("gsab-local-uid"); } catch {}
      if (!id) { id = "u" + Math.random().toString(16).slice(2, 10); try { sessionStorage.setItem("gsab-local-uid", id); } catch {} }
      return id;
    },
    watch(p, cb) {
      const w = { p, cb, last: undefined };
      watchers.add(w);
      setTimeout(() => { if (!watchers.has(w)) return; const v = getAt(p); w.last = JSON.stringify(v); cb(v); });
      return () => watchers.delete(w);
    },
    // Every write starts from the latest copy in localStorage, so tabs writing at once don't erase each other.
    async set(p, v) { db = read(); guard(p); setAt(p, v); changed(); },
    async update(p, obj) {
      db = read();
      const paths = Object.keys(obj).map(k => parts(p).concat(parts(k)).join("/"));
      paths.forEach(guard);
      paths.forEach((path, i) => setAt(path, Object.values(obj)[i]));
      changed();
    },
    async remove(p) { db = read(); setAt(p, null); changed(); },
    async get(p) { return getAt(p); },
    now: () => Date.now(),
  };
})();
