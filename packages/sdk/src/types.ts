export type Recipient = "all" | string | string[];

export interface RoomMessage {
  id: string;
  seq: number;
  from: string;
  to: Recipient;
  reply_to: string | null;
  intent: string;
  priority: string;
  body: unknown;
  created_at: string;
  /** Set when the sender asked for a reply; open until a reply (reply_to = this id) arrives. */
  expects_reply?: { due_at: string };
  /** Set by clients on a message they could not decrypt; the body is then still the encrypted envelope. */
  decrypt_error?: string;
}

// ── Shared participant/board types used by SDK client and server DO ──

export type SessionPhase = "waiting" | "ready" | "closed";

/** Server-side participant record. Matches DO state and SDK response shapes. */
export interface Participant {
  id: string;
  joined_at: string;
  last_seen_at: string;
  last_read_seq: number;
  state: "free" | "busy";
  status: string;
  status_updated_at: string;
  model?: string;
  /** Which API serves this model, e.g. anthropic, openai, openrouter. */
  provider?: string;
  skills?: string[];
  /** What the agent can do, e.g. code, shell, browser, screenshot, vision, web_search, files. */
  capabilities?: string[];
  /** Where the agent works ({ path, repo, branch }), sealed with the room key (`jsk1:`): the server only stores ciphertext. */
  workspace?: string;
  left_at?: string;
  /** ECDH P-256 public key announced during join, base64url-encoded. */
  public_key?: string;
  /** Hashed per-participant token (replaces join_secret for this participant after join). */
  tokenHash?: string;
  /** Private opt-in push target: the server POSTs this participant's visible room events here. Without it, poll. */
  webhook_url?: string;
}

// ── Server response types ───────────────────────────────────────

export interface RoomInfo {
  room_id: string;
  name: string;
  purpose: string;
  host_id: string;
  max_participants: number;
}

export interface ParticipantsResponse {
  room: RoomInfo;
  participants: Participant[];
}

export interface RoomStatusResponse {
  room: RoomInfo;
  participants: Participant[];
  message_count: number;
  last_seq: number;
  oldest_seq: number;
  expires_at: string;
  closed: boolean;
}

export interface BoardEntry {
  value: unknown;
  updated_by: string;
  updated_at: string;
  /** 1 on create, +1 on every write. Entries stored before versioning have none and count as 1. */
  version?: number;
}

/** A board key's new value and version, or null when the key was deleted. */
export type BoardChange = { value: unknown; version: number } | null;

export interface BoardResponse {
  board: Record<string, BoardEntry>;
  board_schema: Record<string, unknown> | null;
}

export interface SendResult {
  ok: true;
  id: string;
  seq: number;
}

export interface RoomExportResponse {
  room: RoomInfo;
  phase: string;
  participants: Record<string, Participant>;
  messages: RoomMessage[];
  board: Record<string, BoardEntry>;
  board_schema: Record<string, unknown> | null;
  next_seq: number;
  expires_at: string;
}
