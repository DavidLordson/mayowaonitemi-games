// Ludo rules. Pure functions: the server calls them with a random source and stores the result.
//
// Each token's position is its progress from its own start square:
//   -1 = in the yard, 0–50 = on the shared track, 51–55 = own home column, 56 = home.
// Track squares are numbered 0–51 clockwise; each colour starts at START[colour].

export const COLORS = ["red", "green", "yellow", "blue"];
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // start squares and stars
export const HOME = 56;
const LAST_TRACK = 50;
const SEATS = { 2: ["red", "yellow"], 3: ["red", "green", "yellow"], 4: COLORS };

export const trackIndex = (color, pos) => (START[color] + pos) % 52;

export function newGame(pids) {
  const seats = SEATS[Math.min(Math.max(pids.length, 2), 4)];
  const players = pids.slice(0, 4).map((pid, i) => ({ pid, color: seats[i] }));
  return {
    type: "ludo",
    players,
    tokens: Object.fromEntries(players.map((p) => [p.color, [-1, -1, -1, -1]])),
    turn: 0,
    phase: "roll", // "roll" | "move" | "over"
    dice: null,
    sixes: 0,
    winner: null,
    last: null, // { color, token, from, to, captured: [{color, token}] }
    log: [],
    seq: 0,
  };
}

export function movesFor(state, color, dice) {
  return state.tokens[color]
    .map((pos, token) => ({ token, pos }))
    .filter(({ pos }) => (pos === -1 ? dice === 6 : pos + dice <= HOME))
    .map(({ token }) => token);
}

function nextTurn(state) {
  state.turn = (state.turn + 1) % state.players.length;
  state.sixes = 0;
  state.phase = "roll";
}

function say(state, msg) {
  state.log = [...state.log, msg].slice(-6);
}

// Returns the new state, or { error } if the move isn't allowed.
export function play(prev, pid, move, rand, names = {}) {
  const state = structuredClone(prev);
  const player = state.players[state.turn];
  if (state.phase === "over") return { error: "The game is over." };
  if (player.pid !== pid) return { error: "It's not your turn." };
  const name = names[pid] || player.color;

  if (move.type === "roll") {
    if (state.phase !== "roll") return { error: "Move a token first." };
    const dice = 1 + Math.floor(rand() * 6);
    state.dice = dice;
    state.last = null;
    state.seq++;
    if (dice === 6 && ++state.sixes === 3) {
      say(state, `${name} rolled three 6s — turn lost`);
      nextTurn(state);
      return state;
    }
    const moves = movesFor(state, player.color, dice);
    if (!moves.length) {
      say(state, `${name} rolled ${dice} — no move`);
      if (dice === 6) state.phase = "roll"; // a 6 still earns another roll
      else nextTurn(state);
      return state;
    }
    state.phase = "move";
    return state;
  }

  if (move.type === "move") {
    if (state.phase !== "move") return { error: "Roll the dice first." };
    const token = Number(move.token);
    if (!movesFor(state, player.color, state.dice).includes(token)) return { error: "That token can't move." };
    const tokens = state.tokens[player.color];
    const from = tokens[token];
    const to = from === -1 ? 0 : from + state.dice;
    tokens[token] = to;

    const captured = [];
    if (to <= LAST_TRACK) {
      const square = trackIndex(player.color, to);
      if (!SAFE.has(square)) {
        for (const other of state.players) {
          if (other.color === player.color) continue;
          state.tokens[other.color].forEach((pos, i) => {
            if (pos >= 0 && pos <= LAST_TRACK && trackIndex(other.color, pos) === square) {
              state.tokens[other.color][i] = -1;
              captured.push({ color: other.color, token: i });
            }
          });
        }
      }
    }
    state.last = { color: player.color, token, from, to, captured };
    state.seq++;
    if (captured.length) {
      const victims = captured.map((c) => state.players.find((p) => p.color === c.color)).map((p) => names[p.pid] || p.color);
      say(state, `${name} captured ${[...new Set(victims)].join(" & ")}!`);
    }
    if (to === HOME) say(state, `${name} got a token home`);

    if (tokens.every((p) => p === HOME)) {
      state.phase = "over";
      state.winner = pid;
      say(state, `${name} wins! 🎉`);
      return state;
    }
    if (state.dice === 6 || captured.length || to === HOME) state.phase = "roll"; // bonus roll
    else nextTurn(state);
    return state;
  }

  return { error: "Unknown move." };
}

// Ludo has no hidden information.
export const view = (state) => state;
