// Generates many puzzles and checks each one is well-formed.
import words from "../lib/words.mjs";
import { generatePuzzle } from "../lib/generator.mjs";
import { buildPuzzle } from "../public/crossword.js";

const seen = new Set();
const dupes = words.map(([w]) => w).filter((w) => seen.has(w) || !seen.add(w));
if (dupes.length) { console.error("duplicate words:", dupes.join(", ")); process.exit(1); }

const runs = Number(process.argv[2] ?? 50);
const t0 = Date.now();
const counts = [];
for (let i = 0; i < runs; i++) {
  const data = generatePuzzle(words);
  const p = buildPuzzle(data);
  for (const w of p.words) if (!w.clue) throw new Error(`missing clue ${w.num} ${w.dir}`);
  if (data.rows.some((r) => r.length !== data.rows[0].length)) throw new Error("ragged rows");
  counts.push(p.words.length);
  if (i === 0) console.log(data.rows.join("\n"));
}
console.log(`${runs} puzzles ok · words per puzzle ${Math.min(...counts)}–${Math.max(...counts)} · ${((Date.now() - t0) / runs).toFixed(0)} ms each · bank ${words.length} words`);
