// Maroon Trivia Night.
//
// Every device shares one room in a Firebase Realtime Database (rules in
// database.rules.json):
//   - the trivia master logs in with a code, which unlocks the questions
//     (see set-host-codes.py), moves the game along and judges answers;
//   - players join with a team name and type their answers on their phones;
//   - an optional big-screen view (#audience) shows the current slide.
// Adding ?local to the address swaps Firebase for tests/local-backend.js, which
// shares the game between tabs on one computer (rehearsal mode).
(() => {
"use strict";

const QUESTION_SECONDS = 45;
const SESSION_KEY = "gsab-trivia-host-key";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LOCK = window.GSAB_LOCKED;
if (!LOCK || !LOCK.room) {
  $("stage").innerHTML = `<p class="lede">locked.js is missing or out of date. Run set-host-codes.py to rebuild it.</p>`;
  return;
}
const ROUNDS = LOCK.rounds;          // public: name, count
let QS = null;                       // trivia master only: per round, [question, answer]

/* ---------- Unlocking ---------- */
const enc = new TextEncoder();
const hexToBytes = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const bytesToHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const sha256Hex = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

async function keyFromCode(code) {
  const norm = code.trim().toLowerCase();
  if (!norm) return null;
  const base = await crypto.subtle.importKey("raw", enc.encode(norm), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(LOCK.salt), iterations: LOCK.iterations, hash: "SHA-256" }, base, 256));
  for (const blob of LOCK.keys) {
    const k = hexToBytes(blob).map((x, i) => x ^ bits[i]);
    if ((await sha256Hex(concat(k, enc.encode("gsab-check")))).slice(0, 16) === LOCK.check) return bytesToHex(k);
  }
  return null;
}

async function openQuestions(keyHex) {
  const raw = Uint8Array.from(atob(LOCK.data), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  const data = JSON.parse(new TextDecoder().decode(plain));
  return data.rounds.map(r => r.questions.map(q => [q.q, q.answer]));
}

// Proves to the database that this device knows a trivia master code, without sending the code.
const hostTokenFor = keyHex => sha256Hex(concat(hexToBytes(keyHex), enc.encode("gsab-host-token")));

window.GSAB_TEST = { keyFromCode, openQuestions };

/* ---------- Game sequence ---------- */
const SEQ = [{ t: "welcome" }];
ROUNDS.forEach((r, ri) => {
  SEQ.push({ t: "round", r: ri });
  for (let qi = 0; qi < r.count; qi++) SEQ.push({ t: "q", r: ri, q: qi });
  SEQ.push({ t: "answers", r: ri });
  for (let qi = 0; qi < r.count; qi++) SEQ.push({ t: "a", r: ri, q: qi });
  SEQ.push({ t: "scores", r: ri });
});
SEQ.push({ t: "final" });

/* ---------- Database connection ---------- */
const AUDIENCE = location.hash === "#audience";
let backend = null, uid = null, backendError = null, connecting = null;
let offline = false;   // Firebase isn't set up: the game runs on this computer only

// Until firebase-config.js is filled in, the trivia master and the big-screen
// screen fall back to the rehearsal backend so a one-computer game still works.
function loadLocalBackend() {
  if (window.GSAB_BACKEND) return Promise.resolve(window.GSAB_BACKEND);
  return new Promise((res, rej) => {
    const el = document.createElement("script");
    el.src = "tests/local-backend.js";
    el.onload = () => window.GSAB_BACKEND ? res(window.GSAB_BACKEND) : rej(new Error("no-local-backend"));
    el.onerror = () => rej(new Error("no-local-backend"));
    document.head.appendChild(el);
  });
}

function connect(allowLocal = AUDIENCE) {
  return connecting ||= (async () => {
    let b = window.GSAB_BACKEND;
    if (!b) {
      try { b = await firebaseBackend(); }
      catch (e) {
        if (e.message !== "not-configured" || !allowLocal) throw e;
        b = await loadLocalBackend(); offline = true;
      }
    }
    uid = await b.init();
    backend = b; backendError = null;
    startWatches();
    return b;
  })().catch(e => { connecting = null; throw e; });
}

async function firebaseBackend() {
  const cfg = window.GSAB_FIREBASE;
  if (!cfg || !cfg.apiKey || /PASTE/.test(cfg.apiKey + cfg.databaseURL)) throw new Error("not-configured");
  const base = "https://www.gstatic.com/firebasejs/12.3.0/";
  const [{ initializeApp }, A, D] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-database.js")]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app), db = D.getDatabase(app);
  let offset = 0;
  D.onValue(D.ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; });
  const at = p => D.ref(db, `trivia/${LOCK.room}` + (p ? "/" + p : ""));
  return {
    async init() {
      await auth.authStateReady();
      if (!auth.currentUser) await A.signInAnonymously(auth);
      return auth.currentUser.uid;
    },
    watch: (p, cb) => D.onValue(at(p), s => cb(s.val()), err => console.warn("watch", p, err.message)),
    set: (p, v) => D.set(at(p), v),
    update: (p, v) => D.update(at(p), v),
    remove: p => D.remove(at(p)),
    get: p => D.get(at(p)).then(s => s.val()),
    now: () => Date.now() + offset,
  };
}
const now = () => backend ? backend.now() : Date.now();

/* ---------- Shared game state ---------- */
// "live" is written only by trivia masters and read by everyone.
const restTimer = () => ({ running: false, end: 0, left: QUESTION_SECONDS * 1000 });
const emptyLive = () => ({ step: 0, slide: { t: "welcome" }, timer: restTimer(), released: {}, revealed: {}, locked: {}, standings: [], v: 0 });
const list = v => Array.isArray(v) ? v : Object.values(v || {});
function normLive(v) {
  const l = Object.assign(emptyLive(), v || {});
  for (const k of ["released", "revealed", "locked"]) l[k] = l[k] || {};
  l.standings = list(l.standings).filter(Boolean).map(x => ({ name: x.name, rounds: list(x.rounds).map(n => n || 0), total: x.total || 0 }));
  l.step = Math.min(Math.max(0, l.step | 0), SEQ.length - 1);
  return l;
}
let live = emptyLive(), liveLoaded = false;
const get2 = (o, r, q) => (o && o[r] != null) ? o[r][q] : undefined;

// Trivia master only: every team, answer and mark. Keyed by the team's device id.
let teams = {}, answers = {}, marks = {};
let isHost = false, hostWatches = [];

// This device as a player.
let myName = null, myAnswers = {}, myMarks = {};

/* ---------- Timer ---------- */
function timeLeft() { const t = live.timer || restTimer(); return Math.max(0, t.running ? t.end - now() : t.left); }
function paintTimer() {
  const left = timeLeft();
  document.querySelectorAll("[data-timer]").forEach(el => {
    el.classList.toggle("low", left < 10000);
    el.querySelector(".fill").style.transform = `scaleX(${left / (QUESTION_SECONDS * 1000)})`;
    el.querySelector(".secs").innerHTML = left > 0 ? Math.ceil(left / 1000) + "s" : `<span class="done">Time's up</span>`;
  });
  if (isHost) $("tmr").textContent = live.timer.running && left > 0 ? "Pause timer" : left > 0 ? "Resume timer" : "Restart timer";
}
setInterval(paintTimer, 200);
const timerHTML = () => `<div class="timer" data-timer><div class="track"><div class="fill"></div></div><span class="secs"></span></div>`;

/* ---------- Scores ---------- */
const teamScore = (tid, r) => list(marks[tid] && marks[tid][r]).filter(x => x === true).length;
function computeStandings() {
  return Object.entries(teams).filter(([, t]) => t && t.name).map(([tid, t]) => {
    const rounds = ROUNDS.map((_, r) => teamScore(tid, r));
    return { name: t.name, rounds, total: rounds.reduce((a, b) => a + b, 0) };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
function standingsTable(upTo, highlight) {
  if (!live.standings.length) return `<p class="lede">No teams have joined yet.</p>`;
  const rows = live.standings.map(x => ({ ...x, sum: x.rounds.slice(0, upTo + 1).reduce((a, b) => a + b, 0) })).sort((a, b) => b.sum - a.sum);
  const top = rows[0].sum, cols = ROUNDS.slice(0, upTo + 1);
  let rank = 0, prev = null;
  return `<div class="tbl-wrap"><table class="standings">
    <thead><tr><th>#</th><th>Team</th>${cols.map((_, i) => `<th class="r">R${i + 1}</th>`).join("")}<th class="r">Total</th></tr></thead>
    <tbody>${rows.map((x, i) => {
      if (x.sum !== prev) { rank = i + 1; prev = x.sum; }
      const cls = [x.sum === top && top > 0 ? "lead" : "", highlight && x.name === highlight ? "me" : ""].join(" ");
      return `<tr class="${cls}"><td>${rank}</td><td>${esc(x.name)}</td>${cols.map((_, r) => `<td class="r">${x.rounds[r] || 0}</td>`).join("")}<td class="r"><b>${x.sum}</b></td></tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

/* ---------- Big screen / trivia master stage ---------- */
const joinUrl = () => location.origin + location.pathname;
function qrSVG() {
  if (!window.qrcode) return "";
  try { const qr = window.qrcode(0, "M"); qr.addData(joinUrl()); qr.make(); return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch { return ""; }
}

function renderStage() {
  const s = live.slide || { t: "welcome" }, st = $("stage"), n = ROUNDS.length;
  const R = s.r !== undefined ? ROUNDS[s.r] : null;
  const waiting = `<p class="wait">Waiting for the trivia master…</p>`;
  if (s.t === "welcome") {
    st.innerHTML = `
      <p class="eyebrow">${n} rounds of ${ROUNDS[0].count}</p>
      <h2 class="display">Welcome</h2>
      <div class="join">
        <div class="join-text">
          <p class="lede">Grab a phone, open the site and type your team name. You'll answer every question there.</p>
          <p class="join-url">${esc(joinUrl().replace(/^https?:\/\//, ""))}</p>
        </div>
        <div class="qr" aria-hidden="true">${qrSVG()}</div>
      </div>
      <ol class="roundlist">${ROUNDS.map((r, i) => `<li><span class="num">Round ${i + 1}</span><strong>${esc(r.name)}</strong></li>`).join("")}</ol>
      ${live.standings.length ? `<p class="lede">Teams: ${live.standings.map(t => esc(t.name)).join(", ")}</p>` : ""}
      ${isHost ? `<p class="wait">Press Next when everyone's ready.</p>` : waiting}`;
  } else if (s.t === "round") {
    st.innerHTML = `
      <p class="eyebrow">Round ${s.r + 1} of ${n}</p>
      <h2 class="display huge">${esc(R.name)}</h2>
      <p class="lede">${R.count} questions, ${QUESTION_SECONDS} seconds each.</p>`;
  } else if (s.t === "q" || s.t === "a") {
    const reveal = s.t === "a";
    if (!s.text) { st.innerHTML = `<p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}</p>${waiting}`; return; }
    st.innerHTML = `
      <div class="qhead">
        <div><p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}${reveal ? " · Answers" : ""}</p><div class="qnum">${reveal ? "Answer" : "Question"} ${s.q + 1} of ${R.count}</div></div>
        ${reveal ? "" : timerHTML()}
      </div>
      <h2 class="question">${esc(s.text)}</h2>
      ${reveal ? `<p class="answer"><span class="sr">Answer: </span>${esc(s.answer)}</p>` : ""}`;
  } else if (s.t === "answers") {
    st.innerHTML = `
      <p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}</p>
      <h2 class="display">Answers</h2>
      <p class="lede">Round ${s.r + 1} answers are locked in.</p>`;
  } else if (s.t === "scores") {
    st.innerHTML = `
      <p class="eyebrow">Standings after round ${s.r + 1} of ${n}</p>
      <h2 class="display">Standings</h2>
      ${standingsTable(s.r)}`;
  } else if (s.t === "final") {
    const rows = live.standings, top = rows.length ? rows[0].total : 0;
    const winners = rows.filter(x => x.total === top && top > 0).map(x => esc(x.name));
    st.innerHTML = `
      <h2 class="display">Final standings</h2>
      ${winners.length ? `<p class="winner">${winners.length > 1 ? "Tied for first" : "Winner"}: ${winners.join(" & ")}, ${top} points</p>` : ""}
      ${standingsTable(n - 1)}`;
  }
  paintTimer();
}

/* ---------- Player view ---------- */
let plRound = 0, plSig = "", lastSlideKey = "", editingName = false;
const drafts = {}, saveTimers = {};
const aKey = (r, q) => `${r}-${q}`;
const isReleased = (r, q) => get2(live.released, r, q) != null;
const releasedIn = r => Array.from({ length: ROUNDS[r].count }, (_, q) => q).filter(q => isReleased(r, q));

function notReadyHTML() {
  return backendError && backendError.message === "not-configured"
    ? `<p class="lede">The trivia night isn't open yet. Check back when the event starts.</p>`
    : `<p class="lede">Couldn't connect to the game. Check your internet connection and reload the page.</p>`;
}

function renderPlayer() {
  const box = $("player");
  if (backendError) { box.innerHTML = notReadyHTML(); plSig = "err"; return; }
  if (!backend || !liveLoaded) { if (plSig !== "wait") box.innerHTML = `<p class="wait">Connecting…</p>`; plSig = "wait"; return; }
  if (!myName || editingName) return renderJoin();

  const s = live.slide || { t: "welcome" };
  const slideKey = `${s.t}-${s.r}-${s.q}`;
  if (slideKey !== lastSlideKey) {
    if (s.r !== undefined) plRound = s.r;
    else if (s.t === "final") plRound = ROUNDS.length - 1;
  }
  const sig = JSON.stringify([myName, plRound, slideKey, live.released[plRound], live.revealed[plRound], !!live.locked[plRound],
    myMarks[plRound], ["scores", "final"].includes(s.t) ? live.standings : 0, ROUNDS.map((_, r) => releasedIn(r).length > 0)]);
  if (sig !== plSig) {
    plSig = sig;
    const focus = document.activeElement && document.activeElement.id, sel = focus && document.activeElement.selectionStart;
    box.innerHTML = playerHTML(s);
    if (focus && $(focus) && !$(focus).disabled) { $(focus).focus(); try { $(focus).setSelectionRange(sel, sel); } catch {} }
  }
  syncAnswerInputs();
  paintTimer();
  if (slideKey !== lastSlideKey) {
    const fresh = s.t === "q" && lastSlideKey !== "";
    lastSlideKey = slideKey;
    const active = document.activeElement;
    if (fresh && !(active && active.classList.contains("pl-in"))) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderJoin() {
  if (plSig === "join") return;
  plSig = "join";
  $("player").innerHTML = `
    <form class="joincard" id="joinForm" autocomplete="off">
      <p class="eyebrow">${myName ? "Change your team name" : "Join the game"}</p>
      <h2 class="display">${myName ? "Rename your team" : "What's your team called?"}</h2>
      <p class="lede">Use one phone per team. You'll type your answers here as each question comes up.</p>
      <div class="field">
        <label for="teamNameIn">Team name</label>
        <input class="input big" id="teamNameIn" maxlength="40" required value="${esc(myName || "")}">
      </div>
      <p class="err" id="joinErr" hidden></p>
      <div class="row">
        <button class="btn" type="submit" id="joinGo">${myName ? "Save name" : "Join"}</button>
        ${myName ? `<button class="btn ghost" type="button" id="joinCancel">Cancel</button>` : ""}
      </div>
    </form>`;
  $("teamNameIn").focus();
}

function statusHTML(s) {
  const R = s.r !== undefined ? ROUNDS[s.r] : null;
  switch (s.t) {
    case "welcome": return `<p class="pl-say">You're in. The game starts when the trivia master is ready.</p>`;
    case "round": return `<p class="eyebrow">Round ${s.r + 1} of ${ROUNDS.length}</p><p class="pl-say">${esc(R.name)} is starting.</p>`;
    case "q": return `<div class="pl-live"><p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)} · Question ${s.q + 1} of ${R.count}</p>${timerHTML()}</div>`;
    case "answers": return `<p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}</p><p class="pl-say">Pencils down. Your round ${s.r + 1} answers are locked in.</p>`;
    case "a": return `<p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)} · Answer ${s.q + 1} of ${R.count}</p>
      ${s.text ? `<p class="pl-q">${esc(s.text)}</p><p class="pl-reveal">${esc(s.answer)}</p>` : ""}`;
    case "scores": return `<p class="eyebrow">Standings after round ${s.r + 1}</p>${standingsTable(s.r, myName)}`;
    case "final": return `<p class="eyebrow">Final standings</p>${standingsTable(ROUNDS.length - 1, myName)}`;
  }
  return "";
}

function playerHTML(s) {
  const r = plRound, R = ROUNDS[r], shown = releasedIn(r).reverse();
  const locked = !!live.locked[r];
  const openRounds = ROUNDS.map((_, i) => i).filter(i => releasedIn(i).length);
  const judged = shown.filter(q => get2(myMarks, r, q) !== undefined);
  const score = shown.filter(q => get2(myMarks, r, q) === true).length;
  return `
    <section class="pl-status">${statusHTML(s)}</section>
    ${openRounds.length > 1 ? `<div class="tabs" role="group" aria-label="Round">${openRounds.map(i =>
      `<button type="button" class="tab" data-plround="${i}" aria-pressed="${i === r}">Round ${i + 1}<small>${esc(ROUNDS[i].name)}</small></button>`).join("")}</div>` : ""}
    ${shown.length ? `
      <div class="pl-head">
        <h3>Round ${r + 1}: ${esc(R.name)}</h3>
        <span>${locked ? "Locked" : "Answers save as you type"}${judged.length ? ` · ${score} of ${R.count} right` : ""}</span>
      </div>
      <ol class="pl-list">${shown.map(q => {
        const current = s.t === "q" && s.r === r && s.q === q;
        const mark = get2(myMarks, r, q), key = get2(live.revealed, r, q);
        const badge = mark === true ? `<span class="badge ok">✓ Right</span>` : mark === false ? `<span class="badge no">✗ Wrong</span>` : "";
        return `<li class="pl-card${current ? " current" : ""}${mark === true ? " is-right" : mark === false ? " is-wrong" : ""}">
          <div class="pl-qhead"><span>Question ${q + 1}${current ? " · now" : ""}</span>${badge}</div>
          <p class="pl-q">${esc(get2(live.released, r, q))}</p>
          <label class="sr" for="ans-${r}-${q}">Your answer to question ${q + 1}</label>
          <input class="input pl-in" id="ans-${r}-${q}" data-r="${r}" data-q="${q}" maxlength="200" autocomplete="off" autocapitalize="sentences"
            placeholder="${locked ? "No answer" : "Type your answer"}" ${locked ? "disabled" : ""}>
          <p class="pl-meta" id="meta-${r}-${q}"></p>
          ${key != null ? `<p class="pl-key">Answer: <b>${esc(key)}</b></p>` : ""}
        </li>`;
      }).join("")}</ol>` : ""}`;
}

function syncAnswerInputs() {
  document.querySelectorAll(".pl-in").forEach(el => {
    const k = aKey(el.dataset.r, el.dataset.q), saved = get2(myAnswers, el.dataset.r, el.dataset.q) || "";
    if (document.activeElement !== el && !saveTimers[k]) el.value = drafts[k] ?? saved;
    const meta = $(`meta-${el.dataset.r}-${el.dataset.q}`);
    if (meta && !meta.dataset.sticky) meta.textContent = saveTimers[k] ? "Saving…" : saved && (drafts[k] ?? saved) === saved ? "Saved" : "";
  });
}

function saveAnswer(r, q) {
  const k = aKey(r, q), value = (drafts[k] || "").trim().slice(0, 200);
  clearTimeout(saveTimers[k]); delete saveTimers[k];
  const meta = $(`meta-${r}-${q}`);
  backend.set(`answers/${uid}/${r}/${q}`, value || null).then(() => {
    myAnswers[r] = myAnswers[r] || {}; myAnswers[r][q] = value;
    if (meta) { delete meta.dataset.sticky; meta.textContent = value ? "Saved" : ""; }
  }).catch(() => {
    if (meta) { meta.dataset.sticky = "1"; meta.textContent = "Not saved: this round's answers are locked."; meta.classList.add("bad"); }
  });
}

$("player").addEventListener("input", e => {
  const el = e.target;
  if (!el.classList.contains("pl-in")) return;
  const r = el.dataset.r, q = el.dataset.q, k = aKey(r, q);
  drafts[k] = el.value;
  clearTimeout(saveTimers[k]);
  saveTimers[k] = setTimeout(() => saveAnswer(r, q), 600);
  const meta = $(`meta-${r}-${q}`); if (meta && !meta.dataset.sticky) meta.textContent = "Saving…";
});
$("player").addEventListener("focusout", e => {
  const el = e.target;
  if (el.classList && el.classList.contains("pl-in") && saveTimers[aKey(el.dataset.r, el.dataset.q)]) saveAnswer(el.dataset.r, el.dataset.q);
});
$("player").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.classList.contains("pl-in")) { e.preventDefault(); e.target.blur(); }
});
$("player").addEventListener("click", e => {
  const t = e.target.closest("[data-plround]");
  if (t) { plRound = +t.dataset.plround; renderPlayer(); return; }
  if (e.target.id === "joinCancel") { editingName = false; plSig = ""; renderPlayer(); }
});
$("player").addEventListener("submit", async e => {
  if (e.target.id !== "joinForm") return;
  e.preventDefault();
  const name = $("teamNameIn").value.trim().replace(/\s+/g, " ").slice(0, 40), err = $("joinErr");
  if (!name) return;
  $("joinGo").disabled = true;
  try {
    await connect();
    await backend.set(`teams/${uid}`, { name });
    myName = name; editingName = false; plSig = ""; render();
  } catch {
    err.textContent = "Couldn't join. Check your connection and try again."; err.hidden = false;
    $("joinGo").disabled = false;
  }
});

/* ---------- Chrome ---------- */
function stepLabel(i) {
  const s = SEQ[i]; if (!s) return "";
  return {
    welcome: "Welcome screen", round: `Round ${s.r + 1}: ${ROUNDS[s.r]?.name}`, q: `R${s.r + 1} question ${s.q + 1}`,
    answers: `R${s.r + 1} answers`, a: `R${s.r + 1} answer ${s.q + 1}`, scores: `Standings after R${s.r + 1}`, final: "Final standings",
  }[s.t];
}

function renderChrome() {
  const who = $("who");
  if (AUDIENCE) who.innerHTML = "";
  else if (isHost) who.innerHTML = `<span class="host-chip">Trivia master</span>`;
  else who.innerHTML = `${myName ? `<button class="team-chip" id="renameBtn" title="Change team name">${esc(myName)}</button>` : ""}<button class="login-btn" id="loginOpen">Trivia master</button>`;
  if ($("loginOpen")) $("loginOpen").onclick = openLogin;
  if ($("renameBtn")) $("renameBtn").onclick = () => { editingName = true; plSig = ""; renderPlayer(); };
  $("hostbar").hidden = !isHost;
  if (!isHost) return;
  $("offlineNote").hidden = !offline;
  const s = SEQ[live.step], nxt = SEQ[live.step + 1];
  $("where").innerHTML = `${esc(stepLabel(live.step))}<small>Step ${live.step + 1} of ${SEQ.length}${nxt ? " · Next: " + esc(stepLabel(live.step + 1)) : ""}</small>`;
  $("prev").disabled = live.step === 0;
  $("next").disabled = !nxt;
  $("next").textContent = !nxt ? "End of game" : nxt.t === "round" ? `Start round ${nxt.r + 1} →` : nxt.t === "answers" ? "Lock answers →"
    : nxt.t === "scores" ? "Show standings →" : nxt.t === "final" ? "Final standings →" : "Next →";
  $("tmr").hidden = s.t !== "q";
  $("peekBtn").hidden = s.t !== "q";
  $("peekBtn").setAttribute("aria-pressed", String(peekOn));
  const pk = $("peek");
  if (s.t === "q" && peekOn && QS) { pk.innerHTML = `Answer (only on this screen): <b>${esc(QS[s.r][s.q][1])}</b>`; pk.hidden = false; }
  else pk.hidden = true;
}

function render() {
  const mode = AUDIENCE ? "screen" : isHost ? "host" : "player";
  document.body.dataset.mode = mode;
  $("stage").hidden = mode === "player";
  $("player").hidden = mode !== "player";
  renderChrome();
  if (mode === "player") renderPlayer(); else renderStage();
}

/* ---------- Trivia master: moving the game along ---------- */
let peekOn = false;

function slideFor(i) {
  const s = SEQ[i], out = { ...s };
  if ((s.t === "q" || s.t === "a") && QS) {
    out.text = QS[s.r][s.q][0];
    if (s.t === "a") out.answer = QS[s.r][s.q][1];
  }
  return out;
}

// Everything the audience and players may see at this step, and nothing more.
function liveFor(step, timer) {
  const released = {}, revealed = {}, locked = {};
  for (let i = 0; i <= step; i++) {
    const s = SEQ[i];
    if (s.t === "q") (released[s.r] = released[s.r] || {})[s.q] = QS[s.r][s.q][0];
    if (s.t === "a") (revealed[s.r] = revealed[s.r] || {})[s.q] = QS[s.r][s.q][1];
    if (s.t === "answers") locked[s.r] = true;
  }
  return { step, slide: slideFor(step), timer, released, revealed, locked, standings: computeStandings(), v: now() };
}

function publish(l) {
  live = normLive(l); liveLoaded = true;
  render();
  backend.set("live", l).catch(err => flash("Couldn't update the game: " + err.message));
}

function go(d) {
  if (!isHost) return;
  const to = live.step + d;
  if (to < 0 || to >= SEQ.length) return;
  publish(liveFor(to, SEQ[to].t === "q" ? { running: true, end: now() + QUESTION_SECONDS * 1000, left: QUESTION_SECONDS * 1000 } : restTimer()));
}

function toggleTimer() {
  if (!isHost) return;
  const t = live.timer, left = timeLeft();
  const timer = t.running ? { running: false, end: 0, left }
    : left <= 0 ? { running: true, end: now() + QUESTION_SECONDS * 1000, left: QUESTION_SECONDS * 1000 }
    : { running: true, end: now() + left, left };
  live.timer = timer; paintTimer(); renderChrome();
  backend.update("live", { timer, v: now() }).catch(err => flash("Couldn't update the timer: " + err.message));
}

function syncStandings() {
  if (!isHost) return;
  const st = computeStandings();
  if (JSON.stringify(st) === JSON.stringify(live.standings)) return;
  live.standings = st; render();
  backend.set("live/standings", st.length ? st : null).catch(() => {});
}

/* ---------- Trivia master: login ---------- */
async function becomeHost(keyHex) {
  await connect(true);
  const token = await hostTokenFor(keyHex);
  try { await backend.set("hostToken", token); } catch {}  // only the first trivia master's write lands
  try { await backend.set(`hosts/${uid}`, token); }
  catch { const e = new Error("claimed"); throw e; }
  QS = await openQuestions(keyHex);
  isHost = true;
  peekOn = false;
  sessionStorage.setItem(SESSION_KEY, keyHex);
  hostWatches.forEach(f => f && f());
  hostWatches = [
    backend.watch("teams", v => { teams = v || {}; syncStandings(); refreshJudge(); }),
    backend.watch("answers", v => { answers = v || {}; refreshJudge(); }),
    backend.watch("marks", v => { marks = v || {}; syncStandings(); refreshJudge(); }),
  ];
  renderPrintSheet();
  // Pick up the game where it is (another trivia master, or this phone before a reload), never restart it.
  let cur = null;
  try { cur = await backend.get("live"); } catch {}
  if (cur) { live = normLive(cur); liveLoaded = true; publish(liveFor(live.step, live.timer)); }
  else publish(liveFor(0, restTimer()));
}

function openLogin() { $("loginErr").hidden = true; $("code").value = ""; $("loginBox").hidden = false; $("code").focus(); }
$("loginCancel").onclick = () => { $("loginBox").hidden = true; };
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("loginGo"), err = $("loginErr");
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  if (!window.crypto || !crypto.subtle) return fail("This browser can't unlock the questions here. Open the site from its https address.");
  btn.disabled = true; btn.textContent = "Checking…"; err.hidden = true;
  try {
    const k = await keyFromCode($("code").value);
    if (!k) { fail("That code doesn't match. Check with the event organizer and try again."); $("code").select(); return; }
    await becomeHost(k);
    $("loginBox").hidden = true;
  } catch (ex) {
    fail(ex.message === "not-configured" ? "The live database isn't set up yet. Follow 'Setting up Firebase' in the README."
      : ex.message === "claimed" ? "That code is right, but this game room was opened with a different code. Run set-host-codes.py again to start a fresh room."
      : "Couldn't connect to the game. Check your internet connection and try again.");
  } finally { btn.disabled = false; btn.textContent = "Log in"; }
});
$("logoutBtn").onclick = () => {
  isHost = false; QS = null; peekOn = false;
  hostWatches.forEach(f => f && f()); hostWatches = [];
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  $("judgeBox").hidden = true; renderPrintSheet(); plSig = ""; render();
};

/* ---------- Trivia master: controls ---------- */
$("prev").onclick = () => go(-1);
$("next").onclick = () => go(1);
$("tmr").onclick = toggleTimer;
$("peekBtn").onclick = () => { peekOn = !peekOn; renderChrome(); };
function flash(t) { const m = $("msg"); m.textContent = t; m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { m.hidden = true; }, 12000); }
$("audBtn").onclick = () => {
  const url = joinUrl() + location.search + "#audience";
  let w = null;
  try { w = window.open(url, "gsab-audience"); } catch {}
  flash((w ? "Big-screen view opened in a new window. " : "")
    + (offline ? "" : "To show it on a TV or another computer, open " + url.replace(/^https?:\/\//, "") + " there."));
};
$("fsBtn").onclick = () => {
  const fail = () => flash("Full screen isn't available here. Try your browser's own full screen key (F11).");
  try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(fail); } catch { fail(); }
};
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { $("loginBox").hidden = true; $("judgeBox").hidden = true; return; }
  if (!isHost || e.target.closest("input, textarea, select")) return;
  if (e.key === " " && e.target.closest("button")) return;
  if (!$("loginBox").hidden || !$("judgeBox").hidden) return;
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === "t" && SEQ[live.step].t === "q") toggleTimer();
});

/* ---------- Trivia master: judging ---------- */
let jR = 0, jQ = 0;
const normAns = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[‘’'"“”.,!?:;()\-–—]/g, " ").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
function keyVariants(key) {
  const k = String(key), out = [k, k.replace(/\(.*?\)/g, "")];
  (k.match(/\((.*?)\)/g) || []).forEach(p => out.push(p.slice(1, -1)));
  out.slice().forEach(v => v.split(/\s+or\s+|,\s+or\s+|\//i).forEach(x => out.push(x)));
  return [...new Set(out.map(normAns).filter(Boolean))];
}
const exactMatch = (ans, key) => !!normAns(ans) && keyVariants(key).includes(normAns(ans));
const teamList = () => Object.entries(teams).filter(([, t]) => t && t.name).sort((a, b) => a[1].name.localeCompare(b[1].name));

function refreshJudge() { if (!$("judgeBox").hidden) renderJudge(); }

function renderJudge() {
  if (!QS) return;
  const R = ROUNDS[jR], key = QS[jR][jQ][1], tl = teamList();
  $("jgRounds").innerHTML = ROUNDS.map((r, i) => `<button type="button" class="tab" data-jr="${i}" aria-pressed="${i === jR}">Round ${i + 1}<small>${esc(r.name)}</small></button>`).join("");
  $("jgQs").innerHTML = Array.from({ length: R.count }, (_, q) => {
    const todo = tl.filter(([tid]) => get2(answers[tid], jR, q) && get2(marks[tid], jR, q) === undefined).length;
    return `<button type="button" class="chip" data-jq="${q}" aria-pressed="${q === jQ}">Q${q + 1}${todo ? `<span class="dot" aria-label="${todo} to judge">${todo}</span>` : ""}</button>`;
  }).join("");
  const rows = tl.map(([tid, t]) => ({ tid, name: t.name, ans: get2(answers[tid], jR, jQ) || "", mark: get2(marks[tid], jR, jQ) }));
  const right = rows.filter(x => x.mark === true).length, wrong = rows.filter(x => x.mark === false).length;
  const todo = rows.filter(x => x.mark === undefined).length;
  const exact = rows.filter(x => x.mark === undefined && exactMatch(x.ans, key)).length;
  $("jgBody").innerHTML = `
    <div class="jg-q">
      <p class="eyebrow">Round ${jR + 1} · Question ${jQ + 1}${live.released[jR] && isReleased(jR, jQ) ? "" : " · not asked yet"}</p>
      <p class="jg-qtext">${esc(QS[jR][jQ][0])}</p>
      <p class="jg-key">Answer: <b>${esc(key)}</b></p>
    </div>
    <div class="jg-tally"><span>${right} right · ${wrong} wrong · ${todo} to judge</span>
      ${exact ? `<button type="button" class="btn small" id="jgExact">Mark ${exact} exact match${exact > 1 ? "es" : ""} right</button>` : ""}</div>
    ${rows.length ? `<ul class="jg-list">${rows.map(x => `
      <li class="jg-row${x.mark === true ? " is-right" : x.mark === false ? " is-wrong" : ""}">
        <div class="jg-who"><span class="jg-team">${esc(x.name)}</span><span class="jg-ans${x.ans ? "" : " none"}">${x.ans ? esc(x.ans) : "No answer"}</span></div>
        <div class="jg-btns">
          <button type="button" class="jb ok" data-mark="${esc(x.tid)}" data-v="1" aria-pressed="${x.mark === true}" aria-label="Mark ${esc(x.name)} right">✓</button>
          <button type="button" class="jb no" data-mark="${esc(x.tid)}" data-v="0" aria-pressed="${x.mark === false}" aria-label="Mark ${esc(x.name)} wrong">✗</button>
        </div>
      </li>`).join("")}</ul>` : `<p class="lede">No teams have joined yet.</p>`}`;
  $("jgPrev").disabled = jR === 0 && jQ === 0;
  $("jgNext").disabled = jR === ROUNDS.length - 1 && jQ === R.count - 1;
  const st = computeStandings();
  $("jgStandings").innerHTML = `<summary>Standings</summary>${st.length ? `<ol class="sk-rank">${st.map(x => `<li><span>${esc(x.name)}</span><b class="num">${x.total}</b></li>`).join("")}</ol>` : `<p>No teams yet.</p>`}`;
  $("jgTeams").innerHTML = `<summary>Teams (${tl.length})</summary>${tl.length ? `<ul class="jg-teams">${tl.map(([tid, t]) =>
    `<li><span>${esc(t.name)}</span><button type="button" class="x" data-del="${esc(tid)}">Remove</button></li>`).join("")}</ul>` : `<p>No teams yet.</p>`}`;
}

function setMark(tid, v) {
  const cur = get2(marks[tid], jR, jQ), next = cur === v ? undefined : v;
  marks[tid] = marks[tid] || {}; marks[tid][jR] = marks[tid][jR] || {};
  if (next === undefined) delete marks[tid][jR][jQ]; else marks[tid][jR][jQ] = next;
  renderJudge(); syncStandings();
  backend.set(`marks/${tid}/${jR}/${jQ}`, next === undefined ? null : next).catch(err => flash("Couldn't save that mark: " + err.message));
}

$("judgeBtn").onclick = () => {
  const s = SEQ[live.step];
  if (s.r !== undefined) { jR = s.r; jQ = s.q !== undefined ? s.q : 0; }
  $("resetAsk").hidden = true; $("resetBtn").hidden = false;
  $("judgeBox").hidden = false; renderJudge();
};
$("judgeClose").onclick = () => { $("judgeBox").hidden = true; };
$("judgeBox").addEventListener("click", e => {
  const t = e.target;
  const r = t.closest("[data-jr]"); if (r) { jR = +r.dataset.jr; jQ = 0; return renderJudge(); }
  const q = t.closest("[data-jq]"); if (q) { jQ = +q.dataset.jq; return renderJudge(); }
  const m = t.closest("[data-mark]"); if (m) return setMark(m.dataset.mark, m.dataset.v === "1");
  if (t.id === "jgExact") {
    const key = QS[jR][jQ][1];
    teamList().forEach(([tid]) => { const a = get2(answers[tid], jR, jQ); if (get2(marks[tid], jR, jQ) === undefined && exactMatch(a, key)) setMark(tid, true); });
    return;
  }
  const d = t.closest("[data-del]");
  if (d) {
    if (d.dataset.confirm !== "1") { d.dataset.confirm = "1"; d.textContent = "Remove for good?"; d.classList.add("warn"); return; }
    const tid = d.dataset.del;
    delete teams[tid]; delete answers[tid]; delete marks[tid];
    backend.update("", { [`teams/${tid}`]: null, [`answers/${tid}`]: null, [`marks/${tid}`]: null }).catch(err => flash("Couldn't remove that team: " + err.message));
    syncStandings(); renderJudge();
  }
});
$("jgPrev").onclick = () => { if (jQ > 0) jQ--; else if (jR > 0) { jR--; jQ = ROUNDS[jR].count - 1; } renderJudge(); };
$("jgNext").onclick = () => { if (jQ < ROUNDS[jR].count - 1) jQ++; else if (jR < ROUNDS.length - 1) { jR++; jQ = 0; } renderJudge(); };
$("resetBtn").onclick = () => { $("resetBtn").hidden = true; $("resetAsk").hidden = false; };
$("resetNo").onclick = () => { $("resetAsk").hidden = true; $("resetBtn").hidden = false; };
$("resetYes").onclick = async () => {
  teams = {}; answers = {}; marks = {};
  try { await backend.update("", { teams: null, answers: null, marks: null }); } catch (err) { flash("Couldn't reset: " + err.message); }
  publish(liveFor(0, restTimer()));
  $("judgeBox").hidden = true;
};

/* ---------- Printable question sheet ---------- */
function renderPrintSheet() {
  const el = $("printSheet");
  if (!QS) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <header class="ps-head">
      <div><p class="ps-org">UChicago Graduate Student Advisory Board</p><h1>Maroon Trivia Night</h1></div>
      <div class="ps-team">Team name<span></span></div>
    </header>
    <div class="ps-grid">${ROUNDS.map((r, ri) => `
      <section class="ps-round">
        <h2><span>Round ${ri + 1}</span>${esc(r.name)}</h2>
        <ol>${QS[ri].map(q => `<li><p>${esc(q[0])}</p><div class="ps-line"></div></li>`).join("")}</ol>
      </section>`).join("")}
    </div>`;
}
$("printBtn").onclick = () => { renderPrintSheet(); window.print(); };

/* ---------- Start ---------- */
let watching = false;
function startWatches() {
  if (watching) return;
  watching = true;
  backend.watch("live", v => {
    const fresh = normLive(v);
    if (isHost && fresh.v < live.v) return;   // our own newer write is on its way
    live = fresh; liveLoaded = true; render();
  });
  if (!AUDIENCE) {
    backend.watch(`teams/${uid}`, v => { myName = v && v.name || null; render(); });
    backend.watch(`answers/${uid}`, v => { myAnswers = v || {}; if (!isHost) renderPlayer(); });
    backend.watch(`marks/${uid}`, v => { myMarks = v || {}; if (!isHost) renderPlayer(); });
  }
}

render();
(async () => {
  let saved = null;
  if (!AUDIENCE) { try { saved = sessionStorage.getItem(SESSION_KEY); } catch {} }
  try { await connect(AUDIENCE || !!saved); }
  catch (e) { backendError = e; render(); return; }
  if (saved && window.crypto && crypto.subtle) becomeHost(saved).catch(() => { try { sessionStorage.removeItem(SESSION_KEY); } catch {} });
})();
})();
