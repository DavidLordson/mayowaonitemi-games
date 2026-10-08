import { buildPuzzle } from "./crossword.js";
import * as ludoUi from "./ludo.js";
import * as whotUi from "./whot.js";

const BOARD_GAMES = { ludo: { ui: ludoUi, title: "Ludo" }, whot: { ui: whotUi, title: "Whot" } };

const COLORS = ["#e5484d", "#3b82f6", "#16a34a", "#9333ea", "#ea580c"];
const POLL_MS = 1000;
const HIDDEN_POLL_MS = 5000;
const BOT_POLL_MS = 650;
const LIVE_POLL_MS = 15000; // with a live connection, polling is only a safety net
const HEARTBEAT_MS = 10000;
const ONLINE_MS = 20000;

const $ = (id) => document.getElementById(id);

const storage = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Logins on this device: room id -> { pid, token, roomName }.
const rooms = storage.get("cw-rooms") || {};
const saveRooms = () => storage.set("cw-rooms", rooms);
// Name and colour suggested when creating or joining a room.
const profile = storage.get("cw-profile") || { name: "", color: COLORS[Math.floor(Math.random() * COLORS.length)] };

let session = null;       // { room, pid, token } for the room being played
let members = {};         // pid -> { name, color }
const me = () => members[session?.pid] || { name: "You", color: profile.color };

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
  if (mine && (mine.t == null || !best || best.t < mine.t)) return mine.ch ? { ch: mine.ch, by: session.pid } : null;
  if (mine && best && best.t >= mine.t) delete myEdits[k]; // server has caught up
  return best && best.ch ? best : null;
}

function colorOf(pid) {
  return members[pid]?.color || "var(--ink)";
}

function setLetter(r, c, ch) {
  const k = key(r, c);
  myEdits[k] = { ch, t: null };
  outbox[k] = ch;
  wrong.delete(k);
  flushSoon();
}

// ---------- network ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, body, auth = true) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (auth && session) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(method === "GET" ? `/api/room?room=${session.room}` : "/api/room", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

// The room no longer accepts this device (logged out elsewhere, or room gone).
function lostAccess(err) {
  if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 404)) return false;
  delete rooms[session.room];
  saveRooms();
  showHome("You're no longer logged in to that room. Ask for a new invite link.");
  return true;
}

let loadingGame = null;

// Book puzzles are static files; generated ones are stored with the game on the server.
async function loadPuzzle(m) {
  try {
    if (m.puzzleId !== "random") return await fetch(`/puzzles/${m.puzzleId}.json`).then((r) => r.json());
    const res = await fetch(`/api/room?room=${session.room}&puzzle=1`, { headers: { authorization: `Bearer ${session.token}` } });
    const body = await res.json();
    return res.ok && body.gameId === m.gameId ? body.puzzle : null;
  } catch {
    return null; // try again on the next poll
  }
}

async function applyState(state) {
  if (!session || state.room !== session.room) return;
  if (meta && state.meta.startedAt < meta.startedAt) return; // a response from before the latest game began
  lastServerSkew = state.now - Date.now();
  members = state.members;
  const g = state.game;
  botTurn = !!g && g.phase !== "over" && g.players?.[g.turn]?.pid === "cpu";
  if (rooms[session.room] && rooms[session.room].roomName !== state.roomName) {
    rooms[session.room].roomName = state.roomName;
    saveRooms();
  }
  const type = state.meta.game || "crossword";
  if (type === "lobby" && !inLobby) showLobby(); // new room: nothing chosen yet
  // Someone started a new game while we were in the lobby: join it.
  if (inLobby && lobbySeenGame && state.meta.gameId !== lobbySeenGame && type !== "lobby") leaveLobby();
  if (inLobby) {
    lobbySeenGame ??= state.meta.gameId;
    lobbyState = state;
    players = state.players ?? players;
    renderLobby(state);
    renderPlayers(Date.now() + lastServerSkew);
    return;
  }
  if (BOARD_GAMES[type]) {
    if (!meta || state.meta.gameId !== meta.gameId || !boardGame) {
      meta = state.meta;
      puzzle = null;
      myEdits = {};
      outbox = {};
      $("banner").hidden = true;
      showBoardGame(type, state.roomName);
    }
    players = state.players ?? players;
    if (state.game) boardGame.update(state.game);
    renderPlayers(Date.now() + lastServerSkew);
    return;
  }
  if (!meta || state.meta.gameId !== meta.gameId || boardGame) {
    if (loadingGame === state.meta.gameId) return; // another response is already loading it
    loadingGame = state.meta.gameId;
    let data;
    try { data = await loadPuzzle(state.meta); } finally { loadingGame = null; }
    if (!data || !session || state.room !== session.room) return;
    meta = state.meta;
    myEdits = {};
    outbox = {};
    wrong.clear();
    solvedShown = false;
    $("banner").hidden = true;
    showCrossword();
    setupPuzzle(buildPuzzle(data), state.roomName);
  }
  players = state.players ?? players;
  render();
}

// ---------- lobby ----------

const GAME_NAMES = { crossword: "Crossword", ludo: "Ludo", whot: "Whot" };
let inLobby = false;
let lobbyState = null; // latest room state seen while in the lobby
let lobbySeenGame = null; // the game that was on when we opened the lobby

function showLobby() {
  inLobby = true;
  lobbySeenGame = null;
  if (boardGame) showCrossword(); // unmount the board view
  meta = null; // re-load whichever game is picked
  puzzle = null;
  $("banner").hidden = true;
  $("crosswordView").hidden = true;
  $("boardView").hidden = true;
  $("lobbyView").hidden = false;
  document.querySelectorAll("[data-cw]").forEach((el) => { el.hidden = true; });
  $("title").textContent = rooms[session.room]?.roomName || "Games";
  if (lobbyState?.room === session.room) renderLobby(lobbyState);
  fetch("/puzzles/index.json").then((r) => r.json()).then((list) => {
    $("lobbyBooks").innerHTML = "";
    for (const p of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p.title;
      b.onclick = () => startGame({ game: "crossword", puzzleId: p.id });
      $("lobbyBooks").appendChild(b);
    }
    $("lobbyBooksWrap").hidden = !list.length;
  }).catch(() => {});
  if (session) poll();
}

function leaveLobby() {
  inLobby = false;
  $("lobbyView").hidden = true;
  meta = null;
}

function renderLobby(state) {
  $("title").textContent = state.roomName;
  const type = state.meta.game || "crossword";
  $("lobbyNow").hidden = !GAME_NAMES[type];
  $("lobbyNowName").textContent = GAME_NAMES[type] || "";
}

$("lobbyContinue").onclick = () => { leaveLobby(); setStatus("Loading…"); poll(); };
$("allRooms").onclick = () => showHome();
document.querySelectorAll("#lobbyView [data-start]").forEach((b) => {
  b.onclick = () => startGame(b.dataset.start === "crossword"
    ? { game: "crossword", puzzleId: "random" }
    : { game: b.dataset.start, ...("cpu" in b.dataset ? { vsComputer: true } : {}) });
});

// ---------- board games ----------

let boardGame = null; // the mounted Ludo / Whot view, or null while playing the crossword

function showBoardGame(type, roomName) {
  $("crosswordView").hidden = true;
  $("boardView").hidden = false;
  document.querySelectorAll("[data-cw]").forEach((el) => { el.hidden = true; });
  $("title").textContent = `${roomName} · ${BOARD_GAMES[type].title}`;
  boardGame = BOARD_GAMES[type].ui.mount($("boardView"), {
    me: () => session?.pid,
    members: () => members,
    newGame,
    play: async (move) => {
      try {
        await applyState(await api("POST", { action: "play", room: session.room, gameId: meta.gameId, move }));
      } catch (err) {
        if (!lostAccess(err)) throw err;
      }
    },
  });
}

function showCrossword() {
  boardGame = null;
  $("boardView").innerHTML = "";
  $("boardView").hidden = true;
  $("crosswordView").hidden = false;
  document.querySelectorAll("[data-cw]").forEach((el) => { el.hidden = false; });
}

let pollTimer = null;
let botTurn = false; // poll faster while the computer is playing, so its moves show promptly
async function poll() {
  clearTimeout(pollTimer);
  if (!session) return;
  try {
    await applyState(await api("GET"));
    setStatus("");
  } catch (err) {
    if (lostAccess(err)) return;
    setStatus("Reconnecting…");
  }
  if (session) pollTimer = setTimeout(poll, document.hidden ? HIDDEN_POLL_MS : live?.open ? LIVE_POLL_MS : botTurn ? BOT_POLL_MS : POLL_MS);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !session) return;
  if (!live) connectLive();
  poll();
});

// ---------- live updates ----------
// The server pushes the room's state over a WebSocket whenever it changes. If the
// connection isn't there (or the host has no /api/room/ws), polling carries on as before.

let live = null; // { ws, open }
let liveRetries = 0;
let liveTimer = null;
function connectLive() {
  clearTimeout(liveTimer);
  if (live) { live.ws.onclose = null; live.ws.close(); live = null; }
  if (!session || typeof WebSocket === "undefined") return;
  const { room, token } = session;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/room/ws?room=${room}`);
  live = { ws, open: false };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", token }));
    live.open = true;
    liveRetries = 0;
  };
  ws.onmessage = (e) => {
    let state;
    try { state = JSON.parse(e.data); } catch { return; }
    applyState(state);
  };
  ws.onclose = (e) => {
    live = null;
    if (!session || session.room !== room) return;
    if (e.code === 4003) { poll(); return; } // not a member any more: the poll shows why
    liveTimer = setTimeout(connectLive, Math.min(30000, 1000 * 2 ** liveRetries++));
  };
}

let flushTimer = null;
function flushSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 60);
}

async function flush() {
  if (sending || !meta || !session) return;
  const cells = outbox;
  if (!Object.keys(cells).length && !cursorDirty) return;
  outbox = {};
  cursorDirty = false;
  sending = true;
  lastSent = Date.now();
  const gameId = meta.gameId;
  try {
    const res = await api("POST", { action: "edit", room: session.room, gameId, cells, cursor: sel });
    for (const k of Object.keys(cells)) {
      // Mark as acknowledged unless the letter was changed again while in flight.
      if (myEdits[k] && myEdits[k].t == null && !(k in outbox)) myEdits[k].t = res.t;
    }
    await applyState(res);
  } catch (err) {
    if (lostAccess(err)) { sending = false; return; }
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
  if (session && !document.hidden && Date.now() - lastSent > HEARTBEAT_MS) { cursorDirty = true; flush(); }
}, 2000);

// ---------- puzzle / navigation ----------

let cellEls = [];
function setupPuzzle(p, roomName) {
  puzzle = p;
  $("title").textContent = `${roomName} · ${p.title}`;
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
  const partners = Object.entries(players)
    .filter(([pid, p]) => pid !== session.pid && p.cursor && now - p.seen < ONLINE_MS)
    .map(([pid, p]) => [pid, { ...p, color: colorOf(pid) }]);
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
  const box = $("players");
  box.innerHTML = "";
  for (const [pid, m] of Object.entries(members)) {
    const seen = pid === session.pid ? now : players[pid]?.seen || 0;
    const s = document.createElement("span");
    s.className = `player${now - seen > ONLINE_MS ? " away" : ""}`;
    s.style.setProperty("--c", m.color);
    s.innerHTML = "<i></i>";
    s.append(pid === session.pid ? `${m.name} (you)` : m.name);
    box.appendChild(s);
  }
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
  if (!puzzle || !session || document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
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
$("homeBtn").onclick = () => { if (session) showLobby(); };
// ◐ cycles the theme: follow the device → dark → light → follow the device.
$("themeBtn").onclick = () => {
  const order = [undefined, "dark", "light"];
  const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length];
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { next ? localStorage.setItem("theme", next) : localStorage.removeItem("theme"); } catch {}
};
$("menu").onclick = async (e) => {
  const act = e.target.dataset.act;
  if (!act || !session) return;
  if ((act === "check" || act === "reveal") && !puzzle) return;
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
  } else if (act === "invite" || act === "device") {
    makeLink(act === "invite" ? "member" : "device");
  } else if (act === "name") {
    askName();
  } else if (act === "new") {
    newGame();
  } else if (act === "logout") {
    if (!confirm("Log out of this room on this device? You'll need a new link to get back in.")) return;
    try { await api("POST", { action: "logout", room: session.room }); } catch {}
    delete rooms[session.room];
    saveRooms();
    showHome();
  }
};

async function makeLink(kind) {
  try {
    const { code } = await api("POST", { action: "invite", room: session.room, kind });
    const link = `${location.origin}/?room=${session.room}&invite=${code}`;
    $("linkTitle").textContent = kind === "member" ? "Invite someone" : "Log in on another device";
    $("linkText").textContent = kind === "member"
      ? "Send this link to the person you want to play with. It works once and expires in 7 days."
      : `Open this link on your other device to play there as ${me().name}. It works once and expires in 30 minutes.`;
    $("linkInput").value = link;
    $("linkShare").hidden = !navigator.share;
    $("linkShare").onclick = () => navigator.share({ title: "Crossword", text: kind === "member" ? "Come do the crossword with me" : undefined, url: link }).catch(() => {});
    $("linkCopy").textContent = "Copy link";
    $("linkCopy").onclick = async () => {
      try { await navigator.clipboard.writeText(link); } catch { $("linkInput").select(); document.execCommand("copy"); }
      $("linkCopy").textContent = "Copied ✓";
    };
    $("linkDialog").showModal();
  } catch (err) {
    if (!lostAccess(err)) setStatus("Couldn't make a link — try again");
  }
}

function newGame() {
  showLobby();
}

async function startGame(choice) {
  if (!session) return;
  setStatus(choice.puzzleId === "random" ? "Making a new puzzle…" : "Starting…");
  try {
    // Replace whatever is on right now (the server ignores the request if it changed meanwhile).
    const { meta: current } = await api("GET");
    const res = await api("POST", { action: "new", room: session.room, fromGameId: current.gameId, ...choice });
    leaveLobby();
    await applyState(res);
    setStatus("");
  } catch (err) {
    if (lostAccess(err)) return;
    setStatus("");
    alert(err.message || "Couldn't start a new game");
  }
}
$("bannerNew").onclick = newGame;
$("bannerClose").onclick = () => { $("banner").hidden = true; };

// Colour swatches inside a container; returns a getter for the chosen colour.
function colorPicker(box, initial) {
  let chosen = initial;
  box.innerHTML = "";
  for (const color of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (color === chosen ? " on" : "");
    b.style.setProperty("--c", color);
    b.setAttribute("aria-label", `Colour ${color}`);
    b.onclick = () => { chosen = color; box.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", s === b)); };
    box.appendChild(b);
  }
  return () => chosen;
}

function rememberProfile(name, color) {
  profile.name = name;
  profile.color = color;
  storage.set("cw-profile", profile);
}

function askName() {
  const dlg = $("nameDialog");
  $("nameInput").value = me().name;
  const getColor = colorPicker($("colorPick"), me().color);
  dlg.onclose = async () => {
    const name = $("nameInput").value.trim().slice(0, 24) || me().name;
    rememberProfile(name, getColor());
    try { await applyState(await api("POST", { action: "profile", room: session.room, name, color: getColor() })); }
    catch (err) { if (!lostAccess(err)) setStatus("Couldn't save your name"); }
  };
  dlg.showModal();
}

// ---------- screens ----------

function showScreen(id) {
  for (const s of ["homeScreen", "joinScreen", "gameScreen"]) $(s).hidden = s !== id;
  const inGame = id === "gameScreen";
  $("menuBtn").hidden = !inGame;
  $("homeBtn").hidden = !inGame;
  if (!inGame) {
    $("players").innerHTML = "";
    $("title").textContent = "Games Together";
  }
}

function showHome(notice) {
  session = null;
  connectLive(); // closes it
  inLobby = false;
  lobbyState = null;
  clearTimeout(pollTimer);
  history.replaceState(null, "", "/");
  showScreen("homeScreen");
  $("homeNotice").hidden = !notice;
  $("homeNotice").textContent = notice || "";
  const list = $("roomList");
  list.innerHTML = "";
  for (const [room, info] of Object.entries(rooms)) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/?room=${room}`;
    a.textContent = info.roomName || "Room";
    const span = document.createElement("span");
    span.textContent = "Play ›";
    a.appendChild(span);
    a.onclick = (e) => { e.preventDefault(); enterRoom(room); };
    li.appendChild(a);
    list.appendChild(li);
  }
  $("noRooms").hidden = Object.keys(rooms).length > 0;
}

const createForm = $("createForm");
let createColor = colorPicker(createForm.querySelector("[data-colors]"), profile.color);
createForm.elements.name.value = profile.name;
createForm.onsubmit = async (e) => {
  e.preventDefault();
  const btn = createForm.querySelector("button.primary");
  btn.disabled = true;
  try {
    const name = createForm.elements.name.value.trim();
    rememberProfile(name, createColor());
    const res = await api("POST", { action: "create", roomName: createForm.elements.roomName.value.trim(), name, color: createColor() }, false);
    rooms[res.room] = { pid: res.pid, token: res.token, roomName: res.roomName };
    saveRooms();
    enterRoom(res.room);
  } catch (err) {
    alert(`Couldn't create the room: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

async function showJoin(room, invite) {
  showScreen(null); // stay blank until the invite is checked
  let info;
  try {
    info = await fetch("/api/room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inviteInfo", room, invite }),
    }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
  } catch (err) {
    showHome(rooms[room] ? "That link was already used — but you're already in this room below." : (err.message || "That invite link doesn't work."));
    return;
  }
  const form = $("joinForm");
  showScreen("joinScreen");
  const isDevice = info.kind === "device";
  $("joinTitle").textContent = isDevice ? `Log in as ${info.playerName}` : `Join “${info.roomName}”`;
  $("joinText").textContent = isDevice
    ? `This device will play in “${info.roomName}” as ${info.playerName}.`
    : `${info.members.join(" & ")} invited you to do the crossword together.`;
  $("joinFields").hidden = isDevice;
  $("joinBtn").textContent = isDevice ? "Log in" : "Join";
  form.elements.name.value = profile.name;
  form.elements.name.required = !isDevice;
  const getColor = colorPicker(form.querySelector("[data-colors]"), profile.color);
  form.onsubmit = async (e) => {
    e.preventDefault();
    $("joinBtn").disabled = true;
    try {
      const name = form.elements.name.value.trim();
      if (!isDevice) rememberProfile(name, getColor());
      const res = await api("POST", { action: "join", room, invite, name, color: getColor() }, false);
      rooms[room] = { pid: res.pid, token: res.token, roomName: res.roomName };
      saveRooms();
      enterRoom(room);
    } catch (err) {
      showHome(err.message);
    } finally {
      $("joinBtn").disabled = false;
    }
  };
}

function enterRoom(room) {
  const creds = rooms[room];
  if (!creds) {
    showHome("This room is private. Ask someone in it to send you an invite link.");
    return;
  }
  session = { room, pid: creds.pid, token: creds.token };
  connectLive();
  meta = null;
  puzzle = null;
  if (boardGame) showCrossword();
  members = {};
  players = {};
  history.replaceState(null, "", `/?room=${room}`);
  showScreen("gameScreen");
  $("grid").innerHTML = "";
  lobbyState = null;
  showLobby(); // always arrive in the room's lobby
}

buildKeyboard();
{
  const params = new URLSearchParams(location.search);
  const room = (params.get("room") || "").toLowerCase();
  const invite = params.get("invite");
  if (room && invite) showJoin(room, invite);
  else if (room) enterRoom(room);
  else showHome();
}
