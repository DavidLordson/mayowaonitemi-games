// Plays many random Ludo and Whot games to the end and checks the rules hold up.
import * as ludo from "../lib/games/ludo.mjs";
import * as whot from "../lib/games/whot.mjs";

const games = Number(process.argv[2] ?? 200);
const rand = Math.random;
const pick = (a) => a[Math.floor(rand() * a.length)];
const fail = (msg) => { console.error(msg); process.exit(1); };
// The dice give a dry player a growing chance of a 6; by the 8th dry roll it's certain,
// so nobody can go more than this many rolls in a row without one.
const DRY_LIMIT = 7;

let ludoTurns = 0;
for (let g = 0; g < games; g++) {
  const pids = ["a", "b", "c", "d"].slice(0, 2 + (g % 3));
  let s = ludo.newGame(pids);
  for (let step = 0; s.phase !== "over"; step++) {
    if (step > 20000) fail("ludo game never ended");
    const p = s.players[s.turn];
    const other = s.players[(s.turn + 1) % s.players.length];
    if (!ludo.play(s, other.pid, { type: "roll" }, rand).error) fail("ludo: played out of turn");
    let move = { type: "roll" };
    if (s.phase === "move") {
      const die = pick(ludo.usableDice(s, p));
      const color = pick(ludo.colorsOf(p).filter((c) => ludo.movesFor(s, c, s.dice[die]).length));
      move = { type: "move", die, color, token: pick(ludo.movesFor(s, color, s.dice[die])) };
      const theirs = ludo.colorsOf(other)[0];
      if (!ludo.play(s, p.pid, { ...move, color: theirs }, rand).error) fail("ludo: moved someone else's token");
      if (!ludo.play(s, p.pid, { ...move, die: 1 - die }, rand).error && s.used[1 - die]) fail("ludo: reused a die");
    }
    const next = ludo.play(s, p.pid, move, rand);
    if (next.error) fail(`ludo error: ${next.error}`);
    for (const pl of next.players) for (const c of ludo.colorsOf(pl)) for (const pos of next.tokens[c]) if (pos < -1 || pos > ludo.HOME) fail("ludo: bad position");
    if (next.phase === "over" && !ludo.colorsOf(next.players.find((x) => x.pid === next.winner)).every((c) => next.tokens[c].every((t) => t === ludo.HOME))) fail("ludo: won early");
    s = next;
    ludoTurns++;
  }
}
// Both dice on one token: a 6 + 3 brings a yard token out and on to square 3.
{
  let s = ludo.newGame(["a", "b"]);
  s = { ...s, phase: "move", dice: [3, 6], used: [false, false] };
  const both = ludo.play(s, "a", { type: "both", color: "red", token: 0 }, rand);
  if (both.error || both.tokens.red[0] !== 3 || !both.used.every(Boolean)) fail("ludo: both dice on one token failed");
  if (!ludo.play({ ...s, dice: [3, 4] }, "a", { type: "both", color: "red", token: 0 }, rand).error) fail("ludo: both dice left the yard without a 6");
}
// A capture sends the victim to its yard and the capturer home, with no extra roll.
{
  let s = ludo.newGame(["a", "b"]);
  // red token on square 2; green token on track square 5 (green pos 44); red rolls 3 & 1
  s = { ...s, phase: "move", dice: [3, 1], used: [false, false], tokens: { ...s.tokens, red: [2, -1, -1, -1], green: [44, -1, -1, -1] } };
  let n = ludo.play(s, "a", { type: "move", color: "red", token: 0, die: 0 }, rand);
  if (n.error || n.tokens.green[0] !== -1 || n.tokens.red[0] !== ludo.HOME) fail("ludo: capture didn't send both pieces off");
  if (n.phase !== "roll" || n.turn !== 1) fail("ludo: capture gave an extra roll or kept the turn with nothing to play");
  // with another token out, the second die is still played before the turn passes
  s.tokens = { ...s.tokens, red: [2, 10, -1, -1] };
  n = ludo.play(s, "a", { type: "move", color: "red", token: 0, die: 0 }, rand);
  if (n.phase !== "move" || n.turn !== 0) fail("ludo: turn passed with a die still to play");
  // both dice as one jump: lands on 2 + 4 = 6, capturing only there
  s.tokens = { ...s.tokens, red: [2, -1, -1, -1], green: [44, -1, -1, -1] };
  n = ludo.play({ ...s, dice: [3, 1] }, "a", { type: "both", color: "red", token: 0 }, rand);
  if (n.error || n.tokens.red[0] !== 6 || n.tokens.green[0] !== 44) fail("ludo: sum move captured on the way");
}
// Getting a token home does not earn another roll.
{
  let s = ludo.newGame(["a", "b"]);
  s = { ...s, phase: "move", dice: [2, 1], used: [false, true], tokens: { ...s.tokens, red: [54, -1, -1, -1] } };
  const n = ludo.play(s, "a", { type: "move", color: "red", token: 0, die: 0 }, rand);
  if (n.tokens.red[0] !== ludo.HOME || n.turn !== 1) fail("ludo: token home gave an extra roll");
}
const two = ludo.newGame(["a", "b"]);
if (two.players[0].colors.join() !== "red,yellow" || two.players[1].colors.join() !== "green,blue") fail("ludo: 2-player houses wrong");

// House rule: no safe squares. A star (track square 8) protects by default and doesn't here.
{
  // green sits on track square 8 (green pos 47); red moves 2 -> 8 and lands on it.
  const setup = (s) => ({ ...s, phase: "move", dice: [6, 1], used: [false, false],
    tokens: { ...s.tokens, red: [2, -1, -1, -1], green: [47, -1, -1, -1] } });
  const safe = ludo.play(setup(ludo.newGame(["a", "b"])), "a", { type: "move", color: "red", token: 0, die: 0 }, rand);
  if (safe.error || safe.tokens.green[0] !== 47) fail("ludo: a star square didn't protect");
  const open = ludo.play(setup(ludo.newGame(["a", "b"], rand, { noSafe: true })), "a", { type: "move", color: "red", token: 0, die: 0 }, rand);
  if (open.error || open.tokens.green[0] !== -1 || open.tokens.red[0] !== ludo.HOME) fail("ludo: noSafe didn't allow a capture on a star");
  console.log("ludo: safe squares protect, and the no-safe-squares rule turns that off");
}

// Nobody should wait long for a 6: after a few dry rolls the chance grows to a certainty.
{
  let s = ludo.newGame(["a", "b"]);
  let worst = 0, dry = 0, sixes = 0;
  for (let i = 0; i < 20000; i++) {
    // Roll for "a" every time, ignoring whose turn it is: this tests the dice, not the turns.
    const next = ludo.play({ ...s, turn: 0, phase: "roll" }, "a", { type: "roll" }, rand);
    if (next.error) fail(`ludo dice error: ${next.error}`);
    s = next;
    if (s.dice.includes(6)) { sixes++; dry = 0; } else { dry++; worst = Math.max(worst, dry); }
  }
  if (worst > DRY_LIMIT) fail(`ludo: went ${worst} rolls without a 6 (limit ${DRY_LIMIT})`);
  const share = sixes / 20000;
  if (share < 0.3 || share > 0.65) fail(`ludo: ${Math.round(share * 100)}% of rolls had a 6 — out of the expected range`);
  console.log(`ludo: a 6 in ${Math.round(share * 100)}% of rolls, never more than ${worst} rolls without one`);
}
console.log(`ludo: ${games} games finished ok (${Math.round(ludoTurns / games)} actions per game)`);

// The computer only makes legal moves, finishes games, and beats a random player most of the time.
{
  let botWins = 0;
  for (let g = 0; g < games; g++) {
    let s = ludo.newGame([ludo.BOT, "h"]);
    for (let step = 0; s.phase !== "over"; step++) {
      if (step > 20000) fail("ludo bot game never ended");
      const p = s.players[s.turn];
      let move = { type: "roll" };
      if (p.pid === ludo.BOT) move = ludo.botMove(s, rand);
      else if (s.phase === "move") {
        const die = pick(ludo.usableDice(s, p));
        const color = pick(ludo.colorsOf(p).filter((c) => ludo.movesFor(s, c, s.dice[die]).length));
        move = { type: "move", die, color, token: pick(ludo.movesFor(s, color, s.dice[die])) };
      }
      const next = ludo.play(s, p.pid, move, rand);
      if (next.error) fail(`ludo bot error: ${next.error} (${JSON.stringify(move)})`);
      s = next;
    }
    if (s.winner === ludo.BOT) botWins++;
  }
  if (botWins < games * 0.6) fail(`ludo: computer won only ${botWins}/${games} against random moves`);
  console.log(`ludo: computer beat random moves in ${botWins}/${games} games`);
}

// A 2 can be blocked with another 2, and the pick grows.
{
  const two = (id, shape) => ({ id, shape, n: 2 });
  let s = whot.newGame(["a", "b"], rand);
  s.players[0].hand = [two(100, "circle"), { id: 101, shape: "star", n: 7 }];
  s.players[1].hand = [two(102, "square"), { id: 103, shape: "cross", n: 3 }];
  s.pile = [{ id: 104, shape: "circle", n: 4 }];
  s = whot.play(s, "a", { type: "play", card: 100 }, rand);
  if (s.pending !== 2 || s.turn !== 1) fail("whot: pick two not pending on the next player");
  if (!whot.play(s, "b", { type: "play", card: 103 }, rand).error) fail("whot: non-2 allowed while a pick is pending");
  s = whot.play(s, "b", { type: "play", card: 102 }, rand);
  if (s.pending !== 4 || s.turn !== 0) fail("whot: block didn't pass pick four back");
  const before = s.players[0].hand.length;
  s = whot.play(s, "a", { type: "market" }, rand);
  if (s.players[0].hand.length !== before + 4 || s.pending !== 0 || s.turn !== 1) fail("whot: picking four went wrong");
  console.log("whot: blocking a 2 with a 2 works");
}

let whotTurns = 0, stuck = 0;
for (let g = 0; g < games; g++) {
  const pids = ["a", "b", "c", "d"].slice(0, 2 + (g % 3));
  let s = whot.newGame(pids, rand);
  for (let step = 0; !s.over; step++) {
    if (step > 5000) fail("whot game never ended");
    const me = s.players[s.turn];
    const playable = me.hand.filter((c) => whot.canPlay(s, c));
    const card = playable.length && rand() < 0.9 ? pick(playable) : null;
    const move = card ? { type: "play", card: card.id, request: pick(whot.SHAPES) } : { type: "market" };
    const next = whot.play(s, me.pid, move, rand);
    if (next.error) fail(`whot error: ${next.error}`);
    const total = next.market.length + next.pile.length + next.players.reduce((n, p) => n + p.hand.length, 0);
    if (total !== 54) fail(`whot: card count ${total}`);
    const v = whot.view(next, "a");
    if (v.players.some((p) => p.pid !== "a" && p.hand)) fail("whot: view leaks another hand");
    s = next;
    whotTurns++;
  }
  if (!s.players.some((p) => p.pid === s.winner && p.hand.length === 0)) stuck++;
}
console.log(`whot: ${games} games finished ok (${Math.round(whotTurns / games)} moves per game, ${stuck} ended on empty market)`);

// The Whot computer only makes legal moves, finishes games, and beats a random player most of the time.
{
  let botWins = 0;
  for (let g = 0; g < games; g++) {
    let s = whot.newGame([whot.BOT, "h"], rand);
    for (let step = 0; !s.over; step++) {
      if (step > 5000) fail("whot bot game never ended");
      const me = s.players[s.turn];
      let move;
      if (me.pid === whot.BOT) move = whot.botMove(s, rand);
      else {
        const playable = me.hand.filter((c) => whot.canPlay(s, c));
        const card = playable.length ? pick(playable) : null;
        move = card ? { type: "play", card: card.id, request: pick(whot.SHAPES) } : { type: "market" };
      }
      const next = whot.play(s, me.pid, move, rand);
      if (next.error) fail(`whot bot error: ${next.error} (${JSON.stringify(move)})`);
      s = next;
    }
    if (s.winner === whot.BOT) botWins++;
  }
  if (botWins < games * 0.5) fail(`whot: computer won only ${botWins}/${games} against random moves`);
  console.log(`whot: computer beat random moves in ${botWins}/${games} games`);
}
