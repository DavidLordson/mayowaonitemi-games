import { buildPuzzle } from "./crossword.js";

const COLORS = ["#e5484d", "#3b82f6", "#16a34a", "#9333ea", "#ea580c"];
const POLL_MS = 1000;
const HIDDEN_POLL_MS = 5000;
const HEARTBEAT_MS = 10000;
const ONLINE_MS = 20000;

const $ = (id) => document.getElementById(id);
const room = (new URLSearchParams(location.search).get("room") || "main").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "main";

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const me = storage.get("cw-player") || { id: Math.random().toString(36).slice(2, 12), name: "", color: COLORS[Math.floor(Math.random() * COLORS.length)] };
storage.set("cw-player", me);

let puzzle = null;        // built puzzle for the current game
let meta = null;          // { gameId, puzzleId }
let players = {};         // server copy of every player's edits
let myEdits = {};         // cellKey -> { ch, t } (t = server time once acknowledged)
let outbox = {};          // cellKey -> letter not yet sent
let cursorDirty = false;
let sending = false;
let lastSent = 0;
let sel = { r: 0, c: 0, dir: "across" };
let wrong = new Set();
let solvedShown = false;
let lastServerSkew = 0;   // server clock minus local clock

const key = (r, c) => `${r},${c}`;

// ---------- state ----------

function letterAt(k) {
  let best = null;
  for (const [pid, p] of Object.entries(players)) {
    const e = p.cells?.[k];
    if (e && (!best || e[1] > best.t)) best = { ch: e[0], t: e[1], by: pid };
  }
  const mine = myEdits[k];
  if (mine && (mine.t == null || !best || best.t < mine.t)) return mine.ch ? { ch: mine.ch, by: me.id } : null;
  if (mine && best && best.t >= mine.t) delete myEdits[k]; // server has caught up
  return best && best.ch ? best : null;
}

function colorOf(pid) {
  if (pid === me.id) return me.color;
  return players[pid]?.color || "#1f2433";
}

function setLetter(r, c, ch) {
  const k = key(r, c);
  myEdits[k] = { ch, t: null };
  outbox[k] = ch;
  wrong.delete(k);
  flushSoon();
}

// ---------- network ----------

async function api(method, body) {
  const res = await fetch(method === "GET" ? `/api/room?room=${room}` : "/api/room", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function applyState(state) {
  lastServerSkew = state.now - Date.now();
  if (!meta || state.meta.gameId !== meta.gameId) {
    const data = await fetch(`/puzzles/${state.meta.puzzleId}.json`).then((r) => r.json());
    meta = state.meta;
    myEdits = {};
    outbox = {};
    wrong.clear();
    solvedShown = false;
    $("banner").hidden = true;
    setupPuzzle(buildPuzzle(data));
  }
  players = state.players;
  render();
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  try {
    await applyState(await api("GET"));
    setStatus("");
  } catch {
    setStatus("Reconnecting…");
  }
  pollTimer = setTimeout(poll, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

let flushTimer = null;
function flushSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 60);
}

async function flush() {
  if (sending || !meta) return;
  const cells = outbox;
  if (!Object.keys(cells).length && !cursorDirty) return;
  outbox = {};
  cursorDirty = false;
  sending = true;
  lastSent = Date.now();
  const gameId = meta.gameId;
  try {
    const res = await api("POST", { action: "edit", room, gameId, player: me, cells, cursor: sel });
    for (const k of Object.keys(cells)) {
      // Mark as acknowledged unless the letter was changed again while in flight.
      if (myEdits[k] && myEdits[k].t == null && !(k in outbox)) myEdits[k].t = res.t;
    }
    await applyState(res);
  } catch {
    if (meta && meta.gameId === gameId) outbox = { ...cells, ...outbox };
    cursorDirty = true;
    setStatus("Couldn't save — retrying…");
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    sending = false;
  }
  if (Object.keys(outbox).length || cursorDirty) flush();
}

setInterval(() => {
  if (!document.hidden && Date.now() - lastSent > HEARTBEAT_MS) { cursorDirty = true; flush(); }
}, 2000);

// ---------- puzzle / navigation ----------

let cellEls = [];
function setupPuzzle(p) {
  puzzle = p;
  $("title").textContent = p.title;
  const grid = $("grid");
  grid.style.setProperty("--cols", p.width);
  grid.innerHTML = "";
  cellEls = [];
  for (let r = 0; r < p.height; r++) {
    cellEls.push([]);
    for (let c = 0; c < p.width; c++) {
      const el = document.createElement("div");
      el.className = "cell";
      if (!p.open(r, c)) el.classList.add("block");
      else {
        const n = p.numbers[key(r, c)];
        el.innerHTML = `${n ? `<span class="num">${n}</span>` : ""}<span class="ch"></span>`;
        el.addEventListener("pointerdown", (e) => { e.preventDefault(); tapCell(r, c); });
      }
      grid.appendChild(el);
      cellEls[r].push(el);
    }
  }
  for (const dir of ["across", "down"]) {
    const ol = $(dir);
    ol.innerHTML = "";
    for (const w of p.words.filter((w) => w.dir === dir)) {
      const li = document.createElement("li");
      li.innerHTML = `<b>${w.num}</b><span></span>`;
      li.lastChild.textContent = w.clue;
      li.addEventListener("click", () => { sel = { r: w.cells[0][0], c: w.cells[0][1], dir }; moved(); });
      w.li = li;
      ol.appendChild(li);
    }
  }
  const first = p.words[0];
  sel = { r: first.cells[0][0], c: first.cells[0][1], dir: first.dir };
}

function wordAt(r, c, dir) {
  return puzzle.words.find((w) => w.dir === dir && w.cells.some(([rr, cc]) => rr === r && cc === c));
}

function currentWord() {
  return wordAt(sel.r, sel.c, sel.dir) || wordAt(sel.r, sel.c, sel.dir === "across" ? "down" : "across");
}

function tapCell(r, c) {
  if (r === sel.r && c === sel.c) toggleDir();
  else {
    sel = { ...sel, r, c };
    if (!wordAt(r, c, sel.dir)) sel.dir = sel.dir === "across" ? "down" : "across";
  }
  moved();
}

function toggleDir() {
  const other = sel.dir === "across" ? "down" : "across";
  if (wordAt(sel.r, sel.c, other)) sel.dir = other;
}

function moved() {
  cursorDirty = true;
  flushSoon();
  render();
}

function stepInWord(delta) {
  const w = currentWord();
  const i = w.cells.findIndex(([r, c]) => r === sel.r && c === sel.c);
  const next = w.cells[i + delta];
  if (next) { sel.r = next[0]; sel.c = next[1]; return true; }
  return false;
}

function jumpWord(delta, preferEmpty = false) {
  const words = puzzle.words;
  let i = words.indexOf(currentWord());
  for (let n = 0; n < words.length; n++) {
    i = (i + delta + words.length) % words.length;
    const w = words[i];
    const target = preferEmpty ? w.cells.find(([r, c]) => !letterAt(key(r, c))) : w.cells[0];
    if (target) { sel = { r: target[0], c: target[1], dir: w.dir }; return; }
  }
}

function typeLetter(ch) {
  setLetter(sel.r, sel.c, ch);
  if (!stepInWord(1)) jumpWord(1, true);
  moved();
}

function backspace() {
  const k = key(sel.r, sel.c);
  if (letterAt(k)) setLetter(sel.r, sel.c, "");
  else if (stepInWord(-1)) setLetter(sel.r, sel.c, "");
  moved();
}

function moveArrow(dr, dc) {
  const dir = dr ? "down" : "across";
  if (sel.dir !== dir && wordAt(sel.r, sel.c, dir)) { sel.dir = dir; moved(); return; }
  let r = sel.r + dr, c = sel.c + dc;
  while (r >= 0 && c >= 0 && r < puzzle.height && c < puzzle.width) {
    if (puzzle.open(r, c)) { sel.r = r; sel.c = c; break; }
    r += dr; c += dc;
  }
  moved();
}

// ---------- rendering ----------

function render() {
  if (!puzzle) return;
  const word = currentWord();
  const inWord = new Set(word ? word.cells.map(([r, c]) => key(r, c)) : []);
  const now = Date.now() + lastServerSkew;
  const partners = Object.entries(players).filter(([pid, p]) => pid !== me.id && p.cursor && now - p.seen < ONLINE_MS);
  const partnerCells = new Map();
  const partnerWords = new Map();
  for (const [, p] of partners) {
    partnerCells.set(key(p.cursor.r, p.cursor.c), p.color);
    const w = puzzle.open(p.cursor.r, p.cursor.c) && wordAt(p.cursor.r, p.cursor.c, p.cursor.dir);
    if (w) for (const [r, c] of w.cells) partnerWords.set(key(r, c), p.color);
  }

  let filled = 0, correct = 0, total = 0;
  for (let r = 0; r < puzzle.height; r++) {
    for (let c = 0; c < puzzle.width; c++) {
      if (!puzzle.open(r, c)) continue;
      total++;
      const k = key(r, c);
      const el = cellEls[r][c];
      const l = letterAt(k);
      el.querySelector(".ch").textContent = l ? l.ch : "";
      el.style.setProperty("--author", l ? colorOf(l.by) : "");
      if (l) { filled++; if (l.ch === puzzle.grid[r][c]) correct++; }
      el.classList.toggle("sel", r === sel.r && c === sel.c);
      el.classList.toggle("word", inWord.has(k));
      el.classList.toggle("wrong", wrong.has(k));
      el.classList.toggle("partner", partnerCells.has(k));
      el.classList.toggle("partner-word", partnerWords.has(k) && !inWord.has(k));
      el.style.setProperty("--pc", partnerCells.get(k) || partnerWords.get(k) || "transparent");
    }
  }

  for (const w of puzzle.words) {
    w.li.classList.toggle("active", w === word);
    w.li.classList.toggle("done", w.cells.every(([r, c]) => letterAt(key(r, c))));
  }
  if (word) {
    $("clueText").innerHTML = `<b>${word.num}${word.dir === "across" ? "A" : "D"}</b>`;
    $("clueText").append(word.clue);
  }

  renderPlayers(now);
  if (correct === total && !solvedShown) { solvedShown = true; $("banner").hidden = false; }
  if (!statusMsg) $("status").textContent = `${filled}/${total} filled`;
}

function renderPlayers(now) {
  const list = Object.entries(players).filter(([pid]) => pid !== me.id);
  const box = $("players");
  box.innerHTML = "";
  const add = (name, color, away) => {
    const s = document.createElement("span");
    s.className = `player${away ? " away" : ""}`;
    s.style.setProperty("--c", color);
    s.innerHTML = "<i></i>";
    s.append(name || "Player");
    box.appendChild(s);
  };
  add(me.name || "You", me.color, false);
  for (const [, p] of list) add(p.name, p.color, now - p.seen > ONLINE_MS);
}

let statusMsg = "";
function setStatus(msg) {
  statusMsg = msg;
  if (msg) $("status").textContent = msg;
}

// ---------- input ----------

function buildKeyboard() {
  const kb = $("keyboard");
  for (const row of ["QWERTYUIOP", "ASDFGHJKL", "⇄ZXCVBNM⌫"]) {
    const div = document.createElement("div");
    div.className = "krow";
    for (const ch of row) {
      const b = document.createElement("button");
      b.className = "key" + ("⇄⌫".includes(ch) ? " wide" : "");
      b.textContent = ch;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (!puzzle) return;
        if (ch === "⌫") backspace();
        else if (ch === "⇄") { toggleDir(); moved(); }
        else typeLetter(ch);
      });
      div.appendChild(b);
    }
    kb.appendChild(div);
  }
}

document.addEventListener("keydown", (e) => {
  if (!puzzle || $("nameDialog").open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[a-z]$/i.test(e.key)) typeLetter(e.key.toUpperCase());
  else if (e.key === "Backspace" || e.key === "Delete") backspace();
  else if (e.key === "ArrowLeft") moveArrow(0, -1);
  else if (e.key === "ArrowRight") moveArrow(0, 1);
  else if (e.key === "ArrowUp") moveArrow(-1, 0);
  else if (e.key === "ArrowDown") moveArrow(1, 0);
  else if (e.key === "Tab") { jumpWord(e.shiftKey ? -1 : 1); moved(); }
  else if (e.key === " ") { toggleDir(); moved(); }
  else return;
  e.preventDefault();
});

$("prevClue").onclick = () => { jumpWord(-1); moved(); };
$("nextClue").onclick = () => { jumpWord(1); moved(); };
$("clueText").onclick = () => { toggleDir(); moved(); };

$("menuBtn").onclick = (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; };
document.addEventListener("click", () => { $("menu").hidden = true; });
$("menu").onclick = async (e) => {
  const act = e.target.dataset.act;
  if (!act || !puzzle) return;
  if (act === "check") {
    wrong = new Set();
    for (let r = 0; r < puzzle.height; r++) for (let c = 0; c < puzzle.width; c++) {
      const l = puzzle.open(r, c) && letterAt(key(r, c));
      if (l && l.ch !== puzzle.grid[r][c]) wrong.add(key(r, c));
    }
    setStatus(wrong.size ? `${wrong.size} wrong letter${wrong.size > 1 ? "s" : ""} marked` : "Everything so far is correct ✓");
    setTimeout(() => setStatus(""), 3000);
    render();
  } else if (act === "reveal") {
    setLetter(sel.r, sel.c, puzzle.grid[sel.r][sel.c]);
    moved();
  } else if (act === "share") {
    const link = `${location.origin}/?room=${room}`;
    try { await navigator.clipboard.writeText(link); setStatus("Invite link copied"); }
    catch { prompt("Send this link:", link); }
    setTimeout(() => setStatus(""), 2500);
  } else if (act === "name") {
    askName();
  } else if (act === "new") {
    newGame();
  }
};

async function newGame() {
  if (!confirm("Start a new game? This clears the board for both of you.")) return;
  const list = await fetch("/puzzles/index.json").then((r) => r.json());
  const others = list.filter((p) => p.id !== meta.puzzleId);
  const pick = (others.length ? others : list)[Math.floor(Math.random() * (others.length || list.length))];
  try { await applyState(await api("POST", { action: "new", room, puzzleId: pick.id, fromGameId: meta.gameId })); }
  catch { setStatus("Couldn't start a new game"); }
}
$("bannerNew").onclick = newGame;
$("bannerClose").onclick = () => { $("banner").hidden = true; };

function askName() {
  const dlg = $("nameDialog");
  $("nameInput").value = me.name;
  const pick = $("colorPick");
  pick.innerHTML = "";
  let chosen = me.color;
  for (const color of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (color === chosen ? " on" : "");
    b.style.setProperty("--c", color);
    b.onclick = () => { chosen = color; pick.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === b)); };
    pick.appendChild(b);
  }
  dlg.onclose = () => {
    me.name = $("nameInput").value.trim().slice(0, 24) || me.name || "Player";
    me.color = chosen;
    storage.set("cw-player", me);
    moved();
  };
  dlg.showModal();
}

buildKeyboard();
poll();
if (!me.name) askName();
