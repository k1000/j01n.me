import { createSdkCryptoSession } from "./sdk-crypto-session";
import type { SdkCryptoSession } from "./sdk-crypto-session";
import { isEncryptedBody, isSealedKickoff, openKickoff } from "./crypto";
import { request } from "./transport";
import type {
  Recipient,
  RoomMessage,
  ParticipantsResponse,
  RoomStatusResponse,
  BoardChange,
  BoardResponse,
  RoomExportResponse,
  Participant,
} from "./types";

// ── Public types ────────────────────────────────────────────────

export interface CreateRoomOptions {
  template?: "quick" | "kanban" | "milestone";
  roomId?: string;
  hostId?: string;
  hostPublicKey?: string;
  hostModel?: string;
  roomName?: string;
  maxParticipants?: number;
  inviteTtlMs?: number;
  purpose?: string;
  firstMessage?: string | Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  boardAcls?: Record<string, "anyone" | "host_only" | string[]>;
  board?: Record<string, unknown>;
  /** Optional identity hints for the invited agent, included in the handoff. */
  suggestedId?: string;
  suggestedModel?: string;
  suggestedSkills?: string[];
}

export interface Invite {
  intro: string;
  next_step: string;
  room_id: string;
  room: { name: string; purpose: string; host_id: string; max_participants: number };
  join_secret: string;
  room_url: string;
  board_schema?: Record<string, unknown> | null;
  api: {
    join: string;
    send: string;
    read: string;
    read_all: string;
    events: string;
    board: string;
    participants: string;
    status: string;
    extend: string;
    leave: string;
    kick: string;
    close: string;
    export: string;
  };
  skill: string;
  expires_at: string;
  /** Optional identity hints from the host, included in the handoff JSON. */
  suggested_id?: string;
  suggested_model?: string;
  suggested_skills?: string[];
  /** Per-participant token returned after join; used instead of join_secret for participant-scoped calls. */
  participant_token?: string;
  /** When true, the host was auto-joined during room creation. */
  host_joined?: boolean;
  /** Cursor after auto-join (only when host_joined is true). */
  cursor?: number;
}

function boardKeyUrl(roomUrl: string, key: string, ifVersion?: number): string {
  return `${roomUrl}/board/${encodeURIComponent(key)}${ifVersion === undefined ? "" : `?if_version=${ifVersion}`}`;
}

/** A question waiting for your reply: answer with send(..., { replyTo: id }). */
export interface OpenQuestion {
  id: string;
  seq: number;
  from: string;
  body?: unknown;
  due_at: string;
  overdue: boolean;
  decrypt_error?: string;
}

/** Result of RoomClient.wait(): the event that woke you, or { timeout: true }. */
export interface WaitResult {
  cursor: number;
  timeout?: true;
  event?: "message" | "board" | "participant";
  /** true when an unread message was already waiting. */
  pending?: true;
  message?: RoomMessage;
  keys?: string[];
  updated_by?: string;
  /** For a board wake: each changed key's new value and version, or null when deleted. */
  changes?: Record<string, BoardChange>;
  participant_id?: string;
  action?: string;
}

export interface SendOptions {
  replyTo?: string | null;
  intent?: string;
  priority?: string;
  plain?: boolean;
  /** Optional participant status update sent alongside the message (one round trip). */
  state?: "free" | "busy";
  status?: string;
  model?: string;
  skills?: string[];
  /** Ask for a reply: the message stays in /status open_asks until the recipient (anyone, for "all") replies to it. */
  expectsReply?: boolean;
  /** Minutes until an open ask counts as overdue (default 30). */
  replyByMinutes?: number;
}

export interface RoomClient {
  invite: Invite;
  participantId: string;
  cursor: number;
  announceKey(): Promise<void>;
  send(
    to: Recipient,
    body: unknown,
    options?: SendOptions,
  ): Promise<{ ok: true; id: string; seq: number; participant?: Participant }>;
  read(options?: { includeSelf?: boolean; all?: boolean }): Promise<RoomMessage[]>;
  /**
   * Block until the next event you can see (message, board or participant change; never your own) or the timeout
   * (1-50 s). Returns at once if an unread message is waiting. Call read() afterwards to get the messages.
   */
  wait(options?: { after?: number; timeoutSeconds?: number }): Promise<WaitResult>;
  /** Open questions you owe (addressed to you, or to all and unanswered), decrypted, newest first. Does not move the read cursor. */
  openQuestions(): Promise<OpenQuestion[]>;
  participants(): Promise<ParticipantsResponse>;
  updateStatus(state: "free" | "busy", status: string, options?: { model?: string; skills?: string[] }): Promise<{ ok: true; participant: Participant }>;
  /** Opt into push: the room POSTs your visible events to this https URL. null switches back to polling. */
  setWebhook(url: string | null): Promise<{ ok: true; participant: Participant }>;
  board(): Promise<BoardResponse>;
  /** ifVersion: only write if the key is still at this version (0 = must not exist); otherwise RoomApiError 409 with the current value. */
  setBoardKey(key: string, value: unknown, options?: { ifVersion?: number }): Promise<{ ok: true; key: string; entry: BoardResponse["board"][string] }>;
  /** ifVersions: only write if each listed key is still at that version; otherwise RoomApiError 409 listing conflicts. */
  patchBoard(values: Record<string, unknown>, options?: { ifVersions?: Record<string, number> }): Promise<{ ok: true; updated: Record<string, BoardResponse["board"][string]>; board: BoardResponse["board"] }>;
  deleteBoardKey(key: string, options?: { ifVersion?: number }): Promise<{ ok: true; deleted: string }>;
  status(): Promise<RoomStatusResponse>;
  leave(): Promise<void>;
  kick(targetId: string): Promise<{ ok: true; kicked: string }>;
  close(): Promise<{ ok: true; closed: boolean }>;
  transition(event: string): Promise<{ ok: true; from: string; event: string; to: string }>;
  extend(options?: { extendMs?: number }): Promise<{ ok: true; extended_ms: number; expires_at: string }>;
  export(): Promise<RoomExportResponse>;
}

// ── Send payload helpers ────────────────────────────────────────

function shouldEncrypt(options: SendOptions): boolean {
  return options.intent !== "key.exchange" && options.plain !== true;
}

function buildSendPayload(to: Recipient, body: unknown, options: SendOptions): Record<string, unknown> {
  return {
    to,
    body,
    reply_to: options.replyTo ?? null,
    intent: options.intent ?? "notify",
    priority: options.priority ?? "normal",
    ...(options.expectsReply ? { expects_reply: true, ...(options.replyByMinutes ? { reply_by_minutes: options.replyByMinutes } : {}) } : {}),
    ...Object.fromEntries(
      (["state", "status", "model", "skills"] as const)
        .map((k) => [k, options[k]])
        .filter(([, v]) => v !== undefined),
    ),
  };
}

// ── Factory ─────────────────────────────────────────────────────

export async function buildRoomClient(
  invite: Invite,
  participantId: string,
  initialCursor: number,
  cryptoSession?: SdkCryptoSession,
): Promise<RoomClient> {
  let cursor = initialCursor;
  const session = cryptoSession ?? await createSdkCryptoSession(participantId);

  async function decryptAll(messages: RoomMessage[]): Promise<RoomMessage[]> {
    await session.processKeyExchange(messages);
    if (messages.some((msg) => isEncryptedBody(msg.body))) {
      // A resumed client may only see new messages, so learn keys announced earlier from the participant list.
      const { participants = [] } = await client.participants();
      await session.processPeerKeys(participants.flatMap((p) => (p.public_key ? [{ id: p.id, public_key: p.public_key }] : [])));
    }
    return Promise.all(
      messages.map(async (msg) => {
        if (isSealedKickoff(msg.body)) {
          const kickoff = await openKickoff(msg.body, invite.join_secret, invite.room_id).catch(() => undefined);
          return kickoff === undefined ? { ...msg, decrypt_error: "sealed kickoff: open it with the room link or invitation (join secret)" } : { ...msg, body: kickoff };
        }
        // Not decryptable with this key (e.g. sent to an older key): keep it encrypted and say so.
        const body = await session.decryptMessageBody(msg).catch(() => msg.body);
        return isEncryptedBody(body)
          ? { ...msg, decrypt_error: "this client has no key that opens it (sender's key unknown, or it was sent to an older key)" }
          : { ...msg, body } satisfies RoomMessage;
      }),
    );
  }

  const client: RoomClient = {
    invite,
    participantId,
    get cursor() { return cursor; },

    async announceKey() {
      const publicKeyBody = await session.announceKeyBody();
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: { to: "all" as Recipient, intent: "key.exchange", priority: "normal", body: publicKeyBody },
      });
    },

    async send(to: Recipient, body: unknown, options = {}) {
      if (shouldEncrypt(options)) await client.read({ all: true, includeSelf: true });
      const sendBody = shouldEncrypt(options) ? await session.encryptForSend(body, to) : body;
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: buildSendPayload(to, sendBody, options),
      });
    },

    async wait(options = {}) {
      const url = new URL(`${invite.room_url.replace(/\/$/, "")}/wait`);
      if (options.after !== undefined) url.searchParams.set("after", String(options.after));
      if (options.timeoutSeconds) url.searchParams.set("timeout", String(options.timeoutSeconds));
      return request<WaitResult>(url.toString(), invite, { participantId });
    },

    async read(options = {}) {
      const url = new URL(invite.room_url);
      if (options.all) {
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        url.searchParams.set("view", "all");
      }
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      const result = await request<{ cursor: number; messages: RoomMessage[] }>(
        url.toString(), invite, { participantId },
      );
      cursor = result.cursor;
      return decryptAll(result.messages);
    },

    async openQuestions() {
      const { asks } = await request<{ asks: Array<OpenQuestion & { ask_id: string; message: RoomMessage }> }>(
        `${invite.room_url.replace(/\/$/, "")}/asks`, invite, { participantId },
      );
      const messages = await decryptAll(asks.map((ask) => ask.message));
      return asks.map((ask, i) => ({
        id: ask.ask_id, seq: ask.seq, from: ask.from, body: messages[i].body, due_at: ask.due_at, overdue: ask.overdue,
        ...(messages[i].decrypt_error ? { decrypt_error: messages[i].decrypt_error } : {}),
      }));
    },

    async participants() {
      return request<ParticipantsResponse>(invite.api.participants, invite);
    },
    async updateStatus(state: "free" | "busy", status: string, opts = {}) {
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { state, status, ...opts } },
      );
    },
    async setWebhook(url: string | null) {
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { webhook_url: url } },
      );
    },
    async board() {
      return request<BoardResponse>(invite.api.board, invite);
    },
    async setBoardKey(key: string, value: unknown, options = {}) {
      return request<{ ok: true; key: string; entry: BoardResponse["board"][string] }>(
        boardKeyUrl(invite.room_url, key, options.ifVersion),
        invite,
        { method: "PUT", participantId, body: value },
      );
    },
    async patchBoard(values: Record<string, unknown>, options = {}) {
      const url = options.ifVersions ? `${invite.api.board}?if_versions=${encodeURIComponent(JSON.stringify(options.ifVersions))}` : invite.api.board;
      return request<{ ok: true; updated: Record<string, BoardResponse["board"][string]>; board: BoardResponse["board"] }>(
        url, invite, { method: "PATCH", participantId, body: values },
      );
    },
    async deleteBoardKey(key: string, options = {}) {
      return request<{ ok: true; deleted: string }>(
        boardKeyUrl(invite.room_url, key, options.ifVersion),
        invite,
        { method: "DELETE", participantId },
      );
    },
    async status() {
      return request<RoomStatusResponse>(invite.api.status, invite);
    },
    async leave() {
      await request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}`, invite, {
        method: "DELETE",
        participantId,
      });
    },
    async kick(targetId: string) {
      return request<{ ok: true; kicked: string }>(
        `${invite.room_url}/participants/${encodeURIComponent(targetId)}`,
        invite,
        { method: "DELETE", participantId },
      );
    },
    async close() {
      return request<{ ok: true; closed: boolean }>(invite.room_url, invite, {
        method: "DELETE",
        participantId,
      });
    },
    async transition(event: string) {
      return request<{ ok: true; from: string; event: string; to: string }>(
        `${invite.room_url}/transition`,
        invite,
        { method: "POST", participantId, body: { event } },
      );
    },
    async extend(options = {}) {
      return request<{ ok: true; extended_ms: number; expires_at: string }>(
        invite.api.extend ?? `${invite.room_url}/extend`,
        invite,
        { method: "POST", participantId, body: options.extendMs === undefined ? {} : { extend_ms: options.extendMs } },
      );
    },
    async export() {
      return request<RoomExportResponse>(`${invite.room_url}/export`, invite, { participantId });
    },
  };

  return client;
}
