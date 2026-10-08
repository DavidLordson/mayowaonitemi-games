# Mayowa & David — games

Private game rooms for playing together on separate phones:

- **Crossword** — fill in the grid together in real time (book puzzles or freshly generated ones).
- **Ludo** — two players each play two opposite houses (first to join: red + yellow; second: green + blue; all 8 tokens home to win). Two dice: use each die on any token (split or combine), a 6 brings a token out, double 6 / a capture / getting home earns another roll, stars and start squares are safe, exact roll to get home.
- **Whot** — Nigerian rules: 1 Hold on, 2 Pick two (block it with your own 2 — the pick stacks), 5 Pick three, 8 Suspension, 14 General market, 20 Whot (call a shape).

Opening a room shows its **lobby**: continue the game in progress or pick another (⌂ returns to it). Everyone in the room plays (up to 4); anyone waiting in the lobby is pulled into a newly started game.

- `public/` — the site (no build step). `public/puzzles/` holds puzzle files; add one there and list it in `index.json` to make it available for "New game".
- `netlify/functions/room.mts` — `/api/room`: private rooms, invite links and the shared game state, stored in Netlify Blobs. Each player's device writes only its own record, so simultaneous typing never collides; phones poll about once a second.
- `lib/generator.mjs` + `lib/words.mjs` — **New game → New random puzzle** builds a fresh criss-cross puzzle (~28 words) on the server from the word bank and stores it with the game, so everyone in the room gets the same one. Add `["WORD", "Clue"]` lines to `lib/words.mjs` for more variety.
- `lib/games/ludo.mjs`, `lib/games/whot.mjs` — the rules. They run on the server (dice, shuffling, move checks), so nobody can cheat from their browser, and in Whot each player only receives their own hand. `public/ludo.js` and `public/whot.js` draw the board/table.
- `npm run validate` — checks every puzzle's clue numbers match its grid generates sample puzzles, and plays hundreds of random Ludo and Whot games to the end (runs on every Netlify build).

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
