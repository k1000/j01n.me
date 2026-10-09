import { json } from "../format";
import type { Env } from "../types";

interface RoomRegistryEntry {
  room_id: string;
  expires_at: number;
  registered_at: number;
}

const ROOM_PREFIX = "room:";
const MCP_PREFIX = "mcp:";
const MCP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface McpSessionEntry {
  rooms: Array<{ room_url: string; participant_id: string }>;
  expires_at: number;
}
const REGISTRY_NAME = "global";

export class RoomRegistry implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/register") return this.register(request);
    if (request.method === "POST" && url.pathname === "/sweep") return this.sweep();
    if (url.pathname === "/mcp-session") return this.mcpSession(request);
    return new Response("not found", { status: 404 });
  }

  /**
   * Rooms joined by one MCP session (keyed by its server-minted Mcp-Session-Id): room URL + participant id only.
   * GET ?sid= lists them; POST { sid, room_url, participant_id, remove? } adds or removes one.
   */
  private async mcpSession(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      const entry = await this.state.storage.get<McpSessionEntry>(`${MCP_PREFIX}${url.searchParams.get("sid") ?? ""}`);
      return json({ rooms: entry && entry.expires_at > Date.now() ? entry.rooms : [] });
    }
    const body = await request.json().catch(() => ({})) as { sid?: string; room_url?: string; participant_id?: string; remove?: boolean };
    if (!body.sid || !body.room_url || !body.participant_id) return json({ error: "sid, room_url and participant_id are required" }, 400);
    const key = `${MCP_PREFIX}${body.sid}`;
    const current = await this.state.storage.get<McpSessionEntry>(key);
    const others = (current && current.expires_at > Date.now() ? current.rooms : [])
      .filter((r) => !(r.room_url === body.room_url && r.participant_id === body.participant_id));
    const rooms = body.remove ? others : [...others, { room_url: body.room_url, participant_id: body.participant_id }];
    await this.state.storage.put<McpSessionEntry>(key, { rooms, expires_at: Date.now() + MCP_SESSION_TTL_MS });
    return json({ rooms });
  }

  private async register(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const roomId = typeof body.room_id === "string" ? body.room_id : "";
    const expiresAt = typeof body.expires_at === "number" ? body.expires_at : 0;
    if (!roomId || !Number.isFinite(expiresAt)) return json({ error: "room_id and expires_at are required" }, 400);

    await this.state.storage.put<RoomRegistryEntry>(`${ROOM_PREFIX}${roomId}`, {
      room_id: roomId,
      expires_at: expiresAt,
      registered_at: Date.now(),
    });
    return json({ ok: true });
  }

  private async sweep(): Promise<Response> {
    const now = Date.now();
    const entries = await this.state.storage.list<RoomRegistryEntry>({ prefix: ROOM_PREFIX });
    let deleted = 0;
    let retained = 0;
    const errors: Array<{ room_id: string; error: string }> = [];

    for (const [key, entry] of entries) {
      if (entry.expires_at > now) {
        retained++;
        continue;
      }
      try {
        const id = this.env.RENDEZVOUS.idFromName(entry.room_id);
        const stub = this.env.RENDEZVOUS.get(id);
        const response = await stub.fetch("https://rendezvous.internal/__cleanup", { method: "POST" });
        if (response.ok || response.status === 404 || response.status === 410) {
          await this.state.storage.delete(key);
          deleted++;
        } else {
          errors.push({ room_id: entry.room_id, error: `${response.status} ${await response.text()}` });
        }
      } catch (error) {
        errors.push({ room_id: entry.room_id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return json({ ok: errors.length === 0, deleted, retained, errors });
  }
}

export async function registerRoom(env: Env, roomId: string, expiresAt: number): Promise<void> {
  if (!env.ROOM_REGISTRY) return;
  const id = env.ROOM_REGISTRY.idFromName(REGISTRY_NAME);
  const stub = env.ROOM_REGISTRY.get(id);
  await stub.fetch("https://room-registry.internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room_id: roomId, expires_at: expiresAt }),
  });
}

export async function sweepStaleRooms(env: Env): Promise<Response> {
  if (!env.ROOM_REGISTRY) return json({ ok: true, skipped: "ROOM_REGISTRY binding is not configured" });
  const id = env.ROOM_REGISTRY.idFromName(REGISTRY_NAME);
  const stub = env.ROOM_REGISTRY.get(id);
  return stub.fetch("https://room-registry.internal/sweep", { method: "POST" });
}
