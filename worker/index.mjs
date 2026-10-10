// The server: a Cloudflare Worker that serves public/ and routes /api/room to one
// Durable Object per room. (Ported from the old Netlify function; same API.) It also has:
//   - /api/room/ws: a WebSocket that pushes the room's state to each member the moment it
//     changes (send {"type":"auth","token":"…"} first), so phones needn't poll every second;
//   - the computer's Ludo turns run on a timer (Durable Object alarm) instead of riding on polls.
//
// Room storage (Durable Object key → value):
//   roomId                       the room's id
//   info                         { name, members, meta, generated }
//   invite:<code>                { kind, pid?, expires, by }
//   state:<gameId>               Ludo / Whot game state – changed only through the rules
//   player:<gameId>:<pid>        { cells, cursor, seen } – one player's crossword letters
//   puzzle:<gameId>              generated crossword puzzle
// A room handles one request at a time, so read-change-write needs no locking.

import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes, randomInt } from "node:crypto";
import * as ludo from "../lib/games/ludo.mjs";
import * as whot from "../lib/games/whot.mjs";
import { generatePuzzle } from "../lib/generator.mjs";
import words from "../lib/words.mjs";

const ENGINES = { ludo, whot };
const BOT = ludo.BOT; // the computer's player id, the same in every game
const BOT_NAME = ludo.BOT_NAME;
const rand = () => randomInt(0, 2 ** 32) / 2 ** 32;
// Seats shift along by one each game, so the colours (and who starts) swap over.
const rotate = (seats, n) => seats.map((_, i) => seats[(i + n) % seats.length]);
const DEFAULT_PUZZLE = "puzzle-001";
const RANDOM_PUZZLE = "random";
const MEMBER_INVITE_MS = 7 * 24 * 3600 * 1000;
const DEVICE_INVITE_MS = 30 * 60 * 1000;
const MAX_TOKENS_PER_MEMBER = 10;
const MAX_MEMBERS = 8;
const BOT_DELAY_MS = 600; // pause before each computer action, so people can follow it
const ID = /^[a-z0-9-]{1,40}$/;
const SECRET = /^[a-f0-9]{16,64}$/;
const CELL = /^\d{1,2},\d{1,2}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

const random = (bytes) => randomBytes(bytes).toString("hex");
const hash = (token) => createHash("sha256").update(token).digest("hex");
const newGameId = () => `${Date.now().toString(36)}-${random(4)}`;
const json = (data, status = 200) => Response.json(data, { status });
const fail = (status, error) => json({ error }, status);
const cleanName = (v) => String(v ?? "").trim().slice(0, 24);
const cleanColor = (v) => (COLOR.test(String(v)) ? String(v) : "#3b82f6");

function memberFor(info, token) {
  if (!token || !SECRET.test(token)) return null;
  const h = hash(token);
  return Object.keys(info.members).find((pid) => info.members[pid].tokens.includes(h)) ?? null;
}

function addDevice(member) {
  const token = random(32);
  member.tokens = [...member.tokens, hash(token)].slice(-MAX_TOKENS_PER_MEMBER);
  return token;
}

// ---------- Worker: static files + routing to rooms ----------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/room" && url.pathname !== "/api/room/ws") return env.ASSETS.fetch(req);
    const roomStub = (room) => env.ROOMS.get(env.ROOMS.idFromName(room));

    if (req.method === "GET") {
      const room = url.searchParams.get("room") ?? "";
      if (!ID.test(room)) return fail(400, "invalid room");
      return roomStub(room).fetch(req);
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let body;
    try {
      body = await req.json();
    } catch {
      return fail(400, "invalid json");
    }
    if (body.action === "create") body.room = random(6);
    const room = String(body.room ?? "");
    if (!ID.test(room)) return fail(400, "invalid room");
    return roomStub(room).fetch(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) }));
  },
};

// ---------- one room ----------

export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
  }

  async info() {
    return this.storage.get("info");
  }

  async players(gameId) {
    const prefix = `player:${gameId}:`;
    const out = {};
    for (const [key, doc] of await this.storage.list({ prefix })) out[key.slice(prefix.length)] = doc;
    return out;
  }

  async stateFor(info, pid, known = {}) {
    const room = await this.storage.get("roomId");
    const members = Object.fromEntries(Object.entries(info.members).map(([id, m]) => [id, { name: m.name, color: m.color }]));
    const { gameId, game: type } = info.meta;
    const engine = type && ENGINES[type];
    const playerDocs = known.lean ? undefined : await this.players(gameId);
    const game = !engine ? null : known.game ?? (await this.storage.get(`state:${gameId}`));
    return {
      room, roomName: info.name, me: pid, meta: info.meta, members, players: playerDocs,
      game: game ? engine.view(game, pid) : null,
      now: Date.now(),
    };
  }

  // Sends every connected member their own view of the room (Whot hides other hands).
  // Devices whose token was logged out get disconnected.
  async broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const info = await this.info();
    const views = new Map();
    for (const ws of sockets) {
      const who = ws.deserializeAttachment();
      if (!who) continue;
      if (!info.members[who.pid]?.tokens.includes(who.h)) {
        ws.close(4003, "not a member");
        continue;
      }
      if (!views.has(who.pid)) views.set(who.pid, JSON.stringify(await this.stateFor(info, who.pid)));
      try { ws.send(views.get(who.pid)); } catch {}
    }
  }

  // ---------- the computer (Ludo and Whot) ----------

  // The game and engine waiting on the computer's move, or null if it isn't its turn.
  async botTurn(info) {
    const engine = info && ENGINES[info.meta.game];
    if (!engine?.botMove) return null;
    const state = await this.storage.get(`state:${info.meta.gameId}`);
    if (!state || engine.isOver(state) || engine.turnPid(state) !== BOT) return null;
    return { engine, state };
  }

  async scheduleBot(info) {
    if ((await this.botTurn(info)) && !(await this.storage.getAlarm())) {
      await this.storage.setAlarm(Date.now() + BOT_DELAY_MS);
    }
  }

  async alarm() {
    const info = await this.info();
    const turn = await this.botTurn(info);
    if (!turn) return;
    const { engine, state } = turn;
    const next = engine.play(state, BOT, engine.botMove(state, rand), rand, { [BOT]: BOT_NAME });
    if (next.error) return;
    next.at = Date.now();
    await this.storage.put(`state:${info.meta.gameId}`, next);
    await this.broadcast();
    await this.scheduleBot(info);
  }

  // ---------- live connection ----------

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (msg.type !== "auth") return;
    const info = await this.info();
    const pid = info && memberFor(info, msg.token);
    if (!pid) { ws.close(4003, "not a member"); return; }
    ws.serializeAttachment({ pid, h: hash(msg.token) });
    ws.send(JSON.stringify(await this.stateFor(info, pid)));
    await this.scheduleBot(info);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch {}
  }

  // ---------- requests ----------

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/room/ws") {
      if (req.headers.get("upgrade") !== "websocket") return fail(426, "expected a websocket");
      if (!(await this.info())) return fail(404, "room not found");
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;

    if (req.method === "GET") {
      const info = await this.info();
      if (!info) return fail(404, "room not found");
      const pid = memberFor(info, auth);
      if (!pid) return fail(403, "not a member of this room");
      if (url.searchParams.has("puzzle")) {
        const puzzle = await this.storage.get(`puzzle:${info.meta.gameId}`);
        return puzzle ? json({ gameId: info.meta.gameId, puzzle }) : fail(404, "no generated puzzle for this game");
      }
      await this.scheduleBot(info);
      return json(await this.stateFor(info, pid));
    }

    const body = await req.json();
    const room = body.room;

    // ----- no login needed -----

    if (body.action === "create") {
      const name = cleanName(body.name);
      if (!name) return fail(400, "name required");
      if (await this.info()) return fail(409, "try again"); // room id clash (practically never)
      const pid = random(5);
      const member = { name, color: cleanColor(body.color), tokens: [], joinedAt: Date.now() };
      const token = addDevice(member);
      const info = {
        name: cleanName(body.roomName) || `${name}'s room`,
        createdAt: Date.now(),
        members: { [pid]: member },
        meta: { gameId: newGameId(), game: "lobby", startedAt: Date.now() },
      };
      await this.storage.put({ roomId: room, info });
      return json({ room, pid, token, roomName: info.name });
    }

    if (body.action === "inviteInfo" || body.action === "join") {
      const code = String(body.invite ?? "");
      if (!SECRET.test(code)) return fail(404, "invite not found");
      const invite = await this.storage.get(`invite:${code}`);
      const info = await this.info();
      if (!invite || !info || invite.expires < Date.now()) return fail(404, "This invite link has expired or was already used.");
      const forPlayer = invite.kind === "device" ? info.members[invite.pid] : undefined;
      if (invite.kind === "device" && !forPlayer) return fail(404, "invite not found");

      if (body.action === "inviteInfo") {
        return json({
          kind: invite.kind,
          roomName: info.name,
          playerName: forPlayer?.name,
          members: Object.values(info.members).map((m) => m.name),
        });
      }

      await this.storage.delete(`invite:${code}`); // one use only
      let pid = invite.pid ?? "";
      let token;
      if (invite.kind === "device") {
        token = addDevice(info.members[pid]);
      } else {
        if (Object.keys(info.members).length >= MAX_MEMBERS) return fail(409, "This room is full.");
        pid = random(5);
        info.members[pid] = { name: cleanName(body.name) || "Player", color: cleanColor(body.color), tokens: [], joinedAt: Date.now() };
        token = addDevice(info.members[pid]);
      }
      await this.storage.put("info", info);
      await this.broadcast();
      return json({ room, pid, token, roomName: info.name });
    }

    // ----- members only -----

    const info = await this.info();
    if (!info) return fail(404, "room not found");
    const pid = memberFor(info, auth);
    if (!pid) return fail(403, "not a member of this room");

    if (body.action === "edit") {
      const { gameId, cells = {}, cursor } = body;
      if (gameId !== info.meta.gameId) return json(await this.stateFor(info, pid));
      const entries = Object.entries(cells);
      if (entries.length > 400) return fail(400, "too many cells");
      for (const [k, letter] of entries) {
        if (!CELL.test(k) || typeof letter !== "string" || !/^[A-Z]?$/.test(letter)) return fail(400, "invalid cell");
      }
      const key = `player:${gameId}:${pid}`;
      const doc = (await this.storage.get(key)) ?? { cells: {}, cursor: null, seen: 0 };
      const t = Date.now();
      for (const [k, letter] of entries) doc.cells[k] = [letter, t];
      if (cursor && Number.isInteger(cursor.r) && Number.isInteger(cursor.c)) {
        doc.cursor = { r: cursor.r, c: cursor.c, dir: cursor.dir === "down" ? "down" : "across" };
      }
      doc.seen = t;
      await this.storage.put(key, doc);
      this.ctx.waitUntil(this.broadcast()); // letters, cursor and "seen" for the others
      return json({ t, ...(await this.stateFor(info, pid)) });
    }

    if (body.action === "new") {
      const game = ENGINES[body.game] ? body.game : "crossword";
      const puzzleId = String(body.puzzleId ?? DEFAULT_PUZZLE);
      if (!ID.test(puzzleId)) return fail(400, "invalid puzzle");
      // Both players may press "new game" together; only start one new game per old one.
      if (info.meta.gameId !== body.fromGameId) return json(await this.stateFor(info, pid));
      const gameId = newGameId();
      if (ENGINES[game]) {
        let seated;
        if (body.vsComputer) {
          seated = [pid, BOT];
        } else {
          // Everyone in the room plays (up to 4), in the order they joined.
          seated = Object.entries(info.members).sort(([, a], [, b]) => a.joinedAt - b.joinedAt).map(([id]) => id);
          if (seated.length < 2) return fail(400, "Invite someone to the room first — this game needs at least 2 players.");
        }
        // Each game in this room shifts the seats along one, so nobody keeps the same colours.
        const round = info.round ?? 0;
        info.round = round + 1;
        const opts = { noSafe: !!body.noSafe }; // Ludo only; Whot ignores it
        await this.storage.put(`state:${gameId}`, { ...ENGINES[game].newGame(rotate(seated, round), rand, opts), at: Date.now() });
      } else if (puzzleId === RANDOM_PUZZLE) {
        info.generated = (info.generated ?? 0) + 1;
        await this.storage.put(`puzzle:${gameId}`, generatePuzzle(words, { id: `${RANDOM_PUZZLE}-${gameId}`, title: `Puzzle #${info.generated}` }));
      }
      // Clear out the old game.
      const old = info.meta.gameId;
      const oldKeys = [`state:${old}`, `puzzle:${old}`, ...(await this.storage.list({ prefix: `player:${old}:` })).keys()];
      await this.storage.delete(oldKeys);
      info.meta = ENGINES[game] ? { gameId, game, startedAt: Date.now() } : { gameId, game, puzzleId, startedAt: Date.now() };
      await this.storage.put("info", info);
      await this.broadcast();
      await this.scheduleBot(info);
      return json(await this.stateFor(info, pid));
    }

    if (body.action === "play") {
      const { gameId, game: type } = info.meta;
      const engine = type && ENGINES[type];
      if (!engine || body.gameId !== gameId) return fail(409, "That game has ended.");
      const names = Object.fromEntries(Object.entries(info.members).map(([id, m]) => [id, m.name]));
      names[BOT] = BOT_NAME;
      const state = await this.storage.get(`state:${gameId}`);
      if (!state) return fail(404, "game not found");
      const next = engine.play(state, pid, body.move ?? {}, rand, names);
      if (next.error) return fail(422, next.error);
      next.at = Date.now();
      await this.storage.put(`state:${gameId}`, next);
      this.ctx.waitUntil(this.broadcast());
      await this.scheduleBot(info);
      return json(await this.stateFor(info, pid, { game: next, lean: true }));
    }

    if (body.action === "profile") {
      const name = cleanName(body.name);
      if (name) info.members[pid].name = name;
      info.members[pid].color = cleanColor(body.color);
      await this.storage.put("info", info);
      this.ctx.waitUntil(this.broadcast());
      return json(await this.stateFor(info, pid));
    }

    if (body.action === "invite") {
      const kind = body.kind === "device" ? "device" : "member";
      const code = random(16);
      const expires = Date.now() + (kind === "device" ? DEVICE_INVITE_MS : MEMBER_INVITE_MS);
      await this.storage.put(`invite:${code}`, { kind, expires, by: pid, ...(kind === "device" ? { pid } : {}) });
      return json({ code, expires });
    }

    if (body.action === "logout") {
      info.members[pid].tokens = info.members[pid].tokens.filter((h) => h !== hash(auth));
      await this.storage.put("info", info);
      this.ctx.waitUntil(this.broadcast());
      return json({ ok: true });
    }

    return fail(400, "unknown action");
  }
}
