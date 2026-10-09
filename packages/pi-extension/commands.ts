import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildMinimalInvite, createRoom, joinRoom, normalizeInvite, resumeRoom, RoomApiError } from "@j01n/sdk";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import type { Invite, RoomClient } from "@j01n/sdk";
import { parseArgs, type ParsedArgs } from "./args";

const sessions = new Map<string, RoomClient>();

async function getClient(parsed: ParsedArgs): Promise<RoomClient> {
  if (!parsed.me) throw new Error("needs: participant_id. Use join first to create a session.");
  return openSession(resolveInvite(parsed), parsed.me);
}

/** Same key file name and format as the tiny CLI helper, so both share one identity per room. */
function keyFilePath(roomUrl: string, me: string): string {
  return ".j01n-" + new URL(roomUrl).pathname.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + me.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

interface SavedSession {
  privateJwk?: JsonWebKey;
  publicJwk?: JsonWebKey;
  peers?: Record<string, string>;
  participantToken?: string;
}

/**
 * Join once, then resume on later commands (even from a new Pi process) using the
 * participant token and ECDH keypair saved in the key file.
 */
async function openSession(invite: Invite, me: string): Promise<RoomClient> {
  const cacheKey = `${invite.room_id}:${me}`;
  const cached = sessions.get(cacheKey);
  if (cached) return cached;

  const file = keyFilePath(invite.room_url, me);
  const saved: SavedSession = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const crypto = await createSdkCryptoSession(me, saved.privateJwk, saved.publicJwk);
  const token = invite.participant_token ?? saved.participantToken;

  let client: RoomClient;
  if (token) {
    client = await resumeRoom({ ...invite, participant_token: token }, me, crypto);
  } else {
    try {
      client = await joinRoom(invite, me, {}, crypto);
    } catch (err) {
      if (err instanceof RoomApiError && err.status === 409) {
        throw new Error(`${me} already joined this room but no participant token was found in ${file}. Run from the directory where you joined, or pass a participant profile containing participant_token.`);
      }
      throw err;
    }
  }
  writeFileSync(file, JSON.stringify({ ...saved, ...(await crypto.exportKeyPair()), participantToken: client.invite.participant_token }, null, 2));
  sessions.set(cacheKey, client);
  return client;
}

function loadInviteFromArg(ref: string): Invite {
  const text = ref.trim().startsWith("{") ? ref : readFileSync(ref, "utf8");
  return normalizeInvite(JSON.parse(text));
}

function resolveInvite(parsed: ParsedArgs): Invite {
  if (isRoomUrlForm(parsed)) return buildMinimalInvite(parsed.roomUrlOrInvite, parsed.joinSecret);
  if (parsed.roomUrlOrInvite) return loadInviteFromArg(parsed.roomUrlOrInvite);
  throw new Error("missing invite reference. Provide room_url + join_secret + me, an invite file, or inline JSON.");
}

function isRoomUrlForm(parsed: ParsedArgs): parsed is ParsedArgs & { roomUrlOrInvite: string; joinSecret: string; me: string } {
  rejectCreateRoomUrlForm(parsed);
  return hasRoomUrlCredentials(parsed);
}

function rejectCreateRoomUrlForm(parsed: ParsedArgs): void {
  if (parsed.cmd === "create" && parsed.joinSecret) throw new Error("create does not use room-url form");
}

function hasRoomUrlCredentials(parsed: ParsedArgs): boolean {
  return !!(parsed.roomUrlOrInvite && parsed.joinSecret && parsed.me);
}

function parseOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

async function handleCreate(parsed: ParsedArgs): Promise<string> {
  const options = parsed.rest[0] ? JSON.parse(parsed.rest[0]) : {};
  const invite = await createRoom(createBaseUrl(parsed), {
    hostId: options.host_id,
    roomName: options.room_name,
    maxParticipants: options.max_participants,
    inviteTtlMs: options.invite_ttl_ms,
    purpose: options.purpose,
    board: parseOptionalObject(options.board),
    boardSchema: parseOptionalObject(options.board_schema),
  });
  return JSON.stringify(invite, null, 2);
}

function createBaseUrl(parsed: ParsedArgs): string {
  return (parsed.roomUrlOrInvite || process.env.BASE_URL || "https://j01n.me").replace(/\/$/, "");
}

async function handleJoin(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("join needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);
  return JSON.stringify({
    ok: true,
    participant_id: parsed.me,
    room_id: invite.room_id,
    room_url: invite.room_url,
    cursor: client.cursor,
  }, null, 2);
}

async function handleSend(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("send needs: participant_id <to> <json_body>");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);

  const [toRaw, bodyJson] = parsed.rest;
  if (!toRaw || !bodyJson) throw new Error('send needs: <to> <json_body> (e.g. all \'{"text":"hello"}\')');
  const result = await client.send(parseRecipient(toRaw), JSON.parse(bodyJson));
  return JSON.stringify(result, null, 2);
}

async function handleDoctor(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("doctor needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);

  const participants = await client.participants();
  const messages = await client.read({ all: true, includeSelf: true });
  return JSON.stringify({
    ok: participants.participants.some((p) => p.id === parsed.me),
    participant_id: parsed.me,
    joined: participants.participants.some((p) => p.id === parsed.me),
    cursor: client.cursor,
    room_id: invite.room_id,
    known_peers: knownPeers(messages, parsed.me),
    encrypted_messages_undecrypted: messages.filter(isUndecrypted).length,
  }, null, 2);
}

function parseRecipient(raw: string): "all" | string | string[] {
  if (raw === "all") return "all";
  return raw.includes(",") ? raw.split(",").map((s) => s.trim()) : raw.trim();
}

function knownPeers(messages: Awaited<ReturnType<RoomClient["read"]>>, me: string): string[] {
  return messages.filter((m) => m.intent === "key.exchange" && m.from !== me).map((m) => m.from);
}

function isUndecrypted(message: Awaited<ReturnType<RoomClient["read"]>>[number]): boolean {
  const body = message.body as Record<string, unknown> | null;
  return body !== null && typeof body === "object" && body.encrypted === true;
}

async function handleRead(parsed: ParsedArgs, all: boolean): Promise<string> {
  if (!parsed.me) throw new Error("read needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);
  const messages = await client.read({ all, includeSelf: true });
  return JSON.stringify(messages, null, 2);
}

async function handleBoard(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const result = await client.board();
  return JSON.stringify(result, null, 2);
}

async function handleBoardSet(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [key, valueJson] = parsed.rest;
  if (!key || !valueJson) throw new Error("board_set needs: <key> <json_value>");
  const result = await client.setBoardKey(key, JSON.parse(valueJson));
  return JSON.stringify(result, null, 2);
}

async function handleBoardPatch(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [valueJson] = parsed.rest;
  if (!valueJson) throw new Error("board_patch needs: <json_values>");
  const result = await client.patchBoard(JSON.parse(valueJson));
  return JSON.stringify(result, null, 2);
}

async function handleBoardDelete(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [key] = parsed.rest;
  if (!key) throw new Error("board_delete needs: <key>");
  const result = await client.deleteBoardKey(key);
  return JSON.stringify(result, null, 2);
}

async function handleStatus(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [state, status] = parsed.rest;
  if (!state || !status) throw new Error("status needs: <free|busy> <status_text>");
  const result = await client.updateStatus(state as "free" | "busy", status);
  return JSON.stringify(result, null, 2);
}

async function handleWebhook(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [url] = parsed.rest;
  if (!url) throw new Error("webhook needs: <https_url|off>");
  const result = await client.setWebhook(url === "off" ? null : url);
  return JSON.stringify(result, null, 2);
}

async function handleLeave(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  await client.leave();
  sessions.delete(client.participantId);
  return JSON.stringify({ ok: true, left: true });
}

async function handleClose(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const result = await client.close();
  sessions.delete(client.participantId);
  return JSON.stringify(result, null, 2);
}

async function handleParticipants(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const result = await client.participants();
  return JSON.stringify(result, null, 2);
}

async function handleStatusInfo(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const result = await client.status();
  return JSON.stringify(result, null, 2);
}

async function handleTransition(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [event] = parsed.rest;
  if (!event) throw new Error("transition needs: <event>");
  const result = await client.transition(event);
  return JSON.stringify(result, null, 2);
}

const COMMANDS: Record<string, (parsed: ParsedArgs) => Promise<string>> = {
  create: handleCreate,
  join: handleJoin,
  send: handleSend,
  read: (parsed) => handleRead(parsed, false),
  inbox: (parsed) => handleRead(parsed, true),
  doctor: handleDoctor,
  board: handleBoard,
  board_set: handleBoardSet,
  board_patch: handleBoardPatch,
  board_delete: handleBoardDelete,
  status: handleStatus,
  webhook: handleWebhook,
  leave: handleLeave,
  close: handleClose,
  participants: handleParticipants,
  room_status: handleStatusInfo,
  transition: handleTransition,
};

export async function runj01n(args: string[]): Promise<string> {
  const parsed = parseArgs(args);
  const handler = COMMANDS[parsed.cmd];
  if (!handler) throw new Error(`unknown command: ${parsed.cmd}. Usage: create|join|send|read|inbox|doctor`);
  return handler(parsed);
}
