# Mayowa & David — games

A collaborative crossword: two phones open the same link and fill in the grid together in real time.

- `public/` — the site (no build step). `public/puzzles/` holds puzzle files; add one there and list it in `index.json` to make it available for "New game".
- `netlify/functions/room.mts` — `/api/room`, the shared game state, stored in Netlify Blobs. Each player's device writes only its own record, so simultaneous typing never collides; phones poll about once a second.
- `npm run validate` — checks every puzzle's clue numbers match its grid (runs on every Netlify build).

Rooms: `/?room=name` gives a separate shared board (default room is `main`).

## Puzzle format

```json
{ "id": "puzzle-002", "title": "Puzzle 2",
  "rows": ["CAT#", "..."],            // answers, '#' for black squares
  "clues": { "across": { "1": "..." }, "down": { "1": "..." } } }
```
