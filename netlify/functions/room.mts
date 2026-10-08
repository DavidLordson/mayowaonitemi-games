// Shared game state for a room.
//
// Each player's device writes only its own blob (games/<gameId>/players/<playerId>),
// so two people typing at once never overwrite each other. Readers merge all
// players' blobs cell by cell, keeping the most recent letter.
import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

type CellEdit = [letter: string, t: number];
type PlayerDoc = {
  name: string;
  color: string;
  cells: Record<string, CellEdit>;
  cursor: { r: number; c: number; dir: "across" | "down" } | null;
  seen: number;
};
type Meta = { gameId: string; puzzleId: string; startedAt: number };

const DEFAULT_PUZZLE = "puzzle-001";
const ID = /^[a-z0-9-]{1,40}$/;
const CELL = /^\d{1,2},\d{1,2}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

const store = () => getStore({ name: "crossword", consistency: "strong" });
const newGameId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const bad = (msg: string) => Response.json({ error: msg }, { status: 400 });

async function getMeta(room: string): Promise<{ meta: Meta; etag?: string }> {
  const key = `rooms/${room}/meta`;
  const found = await store().getWithMetadata(key, { type: "json" });
  if (found) return { meta: found.data as Meta, etag: found.etag };
  const meta: Meta = { gameId: newGameId(), puzzleId: DEFAULT_PUZZLE, startedAt: Date.now() };
  const { modified } = await store().setJSON(key, meta, { onlyIfNew: true });
  if (modified) return { meta };
  // Someone else created it at the same moment; use theirs.
  const again = await store().getWithMetadata(key, { type: "json" });
  return { meta: again!.data as Meta, etag: again!.etag };
}

async function getPlayers(gameId: string): Promise<Record<string, PlayerDoc>> {
  const prefix = `games/${gameId}/players/`;
  const { blobs } = await store().list({ prefix });
  const docs = await Promise.all(blobs.map((b) => store().get(b.key, { type: "json" })));
  const players: Record<string, PlayerDoc> = {};
  blobs.forEach((b, i) => {
    if (docs[i]) players[b.key.slice(prefix.length)] = docs[i] as PlayerDoc;
  });
  return players;
}

async function roomState(room: string) {
  const { meta } = await getMeta(room);
  return { meta, players: await getPlayers(meta.gameId), now: Date.now() };
}

export default async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const room = url.searchParams.get("room") ?? "main";
    if (!ID.test(room)) return bad("invalid room");
    return Response.json(await roomState(room));
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad("invalid json");
  }
  const room = String(body.room ?? "");
  if (!ID.test(room)) return bad("invalid room");

  if (body.action === "edit") {
    const { gameId, player, cells = {}, cursor } = body;
    if (!ID.test(String(gameId))) return bad("invalid game");
    if (!player || !ID.test(String(player.id))) return bad("invalid player");
    const entries = Object.entries(cells);
    if (entries.length > 400) return bad("too many cells");
    for (const [key, letter] of entries) {
      if (!CELL.test(key) || typeof letter !== "string" || !/^[A-Z]?$/.test(letter)) return bad("invalid cell");
    }

    // Only this player's device writes this key, and it sends one request at a time,
    // so this read-merge-write never races with another writer.
    const key = `games/${gameId}/players/${player.id}`;
    const doc = ((await store().get(key, { type: "json" })) as PlayerDoc | null) ?? {
      name: "",
      color: "#3b82f6",
      cells: {},
      cursor: null,
      seen: 0,
    };
    const t = Date.now();
    for (const [cellKey, letter] of entries) doc.cells[cellKey] = [letter as string, t];
    doc.name = String(player.name ?? "").slice(0, 24);
    if (COLOR.test(String(player.color))) doc.color = player.color;
    if (cursor === null) doc.cursor = null;
    else if (cursor && Number.isInteger(cursor.r) && Number.isInteger(cursor.c)) {
      doc.cursor = { r: cursor.r, c: cursor.c, dir: cursor.dir === "down" ? "down" : "across" };
    }
    doc.seen = t;
    await store().setJSON(key, doc);
    return Response.json({ t, ...(await roomState(room)) });
  }

  if (body.action === "new") {
    const puzzleId = String(body.puzzleId ?? DEFAULT_PUZZLE);
    if (!ID.test(puzzleId)) return bad("invalid puzzle");
    const { meta, etag } = await getMeta(room);
    // Both players may press "new game" together; only start one new game per old one.
    if (meta.gameId === body.fromGameId) {
      const next: Meta = { gameId: newGameId(), puzzleId, startedAt: Date.now() };
      await store().setJSON(`rooms/${room}/meta`, next, etag ? { onlyIfMatch: etag } : {});
    }
    return Response.json(await roomState(room));
  }

  return bad("unknown action");
};

export const config: Config = { path: "/api/room" };
