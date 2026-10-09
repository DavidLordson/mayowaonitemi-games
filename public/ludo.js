// Ludo board UI. The server runs the rules; this draws the state and sends rolls / moves.
// Your moves show at once: the same rules run here first, and the server's reply confirms
// (or undoes) them. The board is 3D (ludo3d.js) once it loads; the flat CSS board shows
// until then, or if 3D fails.

import * as rules from "./games/ludo.mjs";
import { playCapture } from "./ludo-fx.js";
import * as sound from "./sound.js";

const COLOR_HEX = { red: "#e5484d", green: "#16a34a", yellow: "#eab308", blue: "#3b82f6" };
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const STARS = [8, 21, 34, 47];
const HOME = 56;

// The 52 shared squares, clockwise from red's start, as [row, col] on a 15×15 board.
const PATH = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7], [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];
const HOME_COLUMN = {
  red: [1, 2, 3, 4, 5].map((c) => [7, c]),
  green: [1, 2, 3, 4, 5].map((r) => [r, 7]),
  yellow: [13, 12, 11, 10, 9].map((c) => [7, c]),
  blue: [13, 12, 11, 10, 9].map((r) => [r, 7]),
};
const HOME_SPOT = { red: [7, 6], green: [6, 7], yellow: [7, 8], blue: [8, 7] };
const YARD = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
const YARD_SPOTS = [[1, 1], [1, 3], [3, 1], [3, 3]];
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

function cellFor(color, pos, token) {
  if (pos === -1) {
    const [yr, yc] = YARD[color];
    const [r, c] = YARD_SPOTS[token];
    return { r: yr + r, c: yc + c, span: 2 };
  }
  if (pos === HOME) return { r: HOME_SPOT[color][0], c: HOME_SPOT[color][1], span: 1 };
  if (pos > 50) {
    const [r, c] = HOME_COLUMN[color][pos - 51];
    return { r, c, span: 1 };
  }
  const [r, c] = PATH[(START[color] + pos) % 52];
  return { r, c, span: 1 };
}

const place = (el, r, c, rs = 1, cs = rs) => {
  el.style.gridRow = `${r + 1} / span ${rs}`;
  el.style.gridColumn = `${c + 1} / span ${cs}`;
};

export function mount(root, ctx) {
  root.innerHTML = `
    <div class="ludo is-3d loading">
      <div class="ludo-3d"></div>
      <div class="ludo-board"></div>
      <div class="ludo-side">
        <div class="ludo-players"></div>
        <div class="ludo-controls">
          <div class="dice-pair">
            <button class="dice" data-die="0" aria-label="Die 1"></button>
            <button class="dice" data-die="1" aria-label="Die 2"></button>
          </div>
          <div class="ludo-status"></div>
          <button class="icon-btn ludo-mute"></button>
        </div>
        <button class="ludo-roll primary" hidden>Roll</button>
        <div class="ludo-picks" hidden>
          <button class="ludo-pick" data-die="0"></button>
          <button class="ludo-pick sum" data-die="both"></button>
          <button class="ludo-pick" data-die="1"></button>
        </div>
        <ul class="game-log"></ul>
      </div>
      <div class="game-over" hidden>
        <div class="banner-card"><p class="banner-title"></p><button class="primary">Play again</button></div>
      </div>
    </div>`;
  const board = root.querySelector(".ludo-board");
  const tokenLayer = [];
  const diceBtns = [...root.querySelectorAll(".dice")];
  const pickBtns = [...root.querySelectorAll(".ludo-pick")];
  let sel = null; // the token picked to move: { color, token }
  let options = []; // what the picked token can do: [{ die: 0 | 1 } | { both: true }]
  const statusEl = root.querySelector(".ludo-status");
  let game = null;
  let rolling = false; // a roll is on its way to the server
  let queue = Promise.resolve(); // moves go to the server one at a time, in order
  let pending = 0; // requests still in the queue
  let pendingSeq = 0; // seq of the newest move shown before the server confirmed it
  let serverGame = null; // the latest state the server sent
  let lastSeq = -1;
  let fxSeq = -1; // seq of the last capture we played the effect for
  let wasMyTurn = false;
  let wasOver = false;
  let note = "";
  let view3d = null;
  const tokenActions = new Map(); // "red2" -> send that token's move
  let dieTappable = [false, false];

  // Static board.
  for (const [color, [r, c]] of Object.entries(YARD)) {
    const yard = document.createElement("div");
    yard.className = "ludo-yard";
    yard.style.setProperty("--c", COLOR_HEX[color]);
    place(yard, r, c, 6);
    yard.innerHTML = "<div></div>";
    board.appendChild(yard);
  }
  PATH.forEach(([r, c], i) => {
    const sq = document.createElement("div");
    sq.className = "ludo-sq";
    const startColor = Object.keys(START).find((k) => START[k] === i);
    if (startColor) { sq.classList.add("tinted"); sq.style.setProperty("--c", COLOR_HEX[startColor]); }
    if (STARS.includes(i)) sq.classList.add("star");
    place(sq, r, c);
    board.appendChild(sq);
  });
  for (const [color, cells] of Object.entries(HOME_COLUMN)) {
    for (const [r, c] of cells) {
      const sq = document.createElement("div");
      sq.className = "ludo-sq tinted";
      sq.style.setProperty("--c", COLOR_HEX[color]);
      place(sq, r, c);
      board.appendChild(sq);
    }
  }
  const center = document.createElement("div");
  center.className = "ludo-center";
  place(center, 6, 6, 3);
  board.appendChild(center);

  function tapDie(i) {
    if (game && dieTappable[i] && game.phase === "roll") send({ type: "roll" });
  }
  diceBtns.forEach((btn, i) => { btn.onclick = () => tapDie(i); });
  const rollBtn = root.querySelector(".ludo-roll");
  rollBtn.onclick = () => tapDie(0);
  // Number buttons move the picked token by that die, or by both ("both").
  pickBtns.forEach((btn) => {
    btn.onclick = () => {
      if (!game || !sel) return;
      const both = btn.dataset.die === "both";
      const die = both ? null : Number(btn.dataset.die);
      if (!options.some((o) => (both ? o.both : o.die === die))) return;
      send(both ? { type: "both", ...sel } : { type: "move", ...sel, die });
    };
  });

  import("./ludo3d.js")
    .then(({ createBoard3D }) => createBoard3D(root.querySelector(".ludo-3d"), {
      onToken: (color, i) => tokenActions.get(color + i)?.(),
      onDie: tapDie,
    }))
    .then((view) => {
      if (!view) return;
      view3d = view;
      root.querySelector(".ludo").classList.remove("loading");
      tokenLayer.forEach((t) => t.remove());
      tokenLayer.length = 0;
      if (game) update(game);
    })
    .catch((err) => {
      // No 3D on this phone (or the files didn't load): use the flat board instead.
      console.warn("3D board unavailable, using the flat board", err);
      root.querySelector(".ludo").classList.remove("is-3d", "loading");
    });
  const muteBtn = root.querySelector(".ludo-mute");
  const drawMute = () => {
    muteBtn.textContent = sound.isMuted() ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-label", sound.isMuted() ? "Sound off" : "Sound on");
  };
  muteBtn.onclick = () => { sound.setMuted(!sound.isMuted()); drawMute(); };
  drawMute();

  root.querySelector(".game-over button").onclick = () => ctx.newGame();

  function send(move) {
    note = "";
    if (move.type === "roll") {
      if (rolling) return;
      rolling = true;
      view3d?.startRoll(); // dice tumble while the server rolls
      sound.play("roll");
    } else {
      const names = Object.fromEntries(Object.entries(ctx.members()).map(([id, m]) => [id, m.name]));
      const next = rules.play(game, ctx.me(), move, Math.random, names);
      if (next.error) { note = next.error; update(game); return; }
      pendingSeq = next.seq;
      sel = null; // the ring goes once the piece has moved; tap a piece to pick again
      update(next);
    }
    pending++;
    queue = queue
      .then(() => ctx.play(move))
      .catch((err) => { note = err.message; pendingSeq = 0; }) // rejected: fall back to the server's state
      .finally(() => {
        if (move.type === "roll") { rolling = false; view3d?.stopRoll(); }
        if (--pending === 0) pendingSeq = 0;
        update(pendingSeq ? game : serverGame ?? game);
      });
  }

  // States from the server. While our own moves are on their way, older states are skipped
  // so the pieces don't jump back.
  function receive(g) {
    serverGame = g;
    if (pendingSeq && g.seq < pendingSeq) return;
    update(g);
  }

  function drawDie(btn, value, rolling) {
    btn.innerHTML = value
      ? `<span class="pips">${Array.from({ length: 9 }, (_, i) => `<i${PIPS[value].includes(i) ? ' class="on"' : ""}></i>`).join("")}</span>`
      : "<span class=\"dice-label\">Roll</span>";
    if (rolling) { btn.classList.remove("rolling"); void btn.offsetWidth; btn.classList.add("rolling"); }
  }

  function update(g) {
    game = g;
    const me = ctx.me();
    const members = ctx.members();
    const current = g.players[g.turn];
    const myTurn = current.pid === me && g.phase !== "over";
    const colorsOf = (p) => (p ? p.colors ?? [p.color] : []);
    const myColors = colorsOf(g.players.find((p) => p.pid === me));
    const nameOf = (pid) => (pid === me ? "You" : pid === "cpu" ? "Computer" : members[pid]?.name || "Player");

    const dice = Array.isArray(g.dice) ? g.dice : null;
    const used = g.used || [false, false];
    const moving = myTurn && g.phase === "move" && !!dice;
    // Everything a token can do this turn: either unused die, or both dice together.
    const optionsFor = (color, token) => {
      if (!moving || !myColors.includes(color)) return [];
      const pos = g.tokens[color][token];
      const out = [0, 1].filter((d) => !used[d] && canStep(pos, dice[d])).map((die) => ({ die }));
      if (!used[0] && !used[1] && canUseBoth(pos, dice[0], dice[1])) out.push({ both: true });
      return out;
    };
    if (sel && !optionsFor(sel.color, sel.token).length) sel = null;
    options = sel ? optionsFor(sel.color, sel.token) : [];
    const justRolled = g.seq !== lastSeq && dice && lastSeq !== -1 && g.phase !== "over" && !g.last;
    // A capture we haven't shown yet (not on first load: that's an old one).
    const fresh = lastSeq !== -1 && g.seq !== lastSeq; // not on first load
    const capture = lastSeq !== -1 && g.seq !== fxSeq && g.last?.captured?.length ? g.last.captured : null;
    if (capture) fxSeq = g.seq;
    lastSeq = g.seq;
    const canRoll = myTurn && g.phase === "roll" && !rolling;
    dieTappable = [canRoll, canRoll];

    // Tokens
    const colors = g.players.flatMap(colorsOf);
    const stacks = new Map();
    const pieces = [];
    tokenActions.clear();
    for (const color of colors) {
      g.tokens[color].forEach((pos, i) => {
        const cell = cellFor(color, pos, i);
        const key = `${cell.r},${cell.c}`;
        const n = stacks.get(key) ?? 0;
        stacks.set(key, n + 1);
        const opts = optionsFor(color, i);
        const movable = opts.length > 0;
        // Tapping a token picks it; the number buttons then move it.
        if (movable) tokenActions.set(color + i, () => { sel = { color, token: i }; update(game); });
        const justMoved = !!g.last && g.last.color === color && g.last.token === i;
        const selected = !!sel && sel.color === color && sel.token === i;
        const flung = !!capture && capture.some((c) => c.color === color && c.token === i);
        pieces.push({ color, token: i, cell, n: cell.span === 1 ? n : 0, home: pos === HOME, movable, selected, justMoved, flung });
      });
    }
    if (view3d) {
      view3d.sync({
        colors, pieces, dice,
        rolled: !!justRolled,
        canRoll,
        tappable: dieTappable,
        used: [0, 1].map((d) => g.phase === "move" && !!used[d]),
        turnHex: COLOR_HEX[colorsOf(current)[0]],
      });
    } else {
      tokenLayer.forEach((t) => t.remove());
      tokenLayer.length = 0;
      for (const p of pieces) {
        const t = document.createElement("button");
        t.className = "ludo-token";
        t.style.setProperty("--c", COLOR_HEX[p.color]);
        t.style.setProperty("--shift", p.n);
        place(t, p.cell.r, p.cell.c, p.cell.span);
        if (p.movable) {
          t.classList.add("movable");
          t.onclick = tokenActions.get(p.color + p.token);
        } else t.disabled = true;
        if (p.justMoved) t.classList.add("just-moved");
        if (p.selected) t.classList.add("selected");
        if (p.flung) t.classList.add("flung");
        board.appendChild(t);
        tokenLayer.push(t);
      }
    }

    if (capture) {
      playCapture(root.querySelector(view3d ? ".ludo-3d" : ".ludo-board"), {
        hex: COLOR_HEX[capture[0].color],
        victim: capture.some((c) => myColors.includes(c.color)),
      });
    }

    // Sounds
    if (fresh && justRolled) sound.play("land");
    if (fresh && g.last && !capture) {
      const steps = g.last.from === -1 ? 1 : g.last.to - g.last.from;
      sound.play("steps", { steps });
      if (g.last.to === HOME) sound.play("home", {}, Math.min(steps, 12) * 0.06);
    }
    const isOver = g.phase === "over";
    if (fresh && isOver && !wasOver) sound.play("win", {}, 0.5);
    else if (lastSeq !== -1 && myTurn && g.phase === "roll" && !wasMyTurn) sound.play("turn", {}, 0.3);
    wasMyTurn = myTurn;
    wasOver = isOver;

    // Players
    root.querySelector(".ludo-players").innerHTML = g.players.map((p, i) => {
      const cols = colorsOf(p);
      const home = cols.reduce((n, c) => n + g.tokens[c].filter((x) => x === HOME).length, 0);
      return `<div class="ludo-player${i === g.turn && g.phase !== "over" ? " turn" : ""}" style="--c:${COLOR_HEX[cols[0]]}">
        ${cols.map((c) => `<i style="--c:${COLOR_HEX[c]}"></i>`).join("")}<span>${escapeHtml(nameOf(p.pid))}</span><small>${home}/${cols.length * 4} home</small></div>`;
    }).join("");

    // Dice + status
    diceBtns.forEach((btn, d) => {
      drawDie(btn, dice?.[d], justRolled);
      btn.disabled = !dieTappable[d];
      btn.classList.toggle("ready", canRoll);
      btn.classList.toggle("used", g.phase === "move" && !!used[d]);
      btn.style.setProperty("--c", COLOR_HEX[colorsOf(current)[0]]);
    });
    const picks = root.querySelector(".ludo-picks");
    picks.hidden = !moving;
    rollBtn.hidden = !(myTurn && g.phase === "roll");
    rollBtn.disabled = !canRoll;
    rollBtn.style.setProperty("--c", COLOR_HEX[colorsOf(current)[0]]);
    pickBtns.forEach((btn) => {
      const both = btn.dataset.die === "both";
      const d = Number(btn.dataset.die);
      if (both) btn.innerHTML = dice ? `${dice[0] + dice[1]}<small>${dice[0]} + ${dice[1]}</small>` : "";
      else btn.textContent = dice?.[d] ?? "";
      btn.disabled = !options.some((o) => (both ? o.both : o.die === d));
      btn.classList.toggle("used", both ? used.some(Boolean) : !!used[d]);
      btn.style.setProperty("--c", COLOR_HEX[colorsOf(current)[0]]);
    });
    let status;
    if (g.phase === "over") status = `${nameOf(g.winner)} won!`;
    else if (myTurn && g.phase === "roll") status = "Your turn — roll the dice";
    else if (myTurn) status = sel ? "Tap a number to move it (or tap another piece)" : "Tap a piece, then a number";
    else status = `${nameOf(current.pid)}'s turn${g.phase === "move" && dice ? ` (rolled ${dice.join(" & ")})` : ""}`;
    statusEl.textContent = note || status;
    root.querySelector(".game-log").innerHTML = g.log.slice(-3).reverse().map((l) => `<li>${escapeHtml(l)}</li>`).join("");

    const over = root.querySelector(".game-over");
    over.hidden = g.phase !== "over";
    over.querySelector(".banner-title").textContent = g.winner === me ? "You won! 🎉" : `${nameOf(g.winner)} won!`;
  }

  return { update: receive };
}

const canStep = (pos, value) => (pos === -1 ? value === 6 : pos + value <= HOME);
const stepTo = (pos, value) => (pos === -1 ? 0 : pos + value);
const canUseBoth = (pos, a, b) => (canStep(pos, a) && canStep(stepTo(pos, a), b)) || (canStep(pos, b) && canStep(stepTo(pos, b), a));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
