// Checks every puzzle: rectangular grid, and clue numbers match the grid numbering.
import { readFileSync } from "node:fs";
import { buildPuzzle } from "../public/crossword.js";

const index = JSON.parse(readFileSync(new URL("../public/puzzles/index.json", import.meta.url)));
let failed = false;
for (const { id } of index) {
  const data = JSON.parse(readFileSync(new URL(`../public/puzzles/${id}.json`, import.meta.url)));
  const errors = [];
  if (data.rows.some((row) => row.length !== data.rows[0].length)) errors.push("rows differ in length");
  const p = buildPuzzle(data);
  for (const dir of ["across", "down"]) {
    const fromGrid = p.words.filter((w) => w.dir === dir).map((w) => String(w.num));
    const fromClues = Object.keys(data.clues[dir]);
    const missing = fromGrid.filter((k) => !fromClues.includes(k));
    const extra = fromClues.filter((k) => !fromGrid.includes(k));
    if (missing.length) errors.push(`${dir}: no clue for ${missing.join(", ")}`);
    if (extra.length) errors.push(`${dir}: clue without slot ${extra.join(", ")}`);
  }
  console.log(`${id}: ${errors.length ? errors.join("; ") : "ok"}`);
  failed ||= errors.length > 0;
}
process.exit(failed ? 1 : 0);
