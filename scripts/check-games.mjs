// Plays many random Ludo and Whot games to the end and checks the rules hold up.
import * as ludo from "../lib/games/ludo.mjs";
import * as whot from "../lib/games/whot.mjs";

const games = Number(process.argv[2] ?? 200);
const rand = Math.random;
const pick = (a) => a[Math.floor(rand() * a.length)];
const fail = (msg) => { console.error(msg); process.exit(1); };

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
      const die = pick(ludo.usableDice(s, p.color));
      move = { type: "move", die, token: pick(ludo.movesFor(s, p.color, s.dice[die])) };
      if (!ludo.play(s, p.pid, { ...move, die: 1 - die }, rand).error && s.used[1 - die]) fail("ludo: reused a die");
    }
    const next = ludo.play(s, p.pid, move, rand);
    if (next.error) fail(`ludo error: ${next.error}`);
    for (const pl of next.players) for (const pos of next.tokens[pl.color]) if (pos < -1 || pos > ludo.HOME) fail("ludo: bad position");
    s = next;
    ludoTurns++;
  }
}
console.log(`ludo: ${games} games finished ok (${Math.round(ludoTurns / games)} actions per game)`);

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
