// Whot table UI. The server deals, shuffles and checks every move; this shows your hand and sends plays.

const SHAPE_SVG = {
  circle: '<circle cx="50" cy="50" r="32"/>',
  triangle: '<polygon points="50,14 88,82 12,82"/>',
  cross: '<path d="M38 12h24v26h26v24H62v26H38V62H12V38h26z"/>',
  square: '<rect x="18" y="18" width="64" height="64"/>',
  star: '<polygon points="50,8 61,38 93,38 67,57 77,89 50,70 23,89 33,57 7,38 39,38"/>',
};
const SHAPES = Object.keys(SHAPE_SVG);
const SPECIAL = { 1: "Hold on", 2: "Pick two", 5: "Pick three", 8: "Suspension", 14: "General market", 20: "Whot" };

const shapeSvg = (shape, cls = "") => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true">${SHAPE_SVG[shape]}</svg>`;

function cardHtml(card, extra = "") {
  if (card.n === 20) {
    return `<div class="wcard whot20 ${extra}" data-id="${card.id}"><b class="tl">20</b><span class="whot-word">WHOT</span><b class="br">20</b></div>`;
  }
  return `<div class="wcard ${extra}" data-id="${card.id}" aria-label="${card.shape} ${card.n}">
    <b class="tl">${card.n}</b>${shapeSvg(card.shape, "big")}<b class="br">${card.n}</b></div>`;
}

function canPlay(g, card) {
  if (card.n === 20) return true;
  if (g.request) return card.shape === g.request;
  return card.shape === g.top.shape || card.n === g.top.n;
}

export function mount(root, ctx) {
  root.innerHTML = `
    <div class="whot">
      <div class="whot-opponents"></div>
      <div class="whot-table">
        <button class="whot-market" aria-label="Go to market">
          <div class="wcard back"><span>WHOT</span></div>
          <small class="market-count"></small>
        </button>
        <div class="whot-pile"></div>
      </div>
      <div class="whot-request" hidden></div>
      <div class="whot-status"></div>
      <div class="whot-hand"></div>
      <ul class="game-log"></ul>
      <dialog class="shape-pick">
        <form method="dialog" class="form">
          <p class="banner-title">Whot! Call a shape</p>
          <div class="shape-grid">${SHAPES.map((s) => `<button value="${s}">${shapeSvg(s)}<span>${s}</span></button>`).join("")}</div>
          <button value="">Cancel</button>
        </form>
      </dialog>
      <div class="game-over" hidden>
        <div class="banner-card"><p class="banner-title"></p><button class="primary">Play again</button></div>
      </div>
    </div>`;
  const hand = root.querySelector(".whot-hand");
  const statusEl = root.querySelector(".whot-status");
  const marketBtn = root.querySelector(".whot-market");
  const shapeDialog = root.querySelector(".shape-pick");
  let game = null;
  let busy = false;
  let note = "";
  let lastTopId = null;

  root.querySelector(".game-over button").onclick = () => ctx.newGame();
  marketBtn.onclick = () => send({ type: "market" });

  async function send(move) {
    if (busy) return;
    busy = true;
    note = "";
    try { await ctx.play(move); }
    catch (err) { note = err.message; }
    finally { busy = false; if (game) update(game); }
  }

  hand.onclick = (e) => {
    const el = e.target.closest(".wcard.playable");
    if (!el) return;
    const card = game.players.find((p) => p.hand)?.hand.find((c) => c.id === Number(el.dataset.id));
    if (!card) return;
    if (card.n !== 20) return send({ type: "play", card: card.id });
    shapeDialog.onclose = () => {
      if (shapeDialog.returnValue) send({ type: "play", card: card.id, request: shapeDialog.returnValue });
    };
    shapeDialog.returnValue = "";
    shapeDialog.showModal();
  };

  function update(g) {
    game = g;
    const me = ctx.me();
    const members = ctx.members();
    const nameOf = (pid) => (pid === me ? "You" : members[pid]?.name || "Player");
    const mine = g.players.find((p) => p.pid === me);
    const current = g.players[g.turn];
    const myTurn = !g.over && current.pid === me;

    root.querySelector(".whot-opponents").innerHTML = g.players
      .filter((p) => p.pid !== me)
      .map((p) => `<div class="whot-opp${!g.over && p.pid === current.pid ? " turn" : ""}">
          <div class="opp-name"><i style="--c:${members[p.pid]?.color || "#888"}"></i>${escapeHtml(nameOf(p.pid))}</div>
          <div class="opp-cards">${Array.from({ length: Math.min(p.count, 12) }, () => '<div class="wcard back mini"></div>').join("")}</div>
          <small>${p.count} card${p.count === 1 ? "" : "s"}${p.count === 1 ? " — last card!" : ""}</small>
        </div>`)
      .join("");

    const pile = root.querySelector(".whot-pile");
    if (g.top.id !== lastTopId) {
      pile.innerHTML = cardHtml(g.top, lastTopId === null ? "" : "landed");
      lastTopId = g.top.id;
    }
    root.querySelector(".market-count").textContent = `Market · ${g.marketCount}`;
    marketBtn.disabled = !myTurn || busy;
    marketBtn.classList.toggle("ready", myTurn && !busy);

    const req = root.querySelector(".whot-request");
    req.hidden = !g.request;
    if (g.request) req.innerHTML = `Wants ${shapeSvg(g.request, "inline")} <b>${g.request}</b>`;

    const cards = mine?.hand ?? [];
    hand.innerHTML = cards.map((c) => cardHtml(c, myTurn && !busy && canPlay(g, c) ? "playable" : myTurn ? "dim" : "")).join("");
    hand.classList.toggle("my-turn", myTurn);

    let status;
    if (g.over) status = g.winner === me ? "You won! 🎉" : `${nameOf(g.winner)} won`;
    else if (myTurn) {
      const playable = cards.some((c) => canPlay(g, c));
      status = playable ? "Your turn — play a highlighted card, or go to market" : "Your turn — nothing matches, go to market";
    } else status = `${nameOf(current.pid)}'s turn`;
    const top = g.top.n !== 20 && SPECIAL[g.top.n] && !g.over ? ` · ${SPECIAL[g.top.n]}` : "";
    statusEl.textContent = note || status + top;
    root.querySelector(".game-log").innerHTML = g.log.slice(-3).reverse().map((l) => `<li>${escapeHtml(l)}</li>`).join("");

    const over = root.querySelector(".game-over");
    over.hidden = !g.over;
    over.querySelector(".banner-title").textContent = g.winner === me ? "You won! 🎉" : `${nameOf(g.winner)} won!`;
  }

  return { update };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
