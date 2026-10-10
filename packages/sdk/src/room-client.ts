import { createSdkCryptoSession } from "./sdk-crypto-session";
import type { SdkCryptoSession } from "./sdk-crypto-session";
import { isEncryptedBody, isSealedKickoff, openRoomSeal, sealForRoom } from "./crypto";
import type { Workspace } from "./crypto";
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
  template?: "quick" | "kanban" | "milestone" | "sprint";
  tasks?: Array<{ id: string; title: string; files: string[]; depends_on?: string[]; worktree?: string }>;
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
  /** Request-scoped transport (e.g. in-process Worker Durable Object fetch). Defaults to global fetch. */
  transportFetch?: typeof fetch;
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
  /** The caller already synchronized peer keys before sending (e.g. when tracking unread cursor separately). */
  skipKeySync?: boolean;
  /** Encrypt even when using the key.exchange intent (legacy bridges that expose intent). */
  forceEncrypt?: boolean;
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
  read(options?: { includeSelf?: boolean; all?: boolean; after?: number }): Promise<RoomMessage[]>;
  /**
   * Block until the next event you can see (message, board or participant change; never your own) or the timeout
   * (1-50 s). Returns at once if an unread message is waiting. Call read() afterwards to get the messages.
   * Filters: only events caused by `from`, only board changes to keys starting with `board`, `system: false` skips
   * joins/leaves and system notices.
   */
  wait(options?: { after?: number; timeoutSeconds?: number; from?: string[]; board?: string; system?: false }): Promise<WaitResult>;
  /** Open questions you owe (addressed to you, or to all and unanswered), decrypted, newest first. Does not move the read cursor. */
  openQuestions(): Promise<OpenQuestion[]>;
  participants(): Promise<ParticipantsResponse>;
  /** workspace is sealed with the room key before it is sent; null clears it. */
  updateStatus(state: "free" | "busy", status: string, options?: { model?: string; skills?: string[]; provider?: string; capabilities?: string[]; workspace?: Workspace | null; checkout?: string | null; display_name?: string; role?: string; webhookUrl?: string | null }): Promise<{ ok: true; participant: Participant }>;
  /** Announce what you can do and where you work (only the given fields change; workspace is sealed, null clears it). */
  setProfile(profile: { capabilities?: string[]; workspace?: Workspace | null; checkout?: string | null; display_name?: string; role?: string; model?: string; provider?: string }): Promise<{ ok: true; participant: Participant }>;
  /** Host-targeted role change; the server enforces host authorization and joined target. */
  setParticipantRole(targetId: string, role: "owner" | null): Promise<{ ok: true; participant: Participant }>;
  /** Everyone in the room with their capabilities and opened workspace (null when it cannot be opened). */
  team(): Promise<Array<{ id: string; state: string; status: string; last_seen_at: string; model?: string; provider?: string; checkout?: string; checkout_status: string; display_name?: string; role?: string; capabilities: string[]; workspace: Workspace | null }>>;
  /** Opt into push: the room POSTs your visible events to this https URL. null switches back to polling. */
  setWebhook(url: string | null): Promise<{ ok: true; participant: Participant }>;
  board(): Promise<BoardResponse>;
  /** ifVersion: only write if the key is still at this version (0 = must not exist); otherwise RoomApiError 409 with the current value. */
  setBoardKey(key: string, value: unknown, options?: { ifVersion?: number }): Promise<{ ok: true; key: string; entry: BoardResponse["board"][string] }>;
  /** ifVersions: only write if each listed key is still at that version; otherwise RoomApiError 409 listing conflicts. */
  patchBoard(values: Record<string, unknown>, options?: { ifVersions?: Record<string, number> }): Promise<{ ok: true; updated: Record<string, BoardResponse["board"][string]>; board: BoardResponse["board"] }>;
  deleteBoardKey(key: string, options?: { ifVersion?: number }): Promise<{ ok: true; deleted: string }>;
  status(): Promise<RoomStatusResponse>;
  /** release: also release your file reservations (otherwise leaving while holding some fails with 409). */
  leave(options?: { release?: boolean }): Promise<void>;
  kick(targetId: string): Promise<{ ok: true; kicked: string }>;
  close(): Promise<{ ok: true; closed: boolean }>;
  transition(event: string): Promise<{ ok: true; from: string; event: string; to: string }>;
  /** Host only: hand the host role to another participant in the room (everyone gets a host.changed message). */
  transferHost(to: string): Promise<{ ok: true; host_id: string }>;
  extend(options?: { extendMs?: number }): Promise<{ ok: true; extended_ms: number; expires_at: string }>;
  export(): Promise<RoomExportResponse>;
}

// ── Send payload helpers ────────────────────────────────────────

function shouldEncrypt(options: SendOptions): boolean {
  return options.plain !== true && (options.forceEncrypt === true || options.intent !== "key.exchange");
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
          const kickoff = await openRoomSeal(msg.body.encrypted_payload, invite.join_secret, invite.room_id).catch(() => undefined);
          return kickoff === undefined ? { ...msg, decrypt_error: "sealed kickoff: open it with the room link or invitation (join secret)" } : { ...msg, body: kickoff };
        }
        // A profile.changed announcement carries the new workspace sealed with the room key.
        const announced = msg.body as { workspace?: unknown } | null;
        if (msg.intent === "profile.changed" && typeof announced?.workspace === "string") {
          return { ...msg, body: { ...announced, workspace: await openRoomSeal(announced.workspace, invite.join_secret, invite.room_id).catch(() => null) as Workspace | null } };
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
      if (shouldEncrypt(options) && !options.skipKeySync) await client.read({ all: true, includeSelf: true });
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
      if (options.from?.length) url.searchParams.set("from", options.from.join(","));
      if (options.board !== undefined) url.searchParams.set("board", options.board);
      if (options.system === false) url.searchParams.set("system", "false");
      return request<WaitResult>(url.toString(), invite, { participantId });
    },

    async read(options = {}) {
      const url = new URL(invite.room_url);
      if (options.all) {
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        url.searchParams.set("view", "all");
      }
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      if (options.after !== undefined) url.searchParams.set("after", String(options.after));
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
      return request<ParticipantsResponse>(invite.api.participants, invite, { participantId });
    },
    async updateStatus(state: "free" | "busy", status: string, opts: { workspace?: Workspace | null; webhookUrl?: string | null } = {}) {
      const { workspace, webhookUrl, ...profile } = opts;
      const sealed = workspace === undefined ? {} : { workspace: workspace && await sealForRoom(workspace, invite.join_secret, invite.room_id) };
      const webhook = webhookUrl === undefined ? {} : { webhook_url: webhookUrl };
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { state, status, ...profile, ...webhook, ...sealed } },
      );
    },
    async setProfile(profile) {
      const body: Record<string, unknown> = {};
      if (profile.capabilities !== undefined) body.capabilities = profile.capabilities;
      if (profile.model !== undefined) body.model = profile.model;
      if (profile.provider !== undefined) body.provider = profile.provider;
      if (profile.checkout !== undefined) body.checkout = profile.checkout;
      if (profile.display_name !== undefined) body.display_name = profile.display_name;
      if (profile.role !== undefined) body.role = profile.role;
      if (profile.workspace !== undefined) body.workspace = profile.workspace && await sealForRoom(profile.workspace, invite.join_secret, invite.room_id);
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body },
      );
    },
    async setParticipantRole(targetId: string, role: "owner" | null) {
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(targetId)}`,
        invite,
        { method: "PATCH", participantId, body: { role } },
      );
    },
    async team() {
      const { participants = [] } = await client.participants();
      return Promise.all(participants.filter((p) => !p.left_at).map(async (p) => ({
        id: p.id,
        state: p.state,
        status: p.status,
        last_seen_at: p.last_seen_at,
        ...(p.model ? { model: p.model } : {}),
        ...(p.provider ? { provider: p.provider } : {}),
        ...(p.checkout ? { checkout: p.checkout } : {}),
        checkout_status: !p.checkout ? "checkout unknown" : (() => {
          const other = participants.find((candidate) => candidate.id !== p.id && !candidate.left_at && candidate.checkout === p.checkout);
          return other ? `shares checkout with ${other.display_name || other.id}` : "own checkout";
        })(),
        ...(p.display_name ? { display_name: p.display_name } : {}),
        ...(p.role ? { role: p.role } : {}),
        capabilities: p.capabilities ?? [],
        workspace: p.workspace ? await openRoomSeal(p.workspace, invite.join_secret, invite.room_id).catch(() => null) as Workspace | null : null,
      })));
    },
    async setWebhook(url: string | null) {
      return request<{ ok: true; participant: Participant }>(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { webhook_url: url } },
      );
    },
    async board() {
      return request<BoardResponse>(invite.api.board, invite, { participantId });
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
      return request<RoomStatusResponse>(invite.api.status, invite, { participantId });
    },
    async leave(options = {}) {
      await request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}${options.release ? "?release=true" : ""}`, invite, {
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
    async transferHost(to: string) {
      return request<{ ok: true; host_id: string }>(`${invite.room_url}/host`, invite, { method: "POST", participantId, body: { to } });
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
