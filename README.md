# Mayowa & David — games

A collaborative crossword: two phones open the same link and fill in the grid together in real time.

- `public/` — the site (no build step). `public/puzzles/` holds puzzle files; add one there and list it in `index.json` to make it available for "New game".
- `netlify/functions/room.mts` — `/api/room`: private rooms, invite links and the shared game state, stored in Netlify Blobs. Each player's device writes only its own record, so simultaneous typing never collides; phones poll about once a second.
- `lib/generator.mjs` + `lib/words.mjs` — **New game → New random puzzle** builds a fresh criss-cross puzzle (~28 words) on the server from the word bank and stores it with the game, so everyone in the room gets the same one. Add `["WORD", "Clue"]` lines to `lib/words.mjs` for more variety.
- `npm run validate` — checks every puzzle's clue numbers match its grid and generates sample puzzles to check the generator (runs on every Netlify build).

## Rooms and logins

- Anyone can create a private room from the home page. The creator's device gets a secret login token (only its hash is stored).
- **Invite someone** (⋯ menu) makes a one-time link, valid 7 days. Opening it lets that person pick a name and join.
- **Log in on another device** makes a one-time link, valid 30 minutes, that signs another device in as the same player.
- Without a valid token, a room can't be read or written (the API returns 403).

## Puzzle format

```json
{ "id": "puzzle-002", "title": "Puzzle 2",
  "rows": ["CAT#", "..."],            // answers, '#' for black squares
  "clues": { "across": { "1": "..." }, "down": { "1": "..." } } }
```
