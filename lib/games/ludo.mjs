// Ludo rules, played with two dice. Pure functions: the server supplies randomness and stores the result.
//
// Each token's position is its progress from its own start square:
//   -1 = in the yard, 0–50 = on the shared track, 51–55 = own home column, 56 = home.
// Track squares are numbered 0–51 clockwise; each colour starts at START[colour].
//
// With two players each plays two opposite houses (red + yellow vs green + blue) and needs
// all eight tokens home; with three or four players each has one house.
//
// A turn: roll both dice, then use each die once on any token (split them or use both on one).
// A die showing 6 can bring a token out of the yard. Double 6, a capture, or getting a token
// home earns another roll once both dice are used.

export const COLORS = ["red", "green", "yellow", "blue"];
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };
export const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // start squares and stars
export const HOME = 56;
const LAST_TRACK = 50;
const SEATS = { 2: [["red", "yellow"], ["green", "blue"]], 3: [["red"], ["green"], ["yellow"]], 4: COLORS.map((c) => [c]) };

export const trackIndex = (color, pos) => (START[color] + pos) % 52;

export function newGame(pids) {
  const seats = SEATS[Math.min(Math.max(pids.length, 2), 4)];
  const players = pids.slice(0, 4).map((pid, i) => ({ pid, colors: seats[i] }));
  return {
    type: "ludo",
    players,
    tokens: Object.fromEntries(players.flatMap((p) => p.colors).map((c) => [c, [-1, -1, -1, -1]])),
    turn: 0,
    phase: "roll", // "roll" | "move" | "over"
    dice: null, // [a, b]
    used: [false, false],
    bonus: false, // another roll is due after this one
    winner: null,
    last: null, // { color, token, from, to, captured: [{color, token}] }
    log: [],
    seq: 0,
  };
}

const canMove = (pos, value) => (pos === -1 ? value === 6 : pos + value <= HOME);

// Tokens of `color` that can move by `value`.
export function movesFor(state, color, value) {
  return state.tokens[color].map((pos, token) => (canMove(pos, value) ? token : -1)).filter((t) => t >= 0);
}

export const colorsOf = (player) => player.colors ?? [player.color]; // older saved games had one colour

// Unused dice (by index) that can move at least one of the player's tokens.
export function usableDice(state, player) {
  if (!Array.isArray(state.dice)) return [];
  return [0, 1].filter((i) => !state.used[i] && colorsOf(player).some((c) => movesFor(state, c, state.dice[i]).length));
}

function nextTurn(state) {
  state.turn = (state.turn + 1) % state.players.length;
  state.phase = "roll";
  state.bonus = false;
}

function say(state, msg) {
  state.log = [...state.log, msg].slice(-6);
}

// After a roll or a move: keep moving, roll again, or pass the turn.
function settle(state, name) {
  const player = state.players[state.turn];
  if (usableDice(state, player).length) {
    state.phase = "move";
    return;
  }
  if (state.bonus) {
    state.phase = "roll";
    state.bonus = false;
    say(state, `${name} rolls again`);
  } else {
    nextTurn(state);
  }
}

// Returns the new state, or { error } if the move isn't allowed.
export function play(prev, pid, move, rand, names = {}) {
  const state = structuredClone(prev);
  if (!Array.isArray(state.dice) && state.phase === "move") state.phase = "roll"; // game saved by the one-die version
  const player = state.players[state.turn];
  if (state.phase === "over") return { error: "The game is over." };
  if (player.pid !== pid) return { error: "It's not your turn." };
  const name = names[pid] || colorsOf(player).join(" & ");

  if (move.type === "roll") {
    if (state.phase !== "roll") return { error: "Use your dice first." };
    const dice = [1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 6)];
    state.dice = dice;
    state.used = [false, false];
    state.bonus = dice[0] === 6 && dice[1] === 6;
    state.last = null;
    state.seq++;
    if (!usableDice(state, player).length) say(state, `${name} rolled ${dice[0]} & ${dice[1]} — no move`);
    else if (state.bonus) say(state, `${name} rolled double 6!`);
    settle(state, name);
    return state;
  }

  if (move.type === "move") {
    if (state.phase !== "move") return { error: "Roll the dice first." };
    const die = Number(move.die);
    const token = Number(move.token);
    const mine = colorsOf(player);
    const color = move.color ?? mine[0];
    if (!mine.includes(color)) return { error: "That's not your token." };
    if (!(die === 0 || die === 1) || state.used[die]) return { error: "That die is already used." };
    const value = state.dice[die];
    if (!movesFor(state, color, value).includes(token)) return { error: "That token can't move that far." };

    const tokens = state.tokens[color];
    const from = tokens[token];
    const to = from === -1 ? 0 : from + value;
    tokens[token] = to;
    state.used[die] = true;

    const captured = [];
    if (to <= LAST_TRACK) {
      const square = trackIndex(color, to);
      if (!SAFE.has(square)) {
        for (const other of state.players) {
          if (other === player) continue; // your own two houses never capture each other
          for (const oc of colorsOf(other)) {
            state.tokens[oc].forEach((pos, i) => {
              if (pos >= 0 && pos <= LAST_TRACK && trackIndex(oc, pos) === square) {
                state.tokens[oc][i] = -1;
                captured.push({ color: oc, token: i });
              }
            });
          }
        }
      }
    }
    state.last = { color, token, from, to, captured };
    state.seq++;
    if (captured.length) {
      const victims = captured.map((c) => {
        const owner = state.players.find((p) => colorsOf(p).includes(c.color));
        return names[owner.pid] || c.color;
      });
      say(state, `${name} captured ${[...new Set(victims)].join(" & ")}!`);
      state.bonus = true;
    }
    if (to === HOME) {
      say(state, `${name} got a token home`);
      state.bonus = true;
    }
    if (mine.every((c) => state.tokens[c].every((p) => p === HOME))) {
      state.phase = "over";
      state.winner = pid;
      say(state, `${name} wins! 🎉`);
      return state;
    }
    settle(state, name);
    return state;
  }

  return { error: "Unknown move." };
}

// Ludo has no hidden information.
export const view = (state) => state;
