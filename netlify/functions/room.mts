// Private rooms with invite links, and the shared game state inside them.
//
// Blobs:
//   rooms/<room>/info              { name, members, meta }  – who may enter, which game is on
//   rooms/<room>/invites/<code>    { kind, pid?, expires }  – one-time invite / device-login links
//   games/<gameId>/players/<pid>   { cells, cursor, seen }  – one player's letters
//   games/<gameId>/puzzle          puzzle JSON              – only for generated puzzles
//
// Every device holds a secret token; the room stores only its SHA-256 hash. A request
// is allowed into a room only if its token matches one of the room's members.
// Each player's letters live in their own blob, so two people typing at once never
// overwrite each other; readers merge all players' blobs cell by cell, newest wins.
import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { createHash, randomBytes } from "node:crypto";
import { generatePuzzle } from "../../lib/generator.mjs";
import words from "../../lib/words.mjs";

type Member = { name: string; color: string; tokens: string[]; joinedAt: number };
type Meta = { gameId: string; puzzleId: string; startedAt: number };
type Room = { name: string; createdAt: number; members: Record<string, Member>; meta: Meta; generated?: number };
type Invite = { kind: "member" | "device"; pid?: string; expires: number; by: string };
type PlayerDoc = {
  cells: Record<string, [letter: string, t: number]>;
  cursor: { r: number; c: number; dir: "across" | "down" } | null;
  seen: number;
};

const DEFAULT_PUZZLE = "puzzle-001";
const RANDOM_PUZZLE = "random"; // meta.puzzleId for generated puzzles; the puzzle itself is stored per game
const MEMBER_INVITE_MS = 7 * 24 * 3600 * 1000;
const DEVICE_INVITE_MS = 30 * 60 * 1000;
const MAX_TOKENS_PER_MEMBER = 10;
const MAX_MEMBERS = 8;
const ID = /^[a-z0-9-]{1,40}$/;
const SECRET = /^[a-f0-9]{16,64}$/;
const CELL = /^\d{1,2},\d{1,2}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

const store = () => getStore({ name: "crossword", consistency: "strong" });
const random = (bytes: number) => randomBytes(bytes).toString("hex");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newGameId = () => `${Date.now().toString(36)}-${random(4)}`;
const roomKey = (room: string) => `rooms/${room}/info`;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);

const cleanName = (v: unknown) => String(v ?? "").trim().slice(0, 24);
const cleanColor = (v: unknown) => (COLOR.test(String(v)) ? String(v) : "#3b82f6");

async function readRoom(room: string) {
  const found = await store().getWithMetadata(roomKey(room), { type: "json" });
  return found ? { data: found.data as Room, etag: found.etag } : null;
}

// Membership and the current game change rarely (joins, new games), so a conditional
// write with a few retries is enough to keep two simultaneous changes from clobbering.
async function updateRoom(room: string, change: (r: Room) => Room | null): Promise<Room | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readRoom(room);
    if (!current) return null;
    const next = change(structuredClone(current.data));
    if (!next) return current.data;
    const { modified } = await store().setJSON(roomKey(room), next, { onlyIfMatch: current.etag });
    if (modified) return next;
  }
  throw new Error("room is busy, try again");
}

function memberFor(roomData: Room, token: string | null) {
  if (!token || !SECRET.test(token)) return null;
  const h = hash(token);
  return Object.keys(roomData.members).find((pid) => roomData.members[pid].tokens.includes(h)) ?? null;
}

async function players(gameId: string) {
  const prefix = `games/${gameId}/players/`;
  const { blobs } = await store().list({ prefix });
  const docs = await Promise.all(blobs.map((b) => store().get(b.key, { type: "json" })));
  const out: Record<string, PlayerDoc> = {};
  blobs.forEach((b, i) => { if (docs[i]) out[b.key.slice(prefix.length)] = docs[i] as PlayerDoc; });
  return out;
}

async function stateFor(room: string, roomData: Room, pid: string) {
  const members = Object.fromEntries(
    Object.entries(roomData.members).map(([id, m]) => [id, { name: m.name, color: m.color }]),
  );
  return { room, roomName: roomData.name, me: pid, meta: roomData.meta, members, players: await players(roomData.meta.gameId), now: Date.now() };
}

function addDevice(member: Member) {
  const token = random(32);
  member.tokens = [...member.tokens, hash(token)].slice(-MAX_TOKENS_PER_MEMBER);
  return token;
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;

  if (req.method === "GET") {
    const room = url.searchParams.get("room") ?? "";
    if (!ID.test(room)) return fail(400, "invalid room");
    const current = await readRoom(room);
    if (!current) return fail(404, "room not found");
    const pid = memberFor(current.data, auth);
    if (!pid) return fail(403, "not a member of this room");
    if (url.searchParams.has("puzzle")) {
      const puzzle = await store().get(`games/${current.data.meta.gameId}/puzzle`, { type: "json" });
      return puzzle ? json({ gameId: current.data.meta.gameId, puzzle }) : fail(404, "no generated puzzle for this game");
    }
    return json(await stateFor(room, current.data, pid));
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid json");
  }

  // ----- no login needed -----

  if (body.action === "create") {
    const name = cleanName(body.name);
    if (!name) return fail(400, "name required");
    const room = random(6);
    const pid = random(5);
    const member: Member = { name, color: cleanColor(body.color), tokens: [], joinedAt: Date.now() };
    const token = addDevice(member);
    const data: Room = {
      name: cleanName(body.roomName) || `${name}'s room`,
      createdAt: Date.now(),
      members: { [pid]: member },
      meta: { gameId: newGameId(), puzzleId: DEFAULT_PUZZLE, startedAt: Date.now() },
    };
    await store().setJSON(roomKey(room), data, { onlyIfNew: true });
    return json({ room, pid, token, roomName: data.name });
  }

  const room = String(body.room ?? "");
  if (!ID.test(room)) return fail(400, "invalid room");

  if (body.action === "inviteInfo" || body.action === "join") {
    const code = String(body.invite ?? "");
    if (!SECRET.test(code)) return fail(404, "invite not found");
    const inviteKey = `rooms/${room}/invites/${code}`;
    const invite = (await store().get(inviteKey, { type: "json" })) as Invite | null;
    const current = await readRoom(room);
    if (!invite || !current || invite.expires < Date.now()) return fail(404, "This invite link has expired or was already used.");
    const forPlayer = invite.kind === "device" ? current.data.members[invite.pid!] : undefined;
    if (invite.kind === "device" && !forPlayer) return fail(404, "invite not found");

    if (body.action === "inviteInfo") {
      return json({
        kind: invite.kind,
        roomName: current.data.name,
        playerName: forPlayer?.name,
        members: Object.values(current.data.members).map((m) => m.name),
      });
    }

    // Use the invite up first so the same link can't let two people in.
    await store().delete(inviteKey);
    let pid = invite.pid ?? "";
    let token = "";
    const updated = await updateRoom(room, (r) => {
      if (invite.kind === "device") {
        if (!r.members[pid]) return null;
        token = addDevice(r.members[pid]);
      } else {
        if (Object.keys(r.members).length >= MAX_MEMBERS) return null;
        const name = cleanName(body.name) || "Player";
        pid = random(5);
        r.members[pid] = { name, color: cleanColor(body.color), tokens: [], joinedAt: Date.now() };
        token = addDevice(r.members[pid]);
      }
      return r;
    });
    if (!updated || !token) return fail(409, "This room is full.");
    return json({ room, pid, token, roomName: updated.name });
  }

  // ----- members only -----

  const current = await readRoom(room);
  if (!current) return fail(404, "room not found");
  const pid = memberFor(current.data, auth);
  if (!pid) return fail(403, "not a member of this room");

  if (body.action === "edit") {
    const { gameId, cells = {}, cursor } = body;
    if (gameId !== current.data.meta.gameId) return json(await stateFor(room, current.data, pid));
    const entries = Object.entries(cells);
    if (entries.length > 400) return fail(400, "too many cells");
    for (const [k, letter] of entries) {
      if (!CELL.test(k) || typeof letter !== "string" || !/^[A-Z]?$/.test(letter)) return fail(400, "invalid cell");
    }
    // Only this player writes this key, and each device sends one request at a time.
    const key = `games/${gameId}/players/${pid}`;
    const doc = ((await store().get(key, { type: "json" })) as PlayerDoc | null) ?? { cells: {}, cursor: null, seen: 0 };
    const t = Date.now();
    for (const [k, letter] of entries) doc.cells[k] = [letter as string, t];
    if (cursor && Number.isInteger(cursor.r) && Number.isInteger(cursor.c)) {
      doc.cursor = { r: cursor.r, c: cursor.c, dir: cursor.dir === "down" ? "down" : "across" };
    }
    doc.seen = t;
    await store().setJSON(key, doc);
    return json({ t, ...(await stateFor(room, current.data, pid)) });
  }

  if (body.action === "new") {
    const puzzleId = String(body.puzzleId ?? DEFAULT_PUZZLE);
    if (!ID.test(puzzleId)) return fail(400, "invalid puzzle");
    if (current.data.meta.gameId !== body.fromGameId) return json(await stateFor(room, current.data, pid));
    const gameId = newGameId();
    let generated = current.data.generated ?? 0;
    if (puzzleId === RANDOM_PUZZLE) {
      generated++;
      const puzzle = generatePuzzle(words, { id: `${RANDOM_PUZZLE}-${gameId}`, title: `Puzzle #${generated}` });
      await store().setJSON(`games/${gameId}/puzzle`, puzzle);
    }
    // Both players may press "new game" together; only start one new game per old one.
    const updated = await updateRoom(room, (r) => {
      if (r.meta.gameId !== body.fromGameId) return null;
      r.meta = { gameId, puzzleId, startedAt: Date.now() };
      r.generated = generated;
      return r;
    });
    return json(await stateFor(room, updated!, pid));
  }

  if (body.action === "profile") {
    const name = cleanName(body.name);
    const updated = await updateRoom(room, (r) => {
      if (name) r.members[pid].name = name;
      r.members[pid].color = cleanColor(body.color);
      return r;
    });
    return json(await stateFor(room, updated!, pid));
  }

  if (body.action === "invite") {
    const kind = body.kind === "device" ? "device" : "member";
    const code = random(16);
    const expires = Date.now() + (kind === "device" ? DEVICE_INVITE_MS : MEMBER_INVITE_MS);
    const invite: Invite = { kind, expires, by: pid, ...(kind === "device" ? { pid } : {}) };
    await store().setJSON(`rooms/${room}/invites/${code}`, invite);
    return json({ code, expires });
  }

  if (body.action === "logout") {
    await updateRoom(room, (r) => {
      r.members[pid].tokens = r.members[pid].tokens.filter((h) => h !== hash(auth!));
      return r;
    });
    return json({ ok: true });
  }

  return fail(400, "unknown action");
};

export const config: Config = { path: "/api/room" };
