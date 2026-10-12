export type Recipient = "all" | string | string[];
export type MessageKind = "finding" | "question" | "decision" | "blocker" | "handoff";

export interface RoomMessage {
  id: string;
  seq: number;
  from: string;
  to: Recipient;
  reply_to: string | null;
  intent: string;
  priority: string;
  kind?: MessageKind;
  body: unknown;
  created_at: string;
  /** Set when the sender asked for a reply; open until a reply (reply_to = this id) arrives. */
  expects_reply?: { due_at: string };
  /** Set by clients on a message they could not decrypt; the body is then still the encrypted envelope. */
  decrypt_error?: string;
}

/** Body of a `compare.verdict` message: it settles one `compare.request` with a winner and the reason. */
export interface CompareVerdictBody {
  /** The `compare.request` this answers, as the caller wrote it: message id or seq. */
  of?: string;
  winner?: "A" | "B" | "tie";
  reason?: string;
}

/** Options for a refine (see room-commands `refineTask`, and the `j01n refine` verb). */
export interface RefineOptions {
  /** The `compare.verdict` this rework comes from, by seq or message id. Defaults to the newest verdict in the room. */
  from?: string | number;
  /** What to change, in the refiner's own words. Titles the child task instead of the verdict reason. */
  note?: string;
}

/** Body of the sealed `task.refined` notice announcing a follow-up task opened from a verdict. */
export interface TaskRefinedBody {
  text: string;
  /** The new follow-up task id, spelled the way `task.assigned` spells it, so one reader handles both. */
  task: string;
  task_id: string;
  title: string;
  /** The parent task this one refines; also its only `depends_on` entry. */
  refines: string;
  /** `verdict <seq>` — the message that turned a losing verdict into this rework. */
  reason: string;
  by: string;
}

/** Routing fields a sprint board task carries that tasks.ts's `Task` does not name (see spec.ts, and the board).
 * Clients copy them straight through the board, so a task reader that clones a task needs them typed. */
export interface TaskRouting {
  role?: string;
  needs?: string[];
  contract?: string;
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
  /** Self-reported execution harness (e.g. pi, claude); not a launch instruction or authorization. */
  harness?: string;
  skills?: string[];
  /** What the agent can do, e.g. code, shell, browser, screenshot, vision, web_search, files. */
  capabilities?: string[];
  /** Where the agent works ({ path, repo, branch, host }), sealed with the room key (`jsk1:`). */
  workspace?: string;
  /** Opaque room-specific HMAC of the checkout's machine and worktree URL. */
  checkout?: string;
  display_name?: string;
  role?: string;
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
  help_needed?: Array<{ ask_id: string; from: string; owed_by: string; due_at: string; overdue_since: string; escalated_to: "owner" }>;
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
