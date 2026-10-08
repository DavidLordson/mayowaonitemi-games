// Whot (Nigerian rules). Pure functions; the server supplies randomness and hides other hands.
//
// Specials:  1 Hold on (play again) · 2 Pick two · 5 Pick three · 8 Suspension (next skips)
//           14 General market (everyone else picks one, you play again) · 20 Whot (wild, call a shape)
// Pick two can be blocked with another 2, which passes the (growing) pick on to the next player.
// Whoever finally picks — by going to market — loses their turn. Pick three can't be blocked.

export const SHAPES = ["circle", "triangle", "cross", "square", "star"];
const NUMBERS = {
  circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
  cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
  star: [1, 2, 3, 4, 5, 7, 8],
};
const HAND_SIZE = 5;

export function deck() {
  const cards = [];
  for (const shape of SHAPES) for (const n of NUMBERS[shape]) cards.push({ shape, n });
  for (let i = 0; i < 5; i++) cards.push({ shape: "whot", n: 20 });
  return cards.map((c, id) => ({ id, ...c }));
}

function shuffle(cards, rand) {
  const a = [...cards];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const label = (c) => (c.n === 20 ? "Whot" : `${c.shape} ${c.n}`);
const points = (c) => (c.shape === "star" ? c.n * 2 : c.n);

export function newGame(pids, rand) {
  const cards = shuffle(deck(), rand);
  const players = pids.slice(0, 4).map((pid) => ({ pid, hand: cards.splice(0, HAND_SIZE) }));
  // Start the pile with a plain card so the first player isn't hit by a special.
  const startAt = cards.findIndex((c) => ![1, 2, 5, 8, 14, 20].includes(c.n));
  const [top] = cards.splice(startAt, 1);
  return {
    type: "whot",
    players,
    market: cards,
    pile: [top],
    request: null, // shape asked for after a Whot
    pending: 0, // cards the current player must pick unless they block with a 2
    turn: 0,
    winner: null,
    over: false,
    log: [],
    seq: 0,
  };
}

export function canPlay(state, card) {
  if (state.pending) return card.n === 2;
  if (card.n === 20) return true;
  const top = state.pile[state.pile.length - 1];
  if (state.request) return card.shape === state.request;
  return card.shape === top.shape || card.n === top.n;
}

function say(state, msg) {
  state.log = [...state.log, msg].slice(-6);
}

// Draws up to `count` cards, reshuffling the pile (except the top card) when the market runs out.
function draw(state, player, count, rand) {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (!state.market.length) {
      const top = state.pile.pop();
      state.market = shuffle(state.pile, rand);
      state.pile = [top];
    }
    if (!state.market.length) break;
    player.hand.push(state.market.pop());
    drawn++;
  }
  return drawn;
}

const nextIndex = (state, i, steps = 1) => (i + steps) % state.players.length;

function finishIfStuck(state) {
  // No cards left anywhere to draw: lowest hand total wins.
  if (state.market.length || state.pile.length > 1) return false;
  const scored = state.players.map((p) => ({ pid: p.pid, total: p.hand.reduce((s, c) => s + points(c), 0) }));
  scored.sort((a, b) => a.total - b.total);
  state.over = true;
  state.winner = scored[0].pid;
  say(state, "Market is empty — lowest hand wins");
  return true;
}

// Returns the new state, or { error } if the move isn't allowed.
export function play(prev, pid, move, rand, names = {}) {
  const state = structuredClone(prev);
  if (state.over) return { error: "The game is over." };
  const me = state.players[state.turn];
  if (me.pid !== pid) return { error: "It's not your turn." };
  const who = names[pid] || "Player";

  if (move.type === "market") {
    if (state.pending) {
      const got = draw(state, me, state.pending, rand);
      say(state, `${who} picks ${got}`);
      state.pending = 0;
    } else {
      draw(state, me, 1, rand);
      say(state, `${who} went to market`);
    }
    state.turn = nextIndex(state, state.turn);
    state.seq++;
    finishIfStuck(state);
    return state;
  }

  if (move.type !== "play") return { error: "Unknown move." };
  const idx = me.hand.findIndex((c) => c.id === Number(move.card));
  if (idx === -1) return { error: "You don't have that card." };
  const card = me.hand[idx];
  if (!canPlay(state, card)) {
    if (state.pending) return { error: `Block with a 2, or go to market to pick ${state.pending}.` };
    return { error: state.request ? `You must play a ${state.request} or Whot.` : "That card doesn't match." };
  }
  if (card.n === 20 && !SHAPES.includes(move.request)) return { error: "Choose a shape to request." };

  me.hand.splice(idx, 1);
  state.pile.push(card);
  state.request = card.n === 20 ? move.request : null;
  state.seq++;
  say(state, card.n === 20 ? `${who} played Whot and wants ${move.request}` : `${who} played ${label(card)}`);

  if (!me.hand.length) {
    state.over = true;
    state.winner = pid;
    say(state, `${who} wins! 🎉`);
    return state;
  }
  if (me.hand.length === 1) say(state, `${who}: last card!`);

  const next = nextIndex(state, state.turn);
  const victim = state.players[next];
  const victimName = names[victim.pid] || "Next player";
  switch (card.n) {
    case 1: // Hold on
      say(state, "Hold on — play again");
      break;
    case 2: // Pick two — the next player can block with their own 2
      state.pending += 2;
      say(state, `${victimName}: pick ${state.pending} or block with a 2`);
      state.turn = next;
      break;
    case 5: {
      const got = draw(state, victim, 3, rand);
      say(state, `${victimName} picks ${got}`);
      state.turn = nextIndex(state, state.turn, 2);
      break;
    }
    case 8: // Suspension
      say(state, `${victimName} is suspended`);
      state.turn = nextIndex(state, state.turn, 2);
      break;
    case 14: // General market
      for (const p of state.players) if (p !== me) draw(state, p, 1, rand);
      say(state, "General market — everyone else picks one");
      break;
    default:
      state.turn = next;
  }
  finishIfStuck(state);
  return state;
}

// What one player is allowed to see: their own hand, everyone else's card count.
export function view(state, pid) {
  return {
    type: "whot",
    players: state.players.map((p) => ({ pid: p.pid, count: p.hand.length, ...(p.pid === pid ? { hand: p.hand } : {}) })),
    marketCount: state.market.length,
    top: state.pile[state.pile.length - 1],
    request: state.request,
    pending: state.pending,
    turn: state.turn,
    winner: state.winner,
    over: state.over,
    log: state.log,
    seq: state.seq,
  };
}
