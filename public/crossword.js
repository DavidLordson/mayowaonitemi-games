// Shared puzzle helpers (used by the browser app and the validation script).

export function buildPuzzle(data) {
  const grid = data.rows.map((row) => row.split(""));
  const height = grid.length;
  const width = grid[0].length;
  const open = (r, c) => r >= 0 && r < height && c >= 0 && c < width && grid[r][c] !== "#";
  const numbers = {};
  const words = [];
  let n = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!open(r, c)) continue;
      const startsAcross = !open(r, c - 1) && open(r, c + 1);
      const startsDown = !open(r - 1, c) && open(r + 1, c);
      if (!startsAcross && !startsDown) continue;
      n++;
      numbers[`${r},${c}`] = n;
      for (const [dir, go, dr, dc] of [["across", startsAcross, 0, 1], ["down", startsDown, 1, 0]]) {
        if (!go) continue;
        const cells = [];
        for (let rr = r, cc = c; open(rr, cc); rr += dr, cc += dc) cells.push([rr, cc]);
        words.push({ dir, num: n, cells, clue: data.clues[dir][n] ?? "" });
      }
    }
  }
  return { id: data.id, title: data.title, grid, width, height, numbers, words, open };
}
