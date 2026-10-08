// Ludo board UI. The server runs the rules; this draws the state and sends rolls / moves.
// The board is 3D (ludo3d.js) once it loads; the flat CSS board shows until then, or if 3D fails.

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
    <div class="ludo">
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
  let selDie = 0; // which die the next token tap uses
  const statusEl = root.querySelector(".ludo-status");
  let game = null;
  let busy = false;
  let lastSeq = -1;
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
    if (!game || !dieTappable[i]) return;
    if (game.phase === "roll") send({ type: "roll" });
    else { selDie = i; update(game); }
  }
  diceBtns.forEach((btn, i) => { btn.onclick = () => tapDie(i); });

  import("./ludo3d.js")
    .then(({ createBoard3D }) => createBoard3D(root.querySelector(".ludo-3d"), {
      onToken: (color, i) => tokenActions.get(color + i)?.(),
      onDie: tapDie,
    }))
    .then((view) => {
      if (!view) return;
      view3d = view;
      root.querySelector(".ludo").classList.add("is-3d");
      tokenLayer.forEach((t) => t.remove());
      tokenLayer.length = 0;
      if (game) update(game);
    })
    .catch((err) => console.warn("3D board unavailable, using the flat board", err));
  root.querySelector(".game-over button").onclick = () => ctx.newGame();

  async function send(move) {
    if (busy) return;
    busy = true;
    note = "";
    try { await ctx.play(move); }
    catch (err) { note = err.message; }
    finally { busy = false; if (game) update(game); }
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
    const nameOf = (pid) => (pid === me ? "You" : members[pid]?.name || "Player");

    const dice = Array.isArray(g.dice) ? g.dice : null;
    const used = g.used || [false, false];
    const canMoveWith = (color, token, d) => movesFor(g, color, dice[d]).includes(token);
    const usable = myTurn && g.phase === "move" && dice
      ? [0, 1].filter((d) => !used[d] && myColors.some((c) => movesFor(g, c, dice[d]).length))
      : [];
    if (!usable.includes(selDie)) selDie = usable[0] ?? 0;
    // A token glows if either remaining die can move it; tapping uses the chosen die when it can.
    const dieFor = (color, token) => [selDie, ...usable].find((d) => usable.includes(d) && canMoveWith(color, token, d));
    const justRolled = g.seq !== lastSeq && dice && lastSeq !== -1 && g.phase !== "over" && !g.last;
    lastSeq = g.seq;
    const canRoll = myTurn && g.phase === "roll" && !busy;
    dieTappable = [0, 1].map((d) => !busy && (canRoll || usable.includes(d)));

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
        const movable = myColors.includes(color) && dieFor(color, i) !== undefined;
        if (movable) tokenActions.set(color + i, () => send({ type: "move", color, token: i, die: dieFor(color, i) }));
        const justMoved = !!g.last && g.last.color === color && g.last.token === i;
        pieces.push({ color, token: i, cell, n: cell.span === 1 ? n : 0, home: pos === HOME, movable, justMoved });
      });
    }
    if (view3d) {
      view3d.sync({
        colors, pieces, dice,
        rolled: !!justRolled,
        canRoll,
        tappable: dieTappable,
        used: [0, 1].map((d) => g.phase === "move" && !!used[d]),
        selected: [0, 1].map((d) => usable.length > 1 && selDie === d),
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
        board.appendChild(t);
        tokenLayer.push(t);
      }
    }

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
      btn.classList.toggle("selected", usable.length > 1 && selDie === d);
      btn.style.setProperty("--c", COLOR_HEX[colorsOf(current)[0]]);
    });
    const left = dice ? dice.filter((_, d) => !used[d]) : [];
    let status;
    if (g.phase === "over") status = `${nameOf(g.winner)} won!`;
    else if (myTurn && g.phase === "roll") status = "Your turn — tap the dice to roll";
    else if (myTurn) status = usable.length > 1 ? `Move ${dice[selDie]} — tap a glowing token (tap a die to switch)` : `Move ${left.join(" & ")} — tap a glowing token`;
    else status = `${nameOf(current.pid)}'s turn${g.phase === "move" && dice ? ` (rolled ${dice.join(" & ")})` : ""}`;
    statusEl.textContent = note || status;
    root.querySelector(".game-log").innerHTML = g.log.slice(-3).reverse().map((l) => `<li>${escapeHtml(l)}</li>`).join("");

    const over = root.querySelector(".game-over");
    over.hidden = g.phase !== "over";
    over.querySelector(".banner-title").textContent = g.winner === me ? "You won! 🎉" : `${nameOf(g.winner)} won!`;
  }

  return { update };
}

function movesFor(g, color, value) {
  if (!color || !value) return [];
  return g.tokens[color].map((pos, i) => ((pos === -1 ? value === 6 : pos + value <= HOME) ? i : -1)).filter((i) => i >= 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
