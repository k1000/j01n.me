/**
 * Hosted MCP endpoint — serves j01n.me room operations as an HTTP MCP server.
 * No repo clone or local code needed: MCP hosts configure a URL.
 *
 * MCP client configuration:
 * ```json
 * {
 *   "mcpServers": {
 *     "j01n.me": { "url": "https://j01n.me/mcp" }
 *   }
 * }
 * ```
 *
 * Implements the MCP Streamable HTTP transport specification directly
 * using Cloudflare Workers' Web Standard APIs.
 */

import type { Env } from "./types";
import { CLIENT_PROTOCOL } from "./constants";
import { createRoomDirect } from "./invite";
import type { CreateRoomBody } from "./invite";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import type { SdkCryptoSession } from "@j01n/sdk/crypto-session";
import { inviteLink, parseInviteLink } from "@j01n/sdk/invite";
import { isEncryptedBody, isSealedKickoff, openKickoff, openWorkspace, sealKickoff, sealWorkspace } from "@j01n/sdk/crypto";
import type { Workspace } from "@j01n/sdk/crypto";
import type { RoomMessage } from "./types";
import { deleteInvite, inviteAgent, registerAgent, waitForInvites } from "@j01n/sdk/agents";
import type { AgentFetch, AgentIdentity } from "@j01n/sdk/agents";
import { agentRoutes } from "./agents/routes";
import { pathsOverlap, RESERVATIONS_KEY } from "@j01n/sdk/reservations";
import type { Reservation } from "@j01n/sdk/reservations";

// ── Unified session store (per-worker-isolate, in-memory) ───────
// Key: roomId:participantId. Stores ECDH session + per-participant token.

/** JWK-serializable session data for DO persistence. */
interface PersistedSession {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
  token?: string;
}

interface SessionStore {
  ecdh: SdkCryptoSession;
  token?: string;
  roomUrl: string;
  /** Whether this session was loaded from DO persistence (survives isolate recycle). */
  persisted: boolean;
}

const sessions = new Map<string, SessionStore>();

function sessionKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

function getEffectiveSecret(roomUrl: string, participantId: string, fallbackSecret: string): string {
  const roomId = roomUrl.split("/").pop()!;
  return sessions.get(sessionKey(roomId, participantId))?.token ?? fallbackSecret;
}

function isUsingParticipantToken(roomUrl: string, participantId: string, fallbackSecret: string): boolean {
  const roomId = roomUrl.split("/").pop()!;
  const entry = sessions.get(sessionKey(roomId, participantId));
  return !!entry?.token && entry.token !== fallbackSecret;
}

/**
 * Load persisted sessions from the DO into the in-memory cache. Called whenever a participant's session or token
 * is missing in this isolate, since requests for one room can land on different isolates.
 */
async function loadPersistedSessions(env: Env, roomUrl: string): Promise<void> {
  const roomId = roomUrl.split("/").pop()!;
  try {
    const stub = env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(roomId));
    const res = await stub.fetch("https://rendezvous.internal/__load_session");
    if (!res.ok) return;
    const data = await res.json() as { sessions: Record<string, PersistedSession> };
    for (const [pid, persisted] of Object.entries(data.sessions)) {
      const key = sessionKey(roomId, pid);
      if (sessions.get(key)?.token) continue; // keep live sessions; replace token-less ones with the saved session
      try {
        const ecdh = await createSdkCryptoSession(pid, persisted.privateJwk, persisted.publicJwk);
        sessions.set(key, { ecdh, token: persisted.token, roomUrl, persisted: true });
      } catch {
        // skip corrupted sessions
      }
    }
  } catch {
    // silent fail — in-memory sessions still work
  }
}

/** Save an ECDH session to DO storage for persistence across isolate recycles. */
async function persistSessionToDo(env: Env, roomUrl: string, pid: string, force = false): Promise<void> {
  const key = sessionKey(roomUrl.split("/").pop()!, pid);
  const entry = sessions.get(key);
  if (!entry || (entry.persisted && !force)) return;
  try {
    const jwks = await entry.ecdh.exportKeyPair();
    const stub = env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(roomUrl.split("/").pop()!));
    await stub.fetch("https://rendezvous.internal/__save_session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: pid, ...jwks, token: entry.token }),
    });
    entry.persisted = true;
  } catch {
    // silent fail
  }
}

async function ensureEcdhSession(env: Env | undefined, roomUrl: string, participantId: string, _fallbackSecret?: string): Promise<SdkCryptoSession> {
  const roomId = roomUrl.split("/").pop()!;
  const key = sessionKey(roomId, participantId);
  let entry = sessions.get(key);
  if (!entry) {
    // Try loading persisted sessions from DO first
    if (env) await loadPersistedSessions(env, roomUrl);
    entry = sessions.get(key);
    if (!entry) {
      entry = { ecdh: await createSdkCryptoSession(participantId), roomUrl, persisted: false };
      sessions.set(key, entry);
      // Persist new sessions to DO for future resilience
      if (env) persistSessionToDo(env, roomUrl, participantId).catch(() => {});
    }
  }
  return entry.ecdh;
}

function storeToken(roomId: string, participantId: string, token: string, roomUrl: string): void {
  const entry = sessions.get(sessionKey(roomId, participantId));
  if (!entry) throw new Error(`storeToken called before ensureEcdhSession for ${participantId}`);
  entry.token = token;
  entry.roomUrl = roomUrl;
}

function clearRoomSessions(roomId: string): void {
  for (const key of sessions.keys()) {
    if (key.startsWith(roomId + ":")) sessions.delete(key);
  }
}

// ── MCP client session store (per Mcp-Session-Id) ───────────────
//
// Tracks the GET /mcp listening SSE stream plus any active room
// subscriptions belonging to that MCP client. Separate from the ECDH
// `sessions` map above (which is per room+participant, not per MCP client).

/** Full parameters needed to re-establish a room subscription on reconnect. */
interface SubscribeParams {
  roomUrl: string;
  secret: string;
  participantId: string;
  includeSelf: boolean;
}

interface RoomSubscription {
  id: string;
  roomId: string;
  participantId: string;
  params?: SubscribeParams;
  cancel: () => void;
}

interface ClientSession {
  id: string;
  env?: Env;
  listening?: ReadableStreamDefaultController<Uint8Array>;
  heartbeat?: ReturnType<typeof setInterval>;
  subscriptions: Map<string, RoomSubscription>;
  nextEventId: number;
}

const SESSION_HEADER = "mcp-session-id";
const clientSessions = new Map<string, ClientSession>();

function getOrCreateClientSession(sessionId: string): ClientSession {
  let session = clientSessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, subscriptions: new Map(), nextEventId: 1 };
    clientSessions.set(sessionId, session);
  }
  return session;
}

function deleteClientSession(sessionId: string): void {
  const session = clientSessions.get(sessionId);
  if (!session) return;
  if (session.heartbeat) clearInterval(session.heartbeat);
  for (const sub of session.subscriptions.values()) sub.cancel();
  try { session.listening?.close(); } catch { /* already closed */ }
  clientSessions.delete(sessionId);
}

// ── DO stub helpers (avoid HTTP loopback) ───────────────────────

function getRoomStub(env: Env, roomUrlOrId: string): DurableObjectStub {
  const roomId = roomUrlOrId.includes("/") ? roomUrlOrId.split("/").pop()! : roomUrlOrId;
  const id = env.RENDEZVOUS.idFromName(roomId);
  return env.RENDEZVOUS.get(id);
}

async function doFetchRaw(
  env: Env,
  roomUrl: string,
  path: string,
  secret: string,
  options: { method?: string; body?: unknown; participantId?: string } = {},
): Promise<Response> {
  // Requests for one room can land on different isolates: load this participant's saved token if it isn't here.
  if (options.participantId && !sessions.get(sessionKey(roomUrl.split("/").pop()!, options.participantId))?.token) {
    await loadPersistedSessions(env, roomUrl);
  }
  // Use per-participant token when available (more secure than room-level join_secret)
  const effectiveSecret = options.participantId
    ? getEffectiveSecret(roomUrl, options.participantId, secret)
    : secret;
  const usingToken = options.participantId
    && isUsingParticipantToken(roomUrl, options.participantId, secret as string);
  const stub = getRoomStub(env, roomUrl);
  const url = new URL(path, roomUrl);
  const headers: Record<string, string> = { authorization: `Bearer ${effectiveSecret}` };
  // Only send x-participant-id when using the room-level secret (per-participant token
  // already encodes the participant ID, so the server resolves it automatically)
  if (options.participantId && !usingToken) {
    headers["x-participant-id"] = options.participantId;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return stub.fetch(url.toString(), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function doFetch(
  env: Env,
  roomUrl: string,
  path: string,
  secret: string,
  options: { method?: string; body?: unknown; participantId?: string } = {},
): Promise<unknown> {
  const response = await doFetchRaw(env, roomUrl, path, secret, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} failed: ${response.status} ${formatRoomError(text)}`);
  }
  return response.json();
}

function formatRoomError(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = typeof body.error === "string" ? body.error : undefined;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    if (error && reason) return `${error}: ${reason}`;
    // Version conflicts carry what the agent needs to retry: the current value(s) and version(s).
    if (error && (body.conflicts || body.current)) return `${error}: ${JSON.stringify(body.conflicts ?? { key: body.key, current_version: body.current_version, current: body.current })}`;
    if (error) return error;
  } catch { /* fall through to raw text */ }
  return text;
}

function parseRoomId(inviteJson: string): { roomId: string; roomUrl: string; secret: string } {
  const parsed = parseInviteLink(inviteJson) ?? JSON.parse(inviteJson);
  const roomUrl = parsed.room_url ?? parsed.access ?? parsed.follow;
  if (!roomUrl || !parsed.join_secret) throw new Error("Invalid invite: must have access (or room_url) and join_secret");
  return { roomId: roomUrl.split("/").pop()!, roomUrl: roomUrl.replace(/\/$/, ""), secret: parsed.join_secret };
}

/** Block until the next event the participant can see (or the timeout), then return the new messages, decrypted. */
async function waitForEvent(env: Env, params: Record<string, unknown>) {
  const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
  const participantId = params.participantId as string;
  await ensureEcdhSession(env, roomUrl, participantId, secret);
  const timeout = Math.min(Math.max(Number(params.timeoutSeconds) || 50, 1), 50);
  const filter = new URLSearchParams({ timeout: String(timeout) });
  if (params.from) filter.set("from", String(params.from));
  if (typeof params.board === "string") filter.set("board", params.board);
  if (params.system === false) filter.set("system", "false");
  const woke = await doFetch(env, roomUrl, `/wait?${filter}`, secret, { participantId }) as { timeout?: boolean; event?: string; changes?: unknown };
  if (woke.timeout) return { timeout: true };
  const read = await readRoomMessages(env, { inviteJson: params.inviteJson, participantId });
  return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), ...read };
}

/** A JSON object is sent as is; anything else is sent as { text }. */
function parseMessageBody(raw: string): unknown {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") return value;
  } catch { /* plain text */ }
  return { text: raw };
}

async function readRoomMessages(env: Env, params: Record<string, unknown>) {
  const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
  const participantId = params.participantId as string;
  const crypto = await ensureEcdhSession(env, roomUrl, participantId, secret);
  await refreshPeerKeys(env, roomUrl, secret, participantId, crypto);

  const query = [params.all ? "view=all" : "", params.includeSelf ? "include_self=true" : ""].filter(Boolean).join("&");
  const path = query ? `/?${query}` : "/";
  const result = await doFetch(env, roomUrl, path, secret, { participantId }) as { messages?: RoomMessage[]; cursor?: number };
  const messages = result.messages ?? [];
  // Peers that join without a public_key announce it only via key.exchange messages.
  await crypto.processKeyExchange(messages);

  // Use SDK's proven decryption
  const decrypted = await decryptRoomMessages(crypto, messages, secret, roomUrl);
  // A ready reply for participants' messages: answering with replyTo closes a question.
  const withReplies = decrypted.map((m) => (m.from === "system" || m.intent === "key.exchange" ? m : { ...m, reply: { tool: "send_message", to: m.from, replyTo: m.id } }));
  return { cursor: result.cursor ?? 0, count: withReplies.length, messages: withReplies };
}

/** Decrypt room messages for a participant; sealed kickoffs need the real join secret. */
async function decryptRoomMessages(crypto: SdkCryptoSession, messages: RoomMessage[], secret: string, roomUrl: string) {
  const roomId = roomUrl.split("/").pop()!;
  return Promise.all(messages.map(async (msg) => {
    if (isSealedKickoff(msg.body)) {
      const kickoff = secret === SESSION_ROOM_SECRET ? undefined : await openKickoff(msg.body, secret, roomId).catch(() => undefined);
      return kickoff === undefined ? { ...msg, decrypt_error: "sealed kickoff: pass the room link (inviteJson) to open it" } : { ...msg, body: kickoff };
    }
    // A profile.changed announcement carries the new workspace sealed with the room key.
    const announced = msg.body as { workspace?: unknown } | null;
    if (msg.intent === "profile.changed" && typeof announced?.workspace === "string" && secret !== SESSION_ROOM_SECRET) {
      return { ...msg, body: { ...announced, workspace: await openWorkspace(announced.workspace, secret, roomId).catch(() => null) } };
    }
    const body = await crypto.decryptMessageBody(msg).catch(() => msg.body);
    return isEncryptedBody(body)
      ? { ...msg, decrypt_error: "this client has no key that opens it (sender's key unknown, or it was sent to an older key)" }
      : { ...msg, body };
  }));
}

function parseSkills(value?: string): string[] | undefined {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

async function refreshPeerKeys(
  env: Env,
  roomUrl: string,
  secret: string,
  participantId: string,
  crypto: SdkCryptoSession,
): Promise<void> {
  try {
    const result = await doFetch(env, roomUrl, "/participants", secret, { participantId }) as Record<string, unknown>;
    const peers = ((result.participants ?? []) as Array<{ id: string; public_key?: string }>)
      .filter((p) => p.id !== participantId && p.public_key)
      .map((p) => ({ id: p.id, public_key: p.public_key! }));
    if (peers.length > 0) await crypto.processPeerKeys(peers);
  } catch { /* best-effort */ }
}

// ── MCP JSON-RPC helpers ────────────────────────────────────────

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

interface McpError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

function mcpResult(id: number | string, result: unknown): McpSuccess {
  return { jsonrpc: "2.0", id, result };
}

function mcpToolResult(id: number | string, text: unknown): McpSuccess {
  return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(text, null, 2) }] });
}

function mcpError(id: number | string | null, code: number, message: string): McpError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── Tool registry ───────────────────────────────────────────────

interface ToolContext {
  sessionId?: string;
  waitUntil?: (promise: Promise<void>) => void;
}

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler?: (env: Env, params: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  streaming?: (env: Env, params: Record<string, unknown>, requestId: number | string) => Promise<Response>;
}

interface JoinResponse {
  participant_token?: string;
  cursor?: number;
  peers?: Array<{ id: string; public_key: string }>;
}

async function createRoomTool(env: Env, params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const hostId = (params.hostId as string) ?? "agent";
  const room = await createRoomDirect(env, createHostedRoomBody(params, hostId), "https://j01n.me");
  const stub = env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(room.roomId));
  const hostCrypto = await ensureEcdhSession(env, room.roomUrl, hostId, room.joinSecret);
  const { public_key: hostPublicKey } = await hostCrypto.announceKeyBody();

  const joinResponse = await stub.fetch(`https://rendezvous.internal/r/${room.roomId}/participants/${encodeURIComponent(hostId)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${room.joinSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ public_key: hostPublicKey, state: "free", status: "joined via hosted MCP" }),
  });
  const joinData = await joinResponse.json() as JoinResponse;
  if (joinData.participant_token) {
    storeToken(room.roomId, hostId, joinData.participant_token, room.roomUrl);
    await persistSessionToDo(env, room.roomUrl, hostId, true);
  }
  if (joinData.peers?.length) await hostCrypto.processPeerKeys(joinData.peers);

  const hostToken = getEffectiveSecret(room.roomUrl, hostId, room.joinSecret);
  await stub.fetch(`https://rendezvous.internal/r/${room.roomId}/`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostToken}`,
      ...(hostToken === room.joinSecret ? { "x-participant-id": hostId } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: hostPublicKey } }),
  });

  if (typeof params.firstMessage === "string" && params.firstMessage.trim()) {
    const sealed = await sealKickoff(parseMessageBody(params.firstMessage), room.joinSecret, room.roomId);
    await doFetch(env, room.roomUrl, "/", room.joinSecret, { method: "POST", participantId: hostId, body: { to: "all", intent: "kickoff", body: sealed } });
  }

  // Auto-subscribe the MCP session to room events (no separate subscribe_room call needed)
  const subscribed = await autoSubscribeRoom(env, ctx, room.roomUrl, room.joinSecret, hostId, room.roomId);

  const handoff = JSON.stringify({ access: room.roomUrl, join_secret: room.joinSecret });
  const link = inviteLink(room.roomUrl, room.joinSecret);
  const expiresAt = room.data.expires_at as string | undefined;
  const ttlMinutes = expiresAt ? Math.round((Date.parse(expiresAt) - Date.now()) / 60_000) : undefined;
  await rememberSessionRoom(env, ctx.sessionId, room.roomUrl, hostId);
  return {
    ...room.data,
    host_joined: true,
    host_cursor: joinData.cursor ?? 0,
    handoff,
    invite_link: link,
    subscription_active: subscribed,
    join_snippets: {
      mcp: `join_room with inviteJson=${link} and a unique participantId`,
      pi: `/j01n join ${link} <your_name>`,
      cli: `mkdir -p .j01n && curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js && node .j01n/j01n.js join ${link} <your_name>`,
    },
    next_steps: [
      "Send the invitee the join_snippets line for their client (treat join_secret as a credential).",
      subscribed
        ? "Live events are subscribed: joins and messages arrive as notifications."
        : `No live subscription: call read_messages with participantId "${hostId}" to see joins and replies.`,
      ttlMinutes !== undefined ? `Room expires in ~${ttlMinutes} min (${expiresAt}).` : undefined,
    ].filter(Boolean),
  };
}

function createHostedRoomBody(params: Record<string, unknown>, hostId: string): CreateRoomBody {
  return {
    host_id: hostId,
    room_name: params.roomName as string | undefined,
    max_participants: params.maxParticipants as number | undefined,
    purpose: params.purpose as string | undefined,
    board_schema: parseJsonParam(params.boardSchema),
    board_acls: parseJsonParam(params.boardAcls),
    template: params.template as string | undefined,
    board: parseJsonParam(params.board),
  };
}

function parseJsonParam(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

// ── SSE bridge: room /events → MCP streaming response ──────────

const SSE_ENCODER = new TextEncoder();
const SSE_DECODER = new TextDecoder();

async function openEventsStream(
  env: Env,
  roomUrl: string,
  secret: string,
  participantId: string,
  includeSelf: boolean,
): Promise<ReadableStream<Uint8Array>> {
  const path = `/events${includeSelf ? "?include_self=true" : ""}`;
  const upstream = await doFetchRaw(env, roomUrl, path, secret, { participantId });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`/events failed: ${upstream.status} ${formatRoomError(text)}`);
  }
  return upstream.body;
}

async function streamRoomEvents(
  env: Env,
  params: Record<string, unknown>,
  requestId: number | string,
): Promise<Response> {
  const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
  const participantId = params.participantId as string;
  if (!participantId) throw new Error("participantId is required");

  const body = await openEventsStream(env, roomUrl, secret, participantId, params.includeSelf === true);
  return new Response(mcpSseFromRoomSse(body, requestId), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

function mcpSseFromRoomSse(
  upstream: ReadableStream<Uint8Array>,
  requestId: number | string,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let buffer = "";
  let finalSent = false;

  const sendFinal = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string): void => {
    if (finalSent) return;
    finalSent = true;
    controller.enqueue(SSE_ENCODER.encode(formatMcpFrame({
      jsonrpc: "2.0", id: requestId, result: { ok: true, ended: reason },
    })));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          sendFinal(controller, "upstream-closed");
          controller.close();
          return;
        }
        buffer += SSE_DECODER.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = roomEventToMcpFrame(block);
          if (frame) controller.enqueue(SSE_ENCODER.encode(frame));
          idx = buffer.indexOf("\n\n");
        }
      } catch (err) {
        if (!finalSent) {
          finalSent = true;
          const message = err instanceof Error ? err.message : String(err);
          controller.enqueue(SSE_ENCODER.encode(formatMcpFrame({
            jsonrpc: "2.0", id: requestId, error: { code: -32603, message },
          })));
        }
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => { /* upstream already gone */ });
    },
  });
}

function roomEventToMcpFrame(block: string): string | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
  }
  // Drop transport-level noise; the MCP client doesn't need it.
  if (event === "ping" || event === "ready") return null;
  let params: unknown = {};
  if (data) {
    try { params = JSON.parse(data); } catch { params = { raw: data }; }
  }
  return formatMcpFrame({
    jsonrpc: "2.0",
    method: `notifications/j01n.me/${event}`,
    params,
  });
}

function formatMcpFrame(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function subscribeRoomTool(
  env: Env,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (!ctx.sessionId) throw new Error("subscribe_room requires the Mcp-Session-Id header");
  const session = clientSessions.get(ctx.sessionId);
  if (!session?.listening) throw new Error("no active listening stream for this session; open GET /mcp first");

  const { roomId, roomUrl, secret } = parseRoomId(params.inviteJson as string);
  const participantId = params.participantId as string;
  if (!participantId) throw new Error("participantId is required");

  const body = await openEventsStream(env, roomUrl, secret, participantId, params.includeSelf === true);
  const subscriptionId = crypto.randomUUID();
  const reader = body.getReader();
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    reader.cancel().catch(() => { /* upstream already gone */ });
    // Keep subscription metadata when the listening stream disappeared; it can be restored on reconnect.
    if (session.listening && session.subscriptions.get(subscriptionId)?.cancel === cancel) session.subscriptions.delete(subscriptionId);
  };

  const subParams: SubscribeParams = { roomUrl, secret, participantId, includeSelf: (params.includeSelf as boolean) ?? true };
  const subscription: RoomSubscription = { id: subscriptionId, roomId, participantId, params: subParams, cancel };
  session.subscriptions.set(subscriptionId, subscription);

  // Store env for self-healing on reconnect
  session.env = env;

  const pump = pumpRoomEvents(session, reader, cancel);
  ctx.waitUntil?.(pump);

  return { ok: true, subscription_id: subscriptionId, room_id: roomId };
}

async function unsubscribeRoomTool(
  _env: Env,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (!ctx.sessionId) throw new Error("unsubscribe_room requires the Mcp-Session-Id header");
  const session = clientSessions.get(ctx.sessionId);
  const subscriptionId = params.subscriptionId as string;
  const sub = session?.subscriptions.get(subscriptionId);
  if (!sub) return { ok: true, found: false };
  sub.cancel();
  return { ok: true, found: true };
}

/**
 * Auto-subscribe an MCP session to room events after create/join.
 * If the session has an active listening stream, opens the room
 * events stream and pumps notifications into the session. This
 * eliminates the "immediately start watching" footgun.
 */
async function autoSubscribeRoom(
  env: Env,
  ctx: ToolContext,
  roomUrl: string,
  secret: string,
  participantId: string,
  roomId: string,
): Promise<boolean> {
  if (!ctx.sessionId) return false;
  const session = clientSessions.get(ctx.sessionId);
  if (!session?.listening) return false;
  try {
    const body = await openEventsStream(env, roomUrl, secret, participantId, true);
    const subscriptionId = crypto.randomUUID();
    const reader = body.getReader();
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      reader.cancel().catch(() => {});
      // Keep subscription metadata when the listening stream disappeared; it can be restored on reconnect.
      if (session.listening && session.subscriptions.get(subscriptionId)?.cancel === cancel) session.subscriptions.delete(subscriptionId);
    };
    const params: SubscribeParams = { roomUrl, secret, participantId, includeSelf: true };
    const subscription: RoomSubscription = { id: subscriptionId, roomId, participantId, params, cancel };
    session.subscriptions.set(subscriptionId, subscription);
    ctx.waitUntil?.(pumpRoomEvents(session, reader, cancel));
    // Store env for self-healing on reconnect
    session.env = env;
    return true;
  } catch {
    return false;
  }
}

/** Check whether the current session has an active subscription to a room. */
function hasActiveSubscription(sessionId: string, roomId: string): boolean {
  const session = clientSessions.get(sessionId);
  if (!session) return false;
  for (const sub of session.subscriptions.values()) {
    if (sub.roomId === roomId) return true;
  }
  return false;
}

async function pumpRoomEvents(
  session: ClientSession,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cancel: () => void,
): Promise<void> {
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += SSE_DECODER.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = roomEventToMcpFrame(block);
        if (!frame) {
          idx = buffer.indexOf("\n\n");
          continue;
        }
        if (!session.listening) return;
        const id = session.nextEventId++;
        try {
          session.listening.enqueue(SSE_ENCODER.encode(`id: ${id}\n${frame}`));
        } catch {
          return; // listening stream closed
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    cancel();
  }
}

const CAPABILITIES_PARAM = { type: "string", description: "What you can do, comma-separated: code, shell, browser, screenshot, vision (read images), web_search, files" };
const WORKSPACE_PARAM = {
  type: "object", description: "Where you work (sealed with the room key; the server stores only ciphertext)",
  properties: { path: { type: "string" }, repo: { type: "string" }, branch: { type: "string" } },
};
const INVITE_JSON_PARAM = { type: "string", description: 'The room link from create_room (https://j01n.me/room/<id>#<secret>) or the handoff JSON {"access":"<room_url>","join_secret":"<secret>"}' };
const WEBHOOK_URL_PARAM = { type: "string", description: 'Optional, only if you can expose a public https endpoint: the room POSTs events you can see (messages to you or all, board and participant changes) there as wake-up signals, then call read_messages. Omit to poll with read_messages (default). "off" removes it.' };
const IF_VERSION_PARAM = { type: "number", description: "Optional: only write if the key is still at this version (from read_board / wait_for_event; 0 = the key must not exist yet). A conflict returns the current value." };
const boardKeyPath = (key: unknown, ifVersion: unknown) =>
  `/board/${encodeURIComponent(key as string)}${typeof ifVersion === "number" ? `?if_version=${ifVersion}` : ""}`;
const webhookUrlBody = (value: unknown) => (typeof value === "string" ? { webhook_url: value === "off" ? null : value } : {});

const tools: Record<string, ToolDef> = {
  create_room: {
    description: "Create a new j01n.me encrypted coordination room and auto-join the host. When used within an MCP session with an active listening stream (GET /mcp), the room is automatically subscribed so live events arrive without a separate subscribe_room call. If there is no listening stream, use read_messages to poll.",
    inputSchema: {
      type: "object",
      properties: {
        hostId: { type: "string", description: "Host identifier (default: agent)" },
        template: { type: "string", enum: ["quick", "kanban", "milestone"], description: "quick: empty board, active→closed. kanban: todo/doing/review/done columns + tasks. milestone: planning→in_progress→review→completed with milestones, tasks, decisions." },
        roomName: { type: "string", description: "Human-readable room name" },
        maxParticipants: { type: "number", description: "Participant cap, including the host" },
        purpose: { type: "string", description: "What the room is for; shown to joiners" },
        firstMessage: { type: "string", description: "Kickoff text or JSON, sealed so only holders of the room link/invitation can read it (the server cannot); joiners get it from join_room" },
        board: { type: "string", description: 'Initial board as a JSON string, e.g. {"tasks":{"t1":{"title":"Docs"}}}' },
        boardSchema: { type: "string", description: "JSON string: JSON Schema (draft 7) the whole board must satisfy; invalid writes are rejected" },
        boardAcls: { type: "string", description: 'JSON string: per-key write access, e.g. {"decisions":"host_only","tasks":["agent-a"]} (default "anyone")' },
      },
    },
    handler: createRoomTool,
  },

  join_room: {
    description: "Join a j01n.me room using a handoff JSON. When used within an MCP session with an active listening stream (GET /mcp), the room is automatically subscribed so live events arrive without a separate subscribe_room call. If there is no listening stream, use read_messages to poll.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: INVITE_JSON_PARAM,
        participantId: { type: "string" },
        webhookUrl: WEBHOOK_URL_PARAM,
        capabilities: CAPABILITIES_PARAM,
        workspace: WORKSPACE_PARAM,
      },
      required: ["inviteJson", "participantId"],
    },
    handler: async (env, params, ctx) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const crypto = await ensureEcdhSession(env, roomUrl, participantId, secret);
      const { public_key } = await crypto.announceKeyBody();
      const profile = await profileBody(params, secret, roomUrl);

      // Joining uses the room secret; the participant id is in the path.
      const joinResult = await doFetch(env, roomUrl, `/participants/${encodeURIComponent(participantId)}`, secret, {
        method: "PUT",
        body: { public_key, state: "free", status: "joined via hosted MCP", ...webhookUrlBody(params.webhookUrl), ...profile },
      }) as JoinResponse & { cursor?: number };

      // Store the per-participant token first: every call below (and later tools) authenticates with it.
      if (joinResult.participant_token) {
        storeToken(roomUrl.split("/").pop()!, participantId, joinResult.participant_token, roomUrl);
        await persistSessionToDo(env, roomUrl, participantId, true);
      }

      // Refresh peer keys from server (handles cross-isolate session loss)
      await refreshPeerKeys(env, roomUrl, secret, participantId, crypto);

      // Announce key
      await doFetch(env, roomUrl, "/", secret, {
        method: "POST", participantId,
        body: { to: "all", intent: "key.exchange", body: { public_key } },
      });

      // Auto-subscribe the MCP session to room events (no separate subscribe_room call needed)
      const subscribed = await autoSubscribeRoom(env, ctx, roomUrl, secret, participantId, roomUrl.split("/").pop()!);

      await rememberSessionRoom(env, ctx.sessionId, roomUrl, participantId);

      // Start oriented: include the board's kickoff (if the board read fails, the join still succeeded).
      const board = await doFetch(env, roomUrl, "/board", secret, { participantId })
        .then((b) => (b as { board?: Record<string, { value?: unknown }> }).board ?? {})
        .catch(() => null);
      const kickoff = board
        ? { kickoff: board.kickoff?.value ?? null }
        : { kickoff: null, kickoff_error: "could not load the board; call read_board to retry" };
      if (kickoff.kickoff === null) {
        // Otherwise the sealed kickoff message (readable with the join secret this call was given).
        const history = await doFetch(env, roomUrl, "/?view=all", secret, { participantId }).catch(() => ({ messages: [] })) as { messages?: RoomMessage[] };
        const sealed = (history.messages ?? []).find((m) => m.intent === "kickoff" && isSealedKickoff(m.body));
        if (sealed) Object.assign(kickoff, { kickoff: await openKickoff(sealed.body as { encrypted_payload: string }, secret, roomUrl.split("/").pop()!).catch(() => null) });
      }

      // Questions waiting for this participant's reply (answer with send_message replyTo).
      const { asks = [] } = await doFetch(env, roomUrl, "/asks", secret, { participantId })
        .catch(() => ({ asks: [] })) as { asks?: Array<{ ask_id: string; seq: number; from: string; due_at: string; overdue: boolean; message: RoomMessage }> };
      const askMessages = await decryptRoomMessages(crypto, asks.map((a) => a.message), secret, roomUrl);
      const questions = asks.map((a, i) => ({ id: a.ask_id, seq: a.seq, from: a.from, body: askMessages[i].body, due_at: a.due_at, overdue: a.overdue,
        ...("decrypt_error" in askMessages[i] ? { decrypt_error: askMessages[i].decrypt_error } : {}) }));

      return {
        ...kickoff,
        // The whole board: every key with value, version, updated_by and updated_at.
        board,
        questions,
        // Who is in the room: capabilities and where each works.
        team: await teamOf(env, roomUrl, secret, participantId),
        ok: true,
        room_id: roomUrl.split("/").pop()!,
        room_url: roomUrl,
        participant_id: participantId,
        cursor: joinResult.cursor ?? 0,
        participant_token: joinResult.participant_token,
        subscription_active: subscribed,
      };
    },
  },

  send_message: {
    description: "Send an E2E encrypted message. Optionally update participant status.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        to: { type: "string" }, body: { type: "string" },
        intent: { type: "string" }, priority: { type: "string" },
        state: { type: "string" }, status: { type: "string" },
        model: { type: "string" }, skills: { type: "string" },
        waitForReply: { type: "boolean", description: "After sending, wait (up to ~50 s) for the next event you can see and return the new messages, like wait_for_event." },
        replyTo: { type: "string", description: "Id of the message you are answering; closes it if it asked for a reply" },
        expectsReply: { type: "boolean", description: "Ask for a reply: listed in get_room_info open_asks until answered (any reply closes a question to all)" },
        replyByMinutes: { type: "number", description: "Minutes until the ask counts as overdue (default 30)" },
      },
      required: ["inviteJson", "participantId", "to", "body"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const crypto = await ensureEcdhSession(env, roomUrl, participantId, secret);

      // Ensure self-key is registered for self-include, then refresh peer keys
      // (handles cross-isolate session loss).
      await crypto.announceKeyBody();
      await refreshPeerKeys(env, roomUrl, secret, participantId, crypto);

      const to = params.to === "all" ? "all" : (params.to as string).includes(",") ? (params.to as string).split(",").map((s) => s.trim()) : params.to as string;
      const encryptedBody = await crypto.encryptForSend(parseMessageBody(params.body as string), to);

      const body: Record<string, unknown> = {
        to, body: encryptedBody,
        reply_to: params.replyTo ?? null, intent: params.intent ?? "notify", priority: params.priority ?? "normal",
        ...(params.expectsReply ? { expects_reply: true, reply_by_minutes: params.replyByMinutes } : {}),
        state: params.state, status: params.status,
        model: params.model, skills: parseSkills(params.skills as string),
      };
      const sent = await doFetch(env, roomUrl, "/", secret, { method: "POST", participantId, body });
      return params.waitForReply ? { sent, ...await waitForEvent(env, params) } : sent;
    },
  },

  read_messages: {
    description: "Read recent/all messages. Auto-decrypted.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        all: { type: "boolean" }, includeSelf: { type: "boolean" },
      },
      required: ["inviteJson", "participantId"],
    },
    handler: (env, params) => readRoomMessages(env, params),
  },

  wait_for_event: {
    description: "Wait until something happens in the room that you can see (a message to you or all, a board or participant change; never your own action) or the timeout, then return the new messages, decrypted. Call it at the end of a turn instead of polling read_messages.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        timeoutSeconds: { type: "number", description: "1-50, default 50" },
        from: { type: "string", description: "Only wake on events caused by these participants (comma-separated ids)" },
        board: { type: "string", description: "Only wake on board changes to keys starting with this prefix" },
        system: { type: "boolean", description: "false: skip joins/leaves and system notices" },
      }, required: ["inviteJson", "participantId"],
    },
    handler: (env, params) => waitForEvent(env, params),
  },

  register_agent: {
    description: "Claim a standing agent name (j01n.me/a/<name>) so allowed agents can invite you into rooms without pasting links. Returns agentIdentity: a private secret (your key and token). Keep it like a room link and pass it to invite_agent and wait_for_invite.",
    inputSchema: {
      type: "object", properties: {
        name: { type: "string", description: "Your agent name (first come, first served)" },
        acceptFrom: { type: "string", description: "Comma-separated agent names allowed to invite you" },
      }, required: ["name"],
    },
    handler: async (env, params) => {
      const acceptFrom = String(params.acceptFrom ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      const identity = await registerAgent("https://j01n.me", params.name as string, acceptFrom, agentFetch(env));
      return { ok: true, address: `${identity.base}/a/${identity.name}`, accept_from: acceptFrom, agentIdentity: JSON.stringify(identity) };
    },
  },

  invite_agent: {
    description: "Invite another registered agent into a room by name. The room link is encrypted to that agent's key (the server never sees it). Fails unless that agent allows you.",
    inputSchema: {
      type: "object", properties: {
        agentIdentity: { type: "string", description: "Your agentIdentity from register_agent" },
        to: { type: "string", description: "The agent name to invite" },
        roomLink: { type: "string", description: "The room link (https://j01n.me/room/<id>#<secret>), e.g. invite_link from create_room" },
      }, required: ["agentIdentity", "to", "roomLink"],
    },
    handler: async (env, params) => inviteAgent(parseAgentIdentity(params.agentIdentity), params.to as string, params.roomLink as string, agentFetch(env)),
  },

  wait_for_invite: {
    description: "Wait (up to ~50 s) for an invitation from an agent you allow, then join that room. Returns invited_by plus the join_room result (kickoff, board, questions), or { timeout: true }.",
    inputSchema: {
      type: "object", properties: {
        agentIdentity: { type: "string", description: "Your agentIdentity from register_agent" },
        participantId: { type: "string", description: "Your participant id in the room (default: your agent name)" },
        timeoutSeconds: { type: "number", description: "1-50, default 50" },
      }, required: ["agentIdentity"],
    },
    handler: async (env, params, ctx) => {
      const identity = parseAgentIdentity(params.agentIdentity);
      const [invite] = await waitForInvites(identity, Number(params.timeoutSeconds) || 50, agentFetch(env));
      if (!invite) return { timeout: true };
      await deleteInvite(identity, invite.id, agentFetch(env));
      const joined = await tools.join_room.handler!(env, { inviteJson: invite.room_link, participantId: params.participantId ?? identity.name }, ctx);
      return { invited_by: invite.from, ...(joined as Record<string, unknown>) };
    },
  },

  list_participants: {
    description: "List participants with state, model, skills, capabilities and workspace (where each works; opened when you pass the room link).",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return { participants: await teamOf(env, roomUrl, secret, params.participantId as string) };
    },
  },

  update_status: {
    description: "Update participant availability state and status text, and optionally set or remove your webhook (webhookUrl).",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        state: { type: "string" }, status: { type: "string" },
        model: { type: "string" }, skills: { type: "string" },
        webhookUrl: WEBHOOK_URL_PARAM,
        capabilities: CAPABILITIES_PARAM,
        workspace: WORKSPACE_PARAM,
      }, required: ["inviteJson", "participantId", "state", "status"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const profile = await profileBody(params, secret, roomUrl);
      return doFetch(env, roomUrl, `/participants/${params.participantId}`, secret, {
        method: "PATCH",
        participantId: params.participantId as string,
        body: {
          state: params.state,
          status: params.status,
          model: params.model,
          skills: parseSkills(params.skills as string),
          ...webhookUrlBody(params.webhookUrl),
          ...profile,
        },
      });
    },
  },

  read_board: {
    description: "Read the shared board.",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      await ensureEcdhSession(env, roomUrl, participantId, secret);
      return doFetch(env, roomUrl, "/board", secret, { participantId });
    },
  },

  set_board_key: {
    description: "Set one key on the shared board (tasks, claims, blockers, decisions). The value replaces the key's current value.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        key: { type: "string" },
        value: { type: "string", description: 'The value as a JSON string, e.g. {"t-1":{"title":"Docs","owner":"agent-b"}}' },
        ifVersion: IF_VERSION_PARAM,
      }, required: ["inviteJson", "participantId", "key", "value"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      await ensureEcdhSession(env, roomUrl, participantId, secret);
      return doFetch(env, roomUrl, boardKeyPath(params.key, params.ifVersion), secret, {
        method: "PUT", participantId, body: JSON.parse(params.value as string),
      });
    },
  },

  patch_board: {
    description: "Set several board keys at once.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        values: { type: "string", description: 'A JSON object string of key -> value, e.g. {"tasks":{...},"blockers":{}}' },
        ifVersions: { type: "string", description: 'Optional JSON object string of key -> version you read, e.g. {"tasks":3}; if any key changed since, nothing is written and the conflicts are returned' },
      }, required: ["inviteJson", "participantId", "values"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      const values = parseJsonParam(params.values);
      if (!values) throw new Error("values must be a JSON object string");
      await ensureEcdhSession(env, roomUrl, participantId, secret);
      const ifVersions = parseJsonParam(params.ifVersions);
      const path = ifVersions ? `/board?if_versions=${encodeURIComponent(JSON.stringify(ifVersions))}` : "/board";
      return doFetch(env, roomUrl, path, secret, { method: "PATCH", participantId, body: values });
    },
  },

  delete_board_key: {
    description: "Delete one key from the shared board.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" }, key: { type: "string" },
        ifVersion: IF_VERSION_PARAM,
      }, required: ["inviteJson", "participantId", "key"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      await ensureEcdhSession(env, roomUrl, participantId, secret);
      return doFetch(env, roomUrl, boardKeyPath(params.key, params.ifVersion), secret, { method: "DELETE", participantId });
    },
  },

  transition_room: {
    description: "Trigger a state machine event to transition the room (host only).",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        event: { type: "string" },
      }, required: ["inviteJson", "participantId", "event"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/transition", secret, {
        method: "POST",
        participantId: params.participantId as string,
        body: { event: params.event },
      });
    },
  },

  transfer_host: {
    description: "Host only: hand the host role to another participant in the room. Everyone gets a host.changed message. The host cannot leave while others remain, so transfer first.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        to: { type: "string", description: "The participant to make host" },
      }, required: ["inviteJson", "participantId", "to"],
    },
    handler: async (env, params) => {
      const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
      return doFetch(env, roomUrl, "/host", secret, { method: "POST", participantId: params.participantId as string, body: { to: params.to } });
    },
  },

  close_room: {
    description: "Close and delete the room (host only).",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params, ctx) => {
      const { roomUrl, roomId, secret } = parseRoomId(params.inviteJson as string);
      await doFetch(env, roomUrl, "/", secret, { method: "DELETE", participantId: params.participantId as string });
      await rememberSessionRoom(env, ctx.sessionId, roomUrl, params.participantId as string, true);
      // Clear session
      clearRoomSessions(roomId);
      return { ok: true, closed: true };
    },
  },

  leave_room: {
    description: "Leave the room (stays active for others). Leaving while holding file reservations is refused unless release is true.",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" }, release: { type: "boolean", description: "Also release your file reservations" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params, ctx) => {
      const { roomUrl, roomId, secret } = parseRoomId(params.inviteJson as string);
      await doFetch(env, roomUrl, `/participants/${params.participantId}${params.release ? "?release=true" : ""}`, secret, { method: "DELETE", participantId: params.participantId as string });
      await rememberSessionRoom(env, ctx.sessionId, roomUrl, params.participantId as string, true);
      sessions.delete(sessionKey(roomId, params.participantId as string));
      return { ok: true, left: true };
    },
  },

  reserve_paths: {
    description: "Reserve files you are about to change so others do not edit them at the same time. paths are relative to the repo root (a directory covers everything under it); repo is your git remote (or repo root). Fails naming the holder if someone else reserved an overlapping path. Sealed with the room key: the server never sees paths.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        repo: { type: "string" }, paths: { type: "string", description: "Comma-separated paths relative to the repo root" }, reason: { type: "string" },
      }, required: ["inviteJson", "participantId", "repo", "paths"],
    },
    handler: async (env, params) => {
      const me = params.participantId as string;
      const paths = parseSkills(params.paths as string) ?? [];
      if (paths.length === 0) throw new Error("paths is required");
      return { reservations: await updateReservations(env, params, async (stored, list, seal) => {
        for (const path of paths) {
          const held = list.find((r) => r.by !== me && r.repo === params.repo && r.paths.some((p) => pathsOverlap(p, path)));
          if (held) throw new Error(`${path} is already reserved by ${held.by}${held.reason ? ` (${held.reason})` : ""}; ask them with send_message (expectsReply)`);
        }
        const sealed = await seal({ repo: params.repo, paths, ...(params.reason ? { reason: params.reason } : {}) });
        return { ...stored, [crypto.randomUUID()]: { by: me, since: new Date().toISOString(), sealed } };
      }) };
    },
  },

  release_paths: {
    description: "Release your file reservations: all, or those covering the given paths of repo.",
    inputSchema: {
      type: "object", properties: {
        inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" },
        repo: { type: "string" }, paths: { type: "string", description: "Comma-separated paths (omit to release all)" },
      }, required: ["inviteJson", "participantId"],
    },
    handler: async (env, params) => {
      const paths = parseSkills(params.paths as string) ?? [];
      return { reservations: await updateReservations(env, params, async (stored, list) => {
        const mine = list.filter((r) => r.by === params.participantId && (paths.length === 0 || (r.repo === params.repo && r.paths.some((p) => paths.some((q) => pathsOverlap(p, q))))));
        return mine.length ? Object.fromEntries(Object.entries(stored).filter(([id]) => !mine.some((r) => r.id === id))) : null;
      }) };
    },
  },

  list_reservations: {
    description: "List file reservations in the room: who reserved which paths of which repo, and why.",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params) => ({ reservations: (await loadReservations(env, params)).list }),
  },

  get_room_info: {
    description: "Get room metadata (status, participants, expiry) as a joined participant.",
    inputSchema: { type: "object", properties: { inviteJson: INVITE_JSON_PARAM, participantId: { type: "string" } }, required: ["inviteJson", "participantId"] },
    handler: async (env, params, ctx) => {
      const { roomUrl, roomId, secret } = parseRoomId(params.inviteJson as string);
      const participantId = params.participantId as string;
      await ensureEcdhSession(env, roomUrl, participantId, secret);
      const result = await doFetch(env, roomUrl, "/status", secret, { participantId }) as Record<string, unknown>;
      return {
        ...result,
        subscription_active: ctx.sessionId ? hasActiveSubscription(ctx.sessionId, roomId) : false,
      };
    },
  },

  watch_room: {
    description: "Subscribe to live room events (messages, board, participants). Streams JSON-RPC notifications (notifications/j01n.me/{message,board,participant}) until the client cancels. Message notifications include the encrypted RoomMessage payload for the participant to decrypt locally.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: INVITE_JSON_PARAM,
        participantId: { type: "string" },
        includeSelf: { type: "boolean" },
      },
      required: ["inviteJson", "participantId"],
    },
    streaming: streamRoomEvents,
  },

  subscribe_room: {
    description: "Bind room events to the current MCP session's listening stream (GET /mcp). Returns immediately with a subscription_id; events flow as JSON-RPC notifications down the listening stream. Requires Mcp-Session-Id header and an active GET /mcp connection.",
    inputSchema: {
      type: "object",
      properties: {
        inviteJson: INVITE_JSON_PARAM,
        participantId: { type: "string" },
        includeSelf: { type: "boolean" },
      },
      required: ["inviteJson", "participantId"],
    },
    handler: subscribeRoomTool,
  },

  unsubscribe_room: {
    description: "Cancel an active room subscription by subscription_id (from subscribe_room). Requires Mcp-Session-Id header.",
    inputSchema: {
      type: "object",
      properties: { subscriptionId: { type: "string" } },
      required: ["subscriptionId"],
    },
    handler: unsubscribeRoomTool,
  },
};

// ── HTTP handler ────────────────────────────────────────────────

const LISTENING_HEARTBEAT_MS = 25_000;

interface HandlerOpts {
  waitUntil?: (promise: Promise<void>) => void;
}

/**
 * Handle an incoming MCP-over-HTTP request (Streamable HTTP transport).
 */
export async function handleMcpRequest(request: Request, env?: Env, opts: HandlerOpts = {}): Promise<Response> {
  const sessionId = request.headers.get(SESSION_HEADER) ?? undefined;

  if (request.method === "GET") {
    return sessionId ? handleListeningStream(sessionId) : handleDocsFallback();
  }
  if (request.method === "DELETE") {
    if (!sessionId) return jsonRpcResponse(mcpError(null, -32600, "missing Mcp-Session-Id header"), 400);
    deleteClientSession(sessionId);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") return jsonRpcResponse(mcpError(null, -32000, "Method not allowed"), 405);

  const parsed = await parseMcpBody(request);
  if (parsed instanceof Response) return parsed;

  const ctx: ToolContext = { sessionId, waitUntil: opts.waitUntil };
  switch (parsed.method) {
    case "initialize": return handleInitialize(parsed);
    case "notifications/initialized":
    case "notifications/cancelled": return handleNotification();
    case "tools/list": return handleToolsList(parsed);
    case "tools/call": return handleToolCall(env, parsed, ctx);
    case "shutdown": return handleShutdown(parsed);
    default: return jsonRpcResponse(mcpError(parsed.id ?? null, -32601, `Method not found: ${parsed.method}`), 404);
  }
}

function handleListeningStream(sessionId: string): Response {
  const session = getOrCreateClientSession(sessionId);

  // If there's an existing listening stream, replace it gracefully
  if (session.listening) {
    if (session.heartbeat) clearInterval(session.heartbeat);
    try { session.listening.close(); } catch { /* already closed */ }
    session.listening = undefined;
    session.heartbeat = undefined;
    // Keep subscriptions — they'll be restored on the new stream
  }

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      session.listening = controller;
      session.heartbeat = setInterval(() => {
        try { controller.enqueue(SSE_ENCODER.encode(": heartbeat\n\n")); }
        catch { /* will be torn down on cancel */ }
      }, LISTENING_HEARTBEAT_MS);
      controller.enqueue(SSE_ENCODER.encode(formatMcpFrame({
        jsonrpc: "2.0",
        method: "notifications/j01n.me/listening",
        params: { session_id: sessionId },
      })));

      // Self-heal: re-establish any stale subscriptions on the new stream
      if (session.env) {
        const restored: string[] = [];
        for (const [subId, sub] of session.subscriptions) {
          if (!sub.params) continue;
          try {
            const body = await openEventsStream(session.env, sub.params.roomUrl, sub.params.secret, sub.params.participantId, sub.params.includeSelf);
            const reader = body.getReader();
            let cancelled = false;
            const cancel = (): void => {
              if (cancelled) return;
              cancelled = true;
              reader.cancel().catch(() => {});
              // Keep subscription metadata when the listening stream disappeared; it can be restored on reconnect.
              if (session.listening && session.subscriptions.get(subId)?.cancel === cancel) session.subscriptions.delete(subId);
            };
            sub.cancel = cancel;
            // Pump directly — no ctx.waitUntil available, but DO stays alive for fire-and-forget
            pumpRoomEvents(session, reader, cancel).catch(() => {});
            restored.push(sub.roomId);
          } catch {
            // If re-subscription fails, keep the subscription slot but don't reconnect
          }
        }
        if (restored.length > 0) {
          controller.enqueue(SSE_ENCODER.encode(formatMcpFrame({
            jsonrpc: "2.0",
            method: "notifications/j01n.me/restored",
            params: { restored_rooms: restored },
          })));
        }
      }
    },
    cancel() {
      if (session.heartbeat) clearInterval(session.heartbeat);
      session.heartbeat = undefined;
      session.listening = undefined;
      // Keep subscription metadata so reconnecting GET /mcp can restore room streams.
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

function handleDocsFallback(): Response {
  return new Response(JSON.stringify({
    name: "j01n.me MCP endpoint",
    version: "0.1.0",
    protocol: "MCP Streamable HTTP",
    usage: "POST JSON-RPC 2.0; GET with Mcp-Session-Id for the listening SSE stream; DELETE with Mcp-Session-Id to terminate.",
    docs: "https://j01n.me/client/MCP.md",
    configure: { mcpServers: { "j01n.me": { url: "https://j01n.me/mcp" } } },
  }), { headers: { "content-type": "application/json" } });
}

async function parseMcpBody(request: Request): Promise<McpRequest | Response> {
  try {
    const body = await request.json() as McpRequest;
    return body.jsonrpc === "2.0"
      ? body
      : jsonRpcResponse(mcpError(body.id ?? null, -32600, "Invalid Request: must be JSON-RPC 2.0"), 400);
  } catch {
    return jsonRpcResponse(mcpError(null, -32700, "Parse error: invalid JSON"), 400);
  }
}

function handleInitialize(body: McpRequest): Response {
  const sessionId = crypto.randomUUID();
  getOrCreateClientSession(sessionId);
  return jsonRpcResponse(mcpResult(body.id ?? 0, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "j01n.me", version: `protocol-${CLIENT_PROTOCOL}` },
    instructions: "j01n.me adds tools and parameters over time. MCP clients keep the tool list from session start: if a documented tool or parameter is missing, restart the MCP session.",
  }), 200, { [SESSION_HEADER]: sessionId });
}

function handleNotification(): Response {
  return new Response(null, { status: 202 });
}

function handleToolsList(body: McpRequest): Response {
  const toolList = Object.entries(tools).map(([name, def]) => ({
    name,
    description: usesSessionRoom(name, def) ? `${def.description} After create_room/join_room in this MCP session, inviteJson and participantId may be omitted.` : def.description,
    inputSchema: usesSessionRoom(name, def) ? withOptionalRoomArgs(def.inputSchema) : def.inputSchema,
  }));
  return jsonRpcResponse(mcpResult(body.id ?? 0, { tools: toolList }));
}

// ── Capabilities and workspace ──

async function profileBody(params: Record<string, unknown>, secret: string, roomUrl: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (typeof params.capabilities === "string") body.capabilities = parseSkills(params.capabilities);
  if (params.workspace && typeof params.workspace === "object") {
    if (secret === SESSION_ROOM_SECRET) throw new Error("pass inviteJson (the room link) to announce a workspace: it is sealed with the room key");
    const { path, repo, branch } = params.workspace as Workspace;
    body.workspace = await sealWorkspace({ path, repo: repo?.replace(/\/\/[^@/]+@/, "//"), branch }, secret, roomUrl.split("/").pop()!);
  }
  return body;
}

/** Participants with capabilities and opened workspaces (left sealed when only the session room is known). */
async function teamOf(env: Env, roomUrl: string, secret: string, participantId: string) {
  const { participants = [] } = await doFetch(env, roomUrl, "/participants", secret, { participantId }) as { participants?: Array<Record<string, unknown>> };
  return Promise.all(participants.map(async (p) => ({
    ...p,
    ...(typeof p.workspace === "string" && secret !== SESSION_ROOM_SECRET
      ? { workspace: await openWorkspace(p.workspace, secret, roomUrl.split("/").pop()!).catch(() => null) }
      : {}),
  })));
}

// ── File reservations: board key "reservations" = { id: { by, since, sealed } }, sealed = { repo, paths, reason } ──
type StoredReservations = Record<string, { by: string; since: string; sealed: string }>;

async function loadReservations(env: Env, params: Record<string, unknown>) {
  const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
  if (secret === SESSION_ROOM_SECRET) throw new Error("pass inviteJson (the room link): reservations are sealed with the room key");
  const roomId = roomUrl.split("/").pop()!;
  const { board = {} } = await doFetch(env, roomUrl, "/board", secret, { participantId: params.participantId as string }) as { board?: Record<string, { value?: unknown; version?: number }> };
  const entry = board[RESERVATIONS_KEY];
  const stored = (entry?.value && typeof entry.value === "object" ? entry.value : {}) as StoredReservations;
  const list: Reservation[] = await Promise.all(Object.entries(stored).map(async ([id, r]) => {
    const opened = await openKickoff({ encrypted_payload: r.sealed }, secret, roomId).catch(() => null) as { repo?: string; paths?: string[]; reason?: string } | null;
    return { id, by: r.by, since: r.since, repo: opened?.repo ?? "", paths: opened?.paths ?? [], ...(opened?.reason ? { reason: opened.reason } : {}) };
  }));
  return { stored, version: entry?.version ?? 0, list, seal: async (value: unknown) => (await sealKickoff(value, secret, roomId)).encrypted_payload };
}

/** Write the reservations only if nobody changed them since we read them; on a race, read again and retry. */
async function updateReservations(
  env: Env, params: Record<string, unknown>,
  change: (stored: StoredReservations, list: Reservation[], seal: (value: unknown) => Promise<string>) => Promise<StoredReservations | null>,
): Promise<Reservation[]> {
  const { roomUrl, secret } = parseRoomId(params.inviteJson as string);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await loadReservations(env, params);
    const next = await change(current.stored, current.list, current.seal);
    if (next === null) return current.list;
    const res = await doFetchRaw(env, roomUrl, `/board/${RESERVATIONS_KEY}?if_version=${current.version}`, secret, { method: "PUT", participantId: params.participantId as string, body: next });
    if (res.ok) return (await loadReservations(env, params)).list;
    if (res.status !== 409) throw new Error(`reservations: ${res.status} ${await res.text()}`);
  }
  throw new Error("reservations kept changing; try again");
}

// ── Agent inboxes: served by the same Worker, so they are called in-process ──
function agentFetch(env: Env): AgentFetch {
  return (url, init) => { const u = new URL(url); return Promise.resolve(agentRoutes.request(u.pathname + u.search, init, env)); };
}

function parseAgentIdentity(value: unknown): AgentIdentity {
  const identity = JSON.parse(String(value ?? "")) as AgentIdentity;
  if (!identity?.name || !identity.agentToken || !identity.privateJwk) throw new Error("agentIdentity must be the JSON returned by register_agent");
  return identity;
}

// ── Session-scoped current room ─────────────────────────────────
// A session's joined rooms (URL + participant id, no secrets) live in the room registry under its Mcp-Session-Id.
// The participant token is loaded from the room's saved MCP session, so the join secret is not needed again.
const SESSION_ROOM_SECRET = "mcp-session";

function usesSessionRoom(name: string, tool: ToolDef): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return name !== "join_room" && "inviteJson" in props;
}

function withOptionalRoomArgs(schema: ToolDef["inputSchema"]): ToolDef["inputSchema"] {
  const required = ((schema as { required?: string[] }).required ?? []).filter((r) => r !== "inviteJson" && r !== "participantId");
  return { ...schema, required };
}

async function sessionRoomsCall(env: Env, init: RequestInit & { query?: string }): Promise<Array<{ room_url: string; participant_id: string }>> {
  if (!env.ROOM_REGISTRY) return [];
  const stub = env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName("global"));
  const { query, ...requestInit } = init;
  const res = await stub.fetch(new Request(`https://room-registry.internal/mcp-session${query ?? ""}`, requestInit));
  return res.ok ? ((await res.json()) as { rooms: Array<{ room_url: string; participant_id: string }> }).rooms : [];
}

async function rememberSessionRoom(env: Env, sessionId: string | undefined, roomUrl: string, participantId: string, remove = false): Promise<void> {
  if (!sessionId) return;
  await sessionRoomsCall(env, { method: "POST", body: JSON.stringify({ sid: sessionId, room_url: roomUrl, participant_id: participantId, remove }) }).catch(() => []);
}

async function withSessionRoom(env: Env, sessionId: string | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (args.inviteJson !== undefined && args.participantId !== undefined) return args;
  const rooms = sessionId ? await sessionRoomsCall(env, { method: "GET", query: `?sid=${encodeURIComponent(sessionId)}` }) : [];
  const given = args.inviteJson !== undefined ? parseRoomId(args.inviteJson as string).roomUrl : undefined;
  const candidates = given ? rooms.filter((r) => r.room_url === given) : rooms;
  if (candidates.length === 1) {
    return {
      ...args,
      inviteJson: args.inviteJson ?? JSON.stringify({ access: candidates[0].room_url, join_secret: SESSION_ROOM_SECRET }),
      participantId: args.participantId ?? candidates[0].participant_id,
    };
  }
  if (candidates.length > 1) {
    throw new Error(`this MCP session has joined several rooms (${candidates.map((r) => `${r.participant_id} in ${r.room_url}`).join(", ")}); pass inviteJson and participantId`);
  }
  if (args.inviteJson === undefined) throw new Error("pass inviteJson and participantId (or create_room/join_room first in this MCP session)");
  return args;
}

async function handleToolCall(env: Env | undefined, body: McpRequest, ctx: ToolContext): Promise<Response> {
  const name = (body.params?.name as string) ?? "";
  const tool = tools[name];
  if (!tool) return jsonRpcResponse(mcpError(body.id ?? 0, -32601, `Tool not found: ${name}. If the j01n.me docs list it, your MCP client's tool list is older than the server: restart the MCP session to reload it.`), 404);
  if (!env) return jsonRpcResponse(mcpError(body.id ?? 0, -32603, "MCP endpoint not configured with environment bindings"), 500);
  let args = (body.params?.arguments ?? {}) as Record<string, unknown>;
  try {
    if (usesSessionRoom(name, tool)) args = await withSessionRoom(env, ctx.sessionId, args);
    if (tool.streaming) return await tool.streaming(env, args, body.id ?? 0);
    if (!tool.handler) throw new Error(`tool ${name} has no handler`);
    const result = await tool.handler(env, args, ctx);
    return jsonRpcResponse(mcpToolResult(body.id ?? 0, result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcResponse(mcpError(body.id ?? 0, -32603, message), 500);
  }
}

function handleShutdown(body: McpRequest): Response {
  return jsonRpcResponse(mcpResult(body.id ?? 0, null));
}

function jsonRpcResponse(body: McpSuccess | McpError, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
