// Builds a random criss-cross crossword from a word bank.
//
// Words are placed one at a time so each new word crosses at least one placed word,
// and no two words ever sit side by side (which would spell accidental words).
// Several attempts are made and the most interlocked one is kept.
import { buildPuzzle } from "../public/crossword.js";

const DIRS = { across: [0, 1], down: [1, 0] };

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Board {
  constructor(size) {
    this.size = size;
    this.letters = Array.from({ length: size }, () => Array(size).fill(null));
    this.dirs = Array.from({ length: size }, () => Array(size).fill(""));
    this.placed = [];
  }

  at(r, c) {
    return r < 0 || c < 0 || r >= this.size || c >= this.size ? null : this.letters[r][c];
  }

  // Number of crossings if the word fits here, or -1 if it doesn't.
  fit(word, r, c, dir) {
    const [dr, dc] = DIRS[dir];
    const [pr, pc] = [dc, dr]; // perpendicular step
    const endR = r + dr * (word.length - 1);
    const endC = c + dc * (word.length - 1);
    if (r < 0 || c < 0 || endR >= this.size || endC >= this.size) return -1;
    if (this.at(r - dr, c - dc) || this.at(endR + dr, endC + dc)) return -1;
    let crossings = 0;
    for (let i = 0; i < word.length; i++) {
      const rr = r + dr * i, cc = c + dc * i;
      const existing = this.letters[rr][cc];
      if (existing) {
        if (existing !== word[i] || this.dirs[rr][cc].includes(dir)) return -1;
        crossings++;
      } else if (this.at(rr + pr, cc + pc) || this.at(rr - pr, cc - pc)) {
        return -1;
      }
    }
    return crossings === word.length ? -1 : crossings;
  }

  place(word, clue, r, c, dir) {
    const [dr, dc] = DIRS[dir];
    for (let i = 0; i < word.length; i++) {
      this.letters[r + dr * i][c + dc * i] = word[i];
      this.dirs[r + dr * i][c + dc * i] += dir;
    }
    this.placed.push({ word, clue, r, c, dir });
  }

  // Every spot where `word` would cross an existing letter.
  candidates(word) {
    const spots = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const letter = this.letters[r][c];
        if (!letter) continue;
        const dir = this.dirs[r][c] === "across" ? "down" : this.dirs[r][c] === "down" ? "across" : null;
        if (!dir) continue;
        const [dr, dc] = DIRS[dir];
        for (let i = 0; i < word.length; i++) {
          if (word[i] !== letter) continue;
          const sr = r - dr * i, sc = c - dc * i;
          const crossings = this.fit(word, sr, sc, dir);
          if (crossings > 0) spots.push({ r: sr, c: sc, dir, crossings });
        }
      }
    }
    return spots;
  }
}

function attempt(bank, { size, target, rand }) {
  const board = new Board(size);
  const words = shuffle(bank, rand);
  const [word, clue] = words.find(([w]) => w.length >= 7) ?? words[0];
  const mid = Math.floor(size / 2) + Math.floor(rand() * 3) - 1;
  const start = Math.floor((size - word.length) / 2);
  if (rand() < 0.5) board.place(word, clue, mid, start, "across");
  else board.place(word, clue, start, mid, "down");
  return grow(board, words, target, rand);
}

function grow(board, words, target, rand) {
  const used = new Set(board.placed.map((p) => p.word));
  for (let pass = 0; pass < 3 && board.placed.length < target; pass++) {
    for (const [word, clue] of words) {
      if (board.placed.length >= target) break;
      if (used.has(word) || word.length > board.size) continue;
      const spots = board.candidates(word);
      if (!spots.length) continue;
      // Prefer spots with more crossings, then pick randomly among the best.
      const best = Math.max(...spots.map((s) => s.crossings));
      const top = spots.filter((s) => s.crossings === best);
      const s = top[Math.floor(rand() * top.length)];
      board.place(word, clue, s.r, s.c, s.dir);
      used.add(word);
    }
  }
  return board;
}

function score(board) {
  let crossings = 0;
  for (const row of board.dirs) for (const d of row) if (d.length > 6) crossings++;
  return board.placed.length * 3 + crossings;
}

// Turns a finished board into the puzzle format the app uses.
function toPuzzle(board, id, title) {
  let top = board.size, left = board.size, bottom = 0, right = 0;
  for (let r = 0; r < board.size; r++) for (let c = 0; c < board.size; c++) {
    if (board.letters[r][c]) {
      top = Math.min(top, r); bottom = Math.max(bottom, r);
      left = Math.min(left, c); right = Math.max(right, c);
    }
  }
  const rows = [];
  for (let r = top; r <= bottom; r++) {
    let line = "";
    for (let c = left; c <= right; c++) line += board.letters[r][c] ?? "#";
    rows.push(line);
  }
  const byStart = new Map(board.placed.map((p) => [`${p.dir}:${p.r - top},${p.c - left}`, p]));
  const shape = buildPuzzle({ rows, clues: { across: {}, down: {} } });
  const clues = { across: {}, down: {} };
  for (const w of shape.words) {
    const p = byStart.get(`${w.dir}:${w.cells[0][0]},${w.cells[0][1]}`);
    if (!p || p.word.length !== w.cells.length) return null; // an accidental word slipped in
    clues[w.dir][w.num] = p.clue;
  }
  if (shape.words.length !== board.placed.length) return null;
  return { id, title, rows, clues };
}

export function generatePuzzle(bank, { id = "random", title = "Random puzzle", size = 13, target = 28, attempts = 30, rand = Math.random } = {}) {
  const clean = bank.filter(([w]) => /^[A-Z]{3,}$/.test(w) && w.length <= size);
  let best = null;
  for (let i = 0; i < attempts; i++) {
    const board = attempt(clean, { size, target, rand });
    const puzzle = toPuzzle(board, id, title);
    if (puzzle && (!best || score(board) > best.score)) best = { score: score(board), puzzle };
  }
  if (!best) throw new Error("could not build a puzzle");
  return best.puzzle;
}
