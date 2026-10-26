// Maroon Trivia Night. The trivia master logs in with a code, which unlocks the
// questions (see set-host-codes.py) and the controls. An audience window on the
// same computer follows along and only ever receives the slide on screen.
(() => {
"use strict";

const QUESTION_SECONDS = 45;
const STATE_KEY = "gsab-trivia-night";
const SESSION_KEY = "gsab-trivia-host-key";
const L = "ABCD";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const LOCK = window.GSAB_LOCKED;
if (!LOCK) {
  document.getElementById("stage").innerHTML = `<p class="lede">locked.js is missing. Run set-host-codes.py to create it.</p>`;
  return;
}
const ROUNDS = LOCK.rounds;          // public: name, blurb, count
let QS = null;                       // unlocked: per round, [question, options, answer index, fact]

/* ---------- Unlocking ---------- */
const enc = new TextEncoder();
const hexToBytes = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const bytesToHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

async function keyFromCode(code) {
  const norm = code.trim().toLowerCase();
  if (!norm) return null;
  const base = await crypto.subtle.importKey("raw", enc.encode(norm), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(LOCK.salt), iterations: LOCK.iterations, hash: "SHA-256" }, base, 256));
  for (const blob of LOCK.keys) {
    const k = hexToBytes(blob).map((x, i) => x ^ bits[i]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(k, enc.encode("gsab-check"))));
    if (bytesToHex(digest).slice(0, 16) === LOCK.check) return bytesToHex(k);
  }
  return null;
}

async function openQuestions(keyHex) {
  const raw = Uint8Array.from(atob(LOCK.data), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  const data = JSON.parse(new TextDecoder().decode(plain));
  return data.rounds.map(r => r.questions.map(q => [q.q, q.options, L.indexOf(q.answer), q.fact || ""]));
}
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

const AUDIENCE = location.hash === "#audience";
const fresh = () => ({ step: 0, timer: { running: false, end: 0, left: QUESTION_SECONDS * 1000 }, teams: [], slide: null, v: 0 });

function load() { try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s && typeof s.step === "number") return s; } catch {} return null; }
function save() { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {} }
function session(v) {
  try {
    if (v === undefined) return sessionStorage.getItem(SESSION_KEY);
    v ? sessionStorage.setItem(SESSION_KEY, v) : sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  return null;
}

let state = load() || fresh();
state.step = Math.min(Math.max(0, state.step), SEQ.length - 1);
let isHost = false;
let peekOn = false;

// The slide carries only what the audience should see right now.
function slideFor(i) {
  const s = SEQ[i], out = { ...s };
  if ((s.t === "q" || s.t === "a") && QS) {
    const q = QS[s.r][s.q];
    out.text = q[0]; out.opts = q[1];
    if (s.t === "a") { out.answer = q[2]; out.fact = q[3]; }
  }
  return out;
}

let chan = null;
try { chan = new BroadcastChannel("gsab-trivia"); } catch {}
function commit() {
  state.v = Date.now();
  if (isHost) state.slide = slideFor(state.step);
  save();
  try { chan && chan.postMessage({ type: "state", state }); } catch {}
  render();
}
function adopt(s) { if (s && s.v >= state.v) { state = s; render(); } }
if (chan) chan.onmessage = e => {
  const m = e.data || {};
  if (m.type === "state" && !isHost) adopt(m.state);
  if (m.type === "hello" && isHost) chan.postMessage({ type: "state", state });
};
window.addEventListener("storage", e => {
  if (e.key === STATE_KEY && e.newValue && !isHost) { try { adopt(JSON.parse(e.newValue)); } catch {} }
});

/* ---------- Timer ---------- */
function timeLeft() { const t = state.timer; return Math.max(0, t.running ? t.end - Date.now() : t.left); }
function startTimer() { state.timer = { running: true, end: Date.now() + QUESTION_SECONDS * 1000, left: QUESTION_SECONDS * 1000 }; }
function toggleTimer() {
  if (!isHost) return;
  const t = state.timer;
  if (t.running) state.timer = { running: false, end: 0, left: timeLeft() };
  else if (timeLeft() <= 0) startTimer();
  else state.timer = { running: true, end: Date.now() + t.left, left: t.left };
  commit();
}
setInterval(paintTimer, 200);
function paintTimer() {
  const el = $("timer");
  if (!el) return;
  const left = timeLeft();
  el.classList.toggle("low", left < 10000);
  el.querySelector(".fill").style.transform = `scaleX(${left / (QUESTION_SECONDS * 1000)})`;
  el.querySelector(".secs").innerHTML = left > 0 ? Math.ceil(left / 1000) + "s" : `<span class="done">Pencils down</span>`;
  if (isHost) $("tmr").textContent = state.timer.running && left > 0 ? "Pause timer" : left > 0 ? "Resume timer" : "Restart timer";
}

/* ---------- Scores ---------- */
const total = (t, upTo = ROUNDS.length - 1) => t.scores.slice(0, upTo + 1).reduce((a, b) => a + (Number(b) || 0), 0);
function standingsTable(upTo) {
  if (!state.teams.length) return `<p class="lede">No teams yet. The trivia master can add teams and scores under Teams &amp; scores.</p>`;
  const rows = state.teams.map(t => ({ t, sum: total(t, upTo) })).sort((a, b) => b.sum - a.sum);
  const top = rows[0].sum, cols = ROUNDS.slice(0, upTo + 1);
  let rank = 0, prev = null;
  return `<div class="tbl-wrap"><table class="standings">
    <thead><tr><th>#</th><th>Team</th>${cols.map((_, i) => `<th class="r">R${i + 1}</th>`).join("")}<th class="r">Total</th></tr></thead>
    <tbody>${rows.map((x, i) => {
      if (x.sum !== prev) { rank = i + 1; prev = x.sum; }
      return `<tr class="${x.sum === top && top > 0 ? "lead" : ""}"><td>${rank}</td><td>${esc(x.t.name)}</td>${cols.map((_, r) => `<td class="r">${x.t.scores[r] ?? "–"}</td>`).join("")}<td class="r"><b>${x.sum}</b></td></tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

/* ---------- Rendering ---------- */
const waiting = `<p class="wait">Waiting for the trivia master…</p>`;

function render() {
  const s = isHost ? slideFor(state.step) : (state.slide || SEQ[state.step] || SEQ[0]);
  const st = $("stage"), n = ROUNDS.length;
  const R = s.r !== undefined ? ROUNDS[s.r] : null;
  if (s.t === "welcome") {
    st.innerHTML = `
      <p class="eyebrow">Tonight · ${n} rounds of ${ROUNDS[0].count}</p>
      <h2 class="display">Welcome to Maroon Trivia Night</h2>
      <p class="lede">Form your team, grab a pencil, and write each answer as A, B, C or D.</p>
      <ol class="roundlist">${ROUNDS.map((r, i) => `<li><span class="num">Round ${i + 1}</span><strong>${esc(r.name)}</strong><small>${esc(r.blurb)}</small></li>`).join("")}</ol>
      ${state.teams.length ? `<p class="lede">Teams tonight: ${state.teams.map(t => esc(t.name)).join(", ")}</p>` : ""}
      ${isHost ? `<p class="wait">Press Next when everyone's ready.</p>` : waiting}`;
  } else if (s.t === "round") {
    st.innerHTML = `
      <p class="eyebrow">Round ${s.r + 1} of ${n}</p>
      <h2 class="display huge">${esc(R.name)}</h2>
      <p class="lede">${esc(R.blurb)}. ${R.count} questions, ${QUESTION_SECONDS} seconds each.</p>
      <p class="wait">Number your sheet 1 to ${R.count}.</p>`;
  } else if (s.t === "q" || s.t === "a") {
    const reveal = s.t === "a";
    if (!s.text) { st.innerHTML = `<p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}</p>${waiting}`; renderChrome(); return; }
    st.innerHTML = `
      <div class="qhead">
        <div><p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}${reveal ? " · Answers" : ""}</p><div class="qnum">${reveal ? "Answer" : "Question"} ${s.q + 1} of ${R.count}</div></div>
        ${reveal ? "" : `<div class="timer" id="timer"><div class="track"><div class="fill"></div></div><span class="secs"></span></div>`}
      </div>
      <h2 class="question">${esc(s.text)}</h2>
      <ul class="opts">${s.opts.map((o, k) => {
        const cls = reveal ? (k === s.answer ? "right" : "dim") : "";
        return `<li class="opt ${cls}"><span class="key">${L[k]}</span><span>${esc(o)}</span>${reveal && k === s.answer ? `<span class="mark" aria-label="correct answer">✓</span>` : ""}</li>`;
      }).join("")}</ul>
      ${reveal ? `<p class="fact"><b>${L[s.answer]}: ${esc(s.opts[s.answer])}.</b> ${esc(s.fact)}</p>` : ""}`;
    paintTimer();
  } else if (s.t === "answers") {
    st.innerHTML = `
      <p class="eyebrow">Round ${s.r + 1} · ${esc(R.name)}</p>
      <h2 class="display">Pencils down. Time for the answers.</h2>
      <p class="lede">Swap sheets with a neighboring team and mark each other's answers. One point for each correct letter.</p>`;
  } else if (s.t === "scores") {
    st.innerHTML = `
      <p class="eyebrow">Standings after round ${s.r + 1} of ${n}</p>
      <h2 class="display">${s.r === n - 1 ? "Final scores are in" : "How everyone's doing"}</h2>
      ${standingsTable(s.r)}
      ${s.r < n - 1 ? `<p class="wait">Up next: ${esc(ROUNDS[s.r + 1].name)}</p>` : ""}`;
  } else if (s.t === "final") {
    const rows = state.teams.map(t => ({ t, sum: total(t) })).sort((a, b) => b.sum - a.sum);
    const top = rows.length ? rows[0].sum : 0;
    const winners = rows.filter(x => x.sum === top && top > 0).map(x => esc(x.t.name));
    st.innerHTML = `
      <p class="eyebrow">Final standings</p>
      <h2 class="display">Thanks for playing!</h2>
      ${winners.length ? `<p class="winner">${winners.length > 1 ? "Tied for first" : "Winners"}: ${winners.join(" & ")} with ${top} points</p>` : ""}
      ${standingsTable(n - 1)}`;
  }
  renderChrome();
}

function stepLabel(i) {
  const s = SEQ[i]; if (!s) return "";
  return {
    welcome: "Welcome screen", round: `Round ${s.r + 1} title (${ROUNDS[s.r]?.name})`, q: `R${s.r + 1} question ${s.q + 1}`,
    answers: `R${s.r + 1} answers intro`, a: `R${s.r + 1} answer ${s.q + 1}`, scores: `Standings after R${s.r + 1}`, final: "Final standings",
  }[s.t];
}

function renderChrome() {
  $("who").innerHTML = AUDIENCE ? "" : isHost ? `<span class="host-chip">Trivia master</span>` : `<button class="login-btn" id="loginOpen">Trivia master login</button>`;
  const lo = $("loginOpen"); if (lo) lo.onclick = openLogin;
  $("hostbar").hidden = !isHost;
  if (!isHost) return;
  const s = SEQ[state.step], nxt = SEQ[state.step + 1];
  $("where").innerHTML = `${esc(stepLabel(state.step))}<small>Step ${state.step + 1} of ${SEQ.length}${nxt ? " · Next: " + esc(stepLabel(state.step + 1)) : ""}</small>`;
  $("prev").disabled = state.step === 0;
  $("next").disabled = !nxt;
  $("next").textContent = !nxt ? "End of game" : nxt.t === "round" ? `Start round ${nxt.r + 1} →` : nxt.t === "answers" ? "Pencils down →"
    : nxt.t === "scores" ? "Show standings →" : nxt.t === "final" ? "Final standings →" : "Next →";
  $("tmr").hidden = s.t !== "q";
  $("peekBtn").hidden = s.t !== "q";
  $("peekBtn").setAttribute("aria-pressed", String(peekOn));
  const pk = $("peek");
  if (s.t === "q" && peekOn) { const q = QS[s.r][s.q]; pk.innerHTML = `Answer (only on this screen): <b>${L[q[2]]}: ${esc(q[1][q[2]])}</b>`; pk.hidden = false; }
  else pk.hidden = true;
}

function go(d) {
  if (!isHost) return;
  const to = state.step + d;
  if (to < 0 || to >= SEQ.length) return;
  state.step = to;
  if (SEQ[to].t === "q") startTimer(); else state.timer = { running: false, end: 0, left: QUESTION_SECONDS * 1000 };
  commit();
}

/* ---------- Login ---------- */
async function becomeHost(keyHex) {
  QS = await openQuestions(keyHex);
  isHost = true;
  session(keyHex);
  commit();
}
function openLogin() {
  $("loginErr").hidden = true; $("code").value = ""; $("loginBox").hidden = false; $("code").focus();
}
$("loginCancel").onclick = () => { $("loginBox").hidden = true; };
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const go = $("loginGo"), err = $("loginErr");
  if (!window.crypto || !crypto.subtle) {
    err.textContent = "This browser can't unlock the questions here. Open the site from its web address (https) or from localhost.";
    err.hidden = false; return;
  }
  go.disabled = true; go.textContent = "Checking…"; err.hidden = true;
  try {
    const k = await keyFromCode($("code").value);
    if (!k) { err.textContent = "That code doesn't match. Check with the event organizer and try again."; err.hidden = false; $("code").select(); return; }
    await becomeHost(k);
    $("loginBox").hidden = true;
  } catch {
    err.textContent = "The questions couldn't be unlocked. Run set-host-codes.py again to rebuild locked.js."; err.hidden = false;
  } finally { go.disabled = false; go.textContent = "Log in"; }
});
$("logoutBtn").onclick = () => { isHost = false; QS = null; session(""); peekOn = false; $("teamsBox").hidden = true; render(); };

/* ---------- Host controls ---------- */
$("prev").onclick = () => go(-1);
$("next").onclick = () => go(1);
$("tmr").onclick = toggleTimer;
$("peekBtn").onclick = () => { peekOn = !peekOn; renderChrome(); };
function flash(t) { const m = $("msg"); m.textContent = t; m.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { m.hidden = true; }, 9000); }
$("audBtn").onclick = () => {
  let w = null;
  try { w = window.open(location.href.split("#")[0] + "#audience", "gsab-audience"); } catch {}
  flash(w ? "Audience screen opened. Drag that window onto the projector and make it full screen. It follows your controls and never shows the peeked answer."
          : "Your browser blocked the new window. Open this page in another window and add #audience to the end of its address.");
};
$("fsBtn").onclick = () => {
  const fail = () => flash("Full screen isn't available here. Try your browser's own full screen key (F11).");
  try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(fail); } catch { fail(); }
};
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { $("loginBox").hidden = true; $("teamsBox").hidden = true; return; }
  if (!isHost || e.target.closest("input, textarea")) return;
  if (e.key === " " && e.target.closest("button")) return; // the focused button handles Space itself
  if (!$("loginBox").hidden || !$("teamsBox").hidden) return;
  if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); go(1); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === "t" && SEQ[state.step].t === "q") toggleTimer();
});

/* ---------- Teams ---------- */
function renderTeams() {
  const box = $("teamsTable");
  if (!state.teams.length) { box.innerHTML = `<p>No teams yet. Add the first team above.</p>`; return; }
  box.innerHTML = `<table class="teams"><thead><tr><th>Team</th>${ROUNDS.map((r, i) => `<th>R${i + 1}</th>`).join("")}<th style="text-align:right">Total</th><th></th></tr></thead><tbody>
    ${state.teams.map((t, i) => `<tr>
      <td><input class="input" id="tn-${i}" data-i="${i}" data-f="name" value="${esc(t.name)}" aria-label="Team name"></td>
      ${ROUNDS.map((r, ri) => `<td><input class="input sc" id="ts-${i}-${ri}" type="number" min="0" max="${r.count}" inputmode="numeric" data-i="${i}" data-r="${ri}" value="${t.scores[ri] ?? ""}" aria-label="${esc(t.name)} round ${ri + 1} score"></td>`).join("")}
      <td class="tot" id="tt-${i}">${total(t)}</td>
      <td><button class="x" data-del="${i}" aria-label="Remove ${esc(t.name)}">Remove</button></td></tr>`).join("")}
  </tbody></table>`;
}
$("teamsTable").addEventListener("input", e => {
  const el = e.target, i = +el.dataset.i, t = state.teams[i]; if (!t) return;
  if (el.dataset.f === "name") t.name = el.value.slice(0, 40) || "Unnamed team";
  else { t.scores[+el.dataset.r] = el.value === "" ? null : Math.max(0, Number(el.value) || 0); $("tt-" + i).textContent = total(t); }
  commit();
});
$("teamsTable").addEventListener("click", e => {
  const d = e.target.closest("[data-del]"); if (!d) return;
  state.teams.splice(+d.dataset.del, 1); commit(); renderTeams();
});
$("addTeam").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("teamName").value.trim(); if (!name) return;
  state.teams.push({ name: name.slice(0, 40), scores: ROUNDS.map(() => null) });
  $("teamName").value = ""; commit(); renderTeams(); $("teamName").focus();
});
$("teamsBtn").onclick = () => { renderTeams(); $("resetAsk").hidden = true; $("resetBtn").hidden = false; $("teamsBox").hidden = false; $("teamName").focus(); };
$("teamsClose").onclick = () => { $("teamsBox").hidden = true; };
$("resetBtn").onclick = () => { $("resetBtn").hidden = true; $("resetAsk").hidden = false; };
$("resetNo").onclick = () => { $("resetAsk").hidden = true; $("resetBtn").hidden = false; };
$("resetYes").onclick = () => { const v = state.v; state = fresh(); state.v = v; commit(); renderTeams(); $("teamsBox").hidden = true; };

/* ---------- Start ---------- */
render();
const saved = AUDIENCE ? null : session();
if (saved && window.crypto && crypto.subtle) becomeHost(saved).catch(() => session(""));
try { chan && chan.postMessage({ type: "hello" }); } catch {}
})();
