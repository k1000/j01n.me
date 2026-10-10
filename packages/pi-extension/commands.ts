import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildMinimalInvite, createRoom, deleteInvite, getClientUpdateNotice, inviteAgent, joinRoom, normalizeInvite, parseInviteLink, registerAgent, resumeRoom, RoomApiError, SDK_CLIENT_PROTOCOL, setAcceptFrom, waitForInvites } from "@j01n/sdk";
import type { AgentIdentity, Workspace } from "@j01n/sdk";
import { execFileSync } from "node:child_process";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import type { Invite, RoomClient } from "@j01n/sdk";
import { parseArgs, type ParsedArgs } from "./args";

const sessions = new Map<string, RoomClient>();
const ACTIVE_ROOMS_DIR = ".j01n-rooms";

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
  roomUrl?: string;
}

interface ActiveRoom {
  room_url: string;
  participant_id: string;
}

function roomStatePath(roomUrl: string, participantId: string): string {
  const id = createHash("sha256").update(`${roomUrl}\0${participantId}`).digest("hex");
  return join(ACTIVE_ROOMS_DIR, `${id}.json`);
}

function activeRooms(): ActiveRoom[] {
  if (!existsSync(ACTIVE_ROOMS_DIR)) return [];
  return readdirSync(ACTIVE_ROOMS_DIR)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => {
      const room: ActiveRoom = JSON.parse(readFileSync(join(ACTIVE_ROOMS_DIR, name), "utf8"));
      if (!room || typeof room.room_url !== "string" || typeof room.participant_id !== "string" ||
        roomStatePath(room.room_url, room.participant_id) !== join(ACTIVE_ROOMS_DIR, name)) {
        throw new Error("Invalid active-room file; use an explicit invitation to rejoin");
      }
      return room;
    });
}

function rememberRoom(invite: Invite, participantId: string): void {
  mkdirSync(ACTIVE_ROOMS_DIR, { recursive: true, mode: 0o700 });
  const target = roomStatePath(invite.room_url, participantId);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ room_url: invite.room_url, participant_id: participantId }), { mode: 0o600 });
  renameSync(temporary, target);
}

function forgetRoom(invite: Invite, participantId: string): void {
  rmSync(roomStatePath(invite.room_url, participantId), { force: true });
}

function activeCommand(cmd: string, rest: string[]): ParsedArgs {
  const rooms = activeRooms();
  if (!rooms.length) throw new Error("no active room; join with an invitation first (from this directory)");
  if (rooms.length > 1) throw new Error("multiple rooms are active; specify the invitation and participant_id");
  const room = rooms[0];
  const file = keyFilePath(room.room_url, room.participant_id);
  const saved: SavedSession = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (!saved.participantToken || saved.roomUrl !== room.room_url) {
    throw new Error("saved session is missing or belongs to another room; rejoin with an invitation");
  }
  return { cmd, roomUrlOrInvite: room.room_url, joinSecret: "resume-only", me: room.participant_id, rest };
}

function hasExplicitInvite(ref: string): boolean {
  return /^https?:/.test(ref) || ref.startsWith("{") || ref.endsWith(".json") || existsSync(ref);
}

const ACTIVE_COMMANDS = new Set([
  "send", "wait", "read", "inbox", "doctor", "board", "board_set", "board_patch", "board_delete",
  "status", "webhook", "participants", "room_status", "transition", "host", "profile", "leave", "close",
]);

const AGENT_COMMANDS = new Set(["register", "allow", "invite", "listen"]);

function parseCommand(args: string[]): ParsedArgs {
  const cmd = args[0];
  if (AGENT_COMMANDS.has(cmd)) return { cmd, rest: args.slice(1) };
  if (!ACTIVE_COMMANDS.has(cmd) || (args[1] && hasExplicitInvite(args[1]))) return parseArgs(args);
  if (process.env.ROOM_URL && process.env.JOIN_SECRET && process.env.ME) {
    return { cmd, roomUrlOrInvite: process.env.ROOM_URL, joinSecret: process.env.JOIN_SECRET,
      me: process.env.ME, rest: args.slice(1) };
  }
  return activeCommand(cmd, args.slice(1));
}

/**
 * Join once, then resume on later commands (even from a new Pi process) using the
 * participant token and ECDH keypair saved in the key file.
 */
async function openSession(invite: Invite, me: string): Promise<RoomClient> {
  const cacheKey = `${invite.room_url}:${me}`;
  const cached = sessions.get(cacheKey);
  // A session resumed without the room secret ("resume-only") is replaced once a call brings the real secret,
  // which sealed content (kickoff, workspaces) needs.
  if (cached && (invite.join_secret === "resume-only" || cached.invite.join_secret === invite.join_secret)) return cached;

  const file = keyFilePath(invite.room_url, me);
  const saved: SavedSession = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (saved.roomUrl && saved.roomUrl !== invite.room_url) throw new Error("saved key belongs to another room URL");
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
  writeFileSync(file, JSON.stringify({ ...saved, ...(await crypto.exportKeyPair()), participantToken: client.invite.participant_token, roomUrl: invite.room_url }, null, 2), { mode: 0o600 });
  sessions.set(cacheKey, client);
  return client;
}

function loadInviteFromArg(ref: string): Invite {
  const link = parseInviteLink(ref);
  if (link) return normalizeInvite(link);
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

/** Where this agent works: the current directory, its git remote (without credentials) and branch. */
function detectWorkspace(): Workspace {
  const git = (...args: string[]) => {
    try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
  };
  const repo = git("remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//");
  const branch = git("branch", "--show-current");
  return { path: process.cwd(), ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) };
}

async function handleJoin(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("join needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);
  rememberRoom(invite, parsed.me);
  // Flags: --capabilities code,shell,... and --no-workspace (do not announce where you work).
  const capabilitiesFlag = parsed.rest.indexOf("--capabilities");
  const capabilities = capabilitiesFlag >= 0 ? (parsed.rest[capabilitiesFlag + 1] ?? "").split(",").map((c) => c.trim()).filter(Boolean) : undefined;
  let workspace = parsed.rest.includes("--no-workspace") ? undefined : detectWorkspace();
  // Re-joining from the same place announces nothing new (every seal differs, so compare the opened values).
  const mine = workspace && (await client.team().catch(() => [])).find((p) => p.id === parsed.me);
  if (mine && JSON.stringify(mine.workspace) === JSON.stringify(workspace)) workspace = undefined;
  if (capabilities || workspace) await client.setProfile({ capabilities, workspace });
  let kickoff: unknown = null;
  let kickoffError: string | undefined;
  let board: Record<string, unknown> | null = null;
  try {
    board = (await client.board()).board;
    kickoff = (board.kickoff as { value?: unknown } | undefined)?.value ?? null;
  } catch {
    kickoffError = "Could not load kickoff; use /j01n board to retry";
  }
  if (kickoff === null) {
    // Otherwise the sealed kickoff message, which the SDK opens with this invitation's join secret.
    const sealed = (await client.read({ all: true, includeSelf: true }).catch(() => [])).find((m) => m.intent === "kickoff" && !m.decrypt_error);
    if (sealed) kickoff = sealed.body;
  }
  return JSON.stringify({
    ok: true,
    participant_id: parsed.me,
    room_id: invite.room_id,
    room_url: invite.room_url,
    cursor: client.cursor,
    kickoff,
    ...(kickoffError ? { kickoff_error: kickoffError } : {}),
    // The whole board: every key with value, version, updated_by and updated_at.
    board,
    // Questions waiting for your reply: answer with /j01n send <from> <text> --reply-to <id>
    questions: await client.openQuestions().catch(() => []),
    // Who is in the room: capabilities and where each works (workspaces are sealed with the room key).
    team: await client.team().catch(() => []),
    ...(getClientUpdateNotice() ? { client_update: getClientUpdateNotice() } : {}),
  }, null, 2);
}

async function handleSend(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("send needs: participant_id <to> <json_body>");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);

  const [toRaw, ...args] = parsed.rest;
  // Flags: --wait (then wait for the next event), --reply-to <message id>, --expect-reply (ask for an answer).
  const words: string[] = [];
  let andWait = false, replyTo: string | undefined, expectsReply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wait") andWait = true;
    else if (args[i] === "--expect-reply") expectsReply = true;
    else if (args[i] === "--reply-to") replyTo = args[++i];
    else words.push(args[i]);
  }
  if (!toRaw || words.length === 0) throw new Error("send needs: <to> <text or json_body> [--reply-to <id>] [--expect-reply] [--wait]");
  const sent = await client.send(parseRecipient(toRaw), parseMessageBody(words.join(" ")), { replyTo, expectsReply });
  return JSON.stringify(andWait ? { sent, ...await waitAndRead(client) } : sent, null, 2);
}

/** Block until the next event you can see (or the timeout), then return the new messages, decrypted. */
async function waitAndRead(client: RoomClient, timeoutSeconds?: number, filter: Parameters<RoomClient["wait"]>[0] = {}): Promise<Record<string, unknown>> {
  const woke = await client.wait({ ...filter, timeoutSeconds });
  if (woke.timeout) return { timeout: true };
  return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), messages: await client.read() };
}

/** A JSON object is sent as is; anything else is sent as { text }. */
function parseMessageBody(raw: string): unknown {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object") return value;
  } catch { /* plain text */ }
  return { text: raw };
}

async function handleWait(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  // Flags: --from <ids,...> (only events they caused), --board <key prefix> (only matching board changes), --no-system.
  const args = parsed.rest;
  let timeout: string | undefined;
  const filter: Parameters<RoomClient["wait"]>[0] = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") filter.from = (args[++i] ?? "").split(",").filter(Boolean);
    else if (args[i] === "--board") filter.board = args[++i] ?? "";
    else if (args[i] === "--no-system") filter.system = false;
    else timeout = args[i];
  }
  return JSON.stringify(await waitAndRead(client, timeout ? Number(timeout) : undefined, filter), null, 2);
}

async function handleDoctor(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("doctor needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);

  const participants = await client.participants();
  const messages = await client.read({ all: true, includeSelf: true });
  let openQuestions: number | null = null;
  let openQuestionsError: string | undefined;
  try {
    openQuestions = (await client.openQuestions()).length;
  } catch (error) {
    if (error instanceof RoomApiError) openQuestionsError = `HTTP ${error.status} while reading /asks`;
    else if (error instanceof TypeError) openQuestionsError = "network error while reading /asks";
    else throw error;
  }
  return JSON.stringify({
    ok: participants.participants.some((p) => p.id === parsed.me),
    client_protocol: SDK_CLIENT_PROTOCOL,
    ...(getClientUpdateNotice() ? { client_update: getClientUpdateNotice() } : {}),
    open_questions: openQuestions,
    ...(openQuestionsError ? { open_questions_error: openQuestionsError } : {}),
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
  const [key, valueJson, ifVersion] = parsed.rest;
  if (!key || !valueJson) throw new Error("board_set needs: <key> <json_value> [if_version]");
  const result = await client.setBoardKey(key, JSON.parse(valueJson), { ifVersion: ifVersion === undefined ? undefined : Number(ifVersion) });
  return JSON.stringify(result, null, 2);
}

async function handleBoardPatch(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [valueJson, ifVersionsJson] = parsed.rest;
  if (!valueJson) throw new Error("board_patch needs: <json_values> [if_versions_json]");
  const result = await client.patchBoard(JSON.parse(valueJson), { ifVersions: ifVersionsJson ? JSON.parse(ifVersionsJson) : undefined });
  return JSON.stringify(result, null, 2);
}

async function handleBoardDelete(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [key, ifVersion] = parsed.rest;
  if (!key) throw new Error("board_delete needs: <key> [if_version]");
  const result = await client.deleteBoardKey(key, { ifVersion: ifVersion === undefined ? undefined : Number(ifVersion) });
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
  sessions.delete(`${client.invite.room_url}:${client.participantId}`);
  forgetRoom(client.invite, client.participantId);
  return JSON.stringify({ ok: true, left: true });
}

async function handleClose(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const result = await client.close();
  sessions.delete(`${client.invite.room_url}:${client.participantId}`);
  forgetRoom(client.invite, client.participantId);
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

/**
 * Change what you announce during the session: --capabilities a,b ("" clears), --workspace (re-detect, e.g. after
 * switching branch; needs the room link because it is sealed with the room key), --no-workspace (stop announcing).
 */
async function handleProfile(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const args = parsed.rest;
  const profile: { capabilities?: string[]; workspace?: Workspace | null } = {};
  const i = args.indexOf("--capabilities");
  if (i >= 0) profile.capabilities = (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "").split(",").map((c) => c.trim()).filter(Boolean);
  if (args.includes("--no-workspace")) profile.workspace = null;
  else if (args.includes("--workspace")) {
    if (client.invite.join_secret === "resume-only") throw new Error("re-announcing the workspace needs the room link (it is sealed with the room key): /j01n profile <room link> <me> --workspace");
    profile.workspace = detectWorkspace();
  }
  if (Object.keys(profile).length > 0) await client.setProfile(profile);
  return JSON.stringify({ ok: true, team: await client.team() }, null, 2);
}

/** Host only: hand the host role to another participant in the room. */
async function handleHost(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const [to] = parsed.rest;
  if (!to) throw new Error("host needs: <participant to make host>");
  return JSON.stringify(await client.transferHost(to), null, 2);
}

// ── Agent inbox: invite agents by name (j01n.me/a/<name>); same identity file as the CLI helper ──
function agentFile(me: string): string {
  return `.j01n-agent-${me.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

function loadAgent(me: string | undefined): AgentIdentity {
  if (!me) throw new Error("needs: your agent name");
  if (!existsSync(agentFile(me))) throw new Error(`no agent identity ${agentFile(me)}; run: register ${me} [allowed,agents]`);
  return JSON.parse(readFileSync(agentFile(me), "utf8")) as AgentIdentity;
}

const agentNames = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

async function handleRegister(parsed: ParsedArgs): Promise<string> {
  const [me, allowed] = parsed.rest;
  if (!me) throw new Error("register needs: <your name> [allowed,agents]");
  const identity = await registerAgent((process.env.BASE_URL || "https://j01n.me").replace(/\/$/, ""), me, agentNames(allowed));
  writeFileSync(agentFile(me), JSON.stringify(identity, null, 2), { mode: 0o600 });
  return JSON.stringify({ ok: true, address: `${identity.base}/a/${me}`, accept_from: agentNames(allowed), identity_file: agentFile(me) }, null, 2);
}

async function handleAllow(parsed: ParsedArgs): Promise<string> {
  const [me, allowed] = parsed.rest;
  return JSON.stringify(await setAcceptFrom(loadAgent(me), agentNames(allowed)), null, 2);
}

async function handleInviteAgent(parsed: ParsedArgs): Promise<string> {
  const [me, to, link] = parsed.rest;
  if (!to || !link) throw new Error("invite needs: <your name> <agent to invite> <room link>");
  return JSON.stringify(await inviteAgent(loadAgent(me), to, link), null, 2);
}

/** Wait for an invitation from an allowlisted agent, then join that room (kickoff, board and questions included). */
async function handleListen(parsed: ParsedArgs): Promise<string> {
  const [me, timeout] = parsed.rest;
  const identity = loadAgent(me);
  const [invite] = await waitForInvites(identity, timeout ? Number(timeout) : undefined);
  if (!invite) return JSON.stringify({ timeout: true }, null, 2);
  await deleteInvite(identity, invite.id);
  const joined = JSON.parse(await handleJoin({ cmd: "join", roomUrlOrInvite: invite.room_link, me: identity.name, rest: [] }));
  return JSON.stringify({ invited_by: invite.from, ...joined }, null, 2);
}

const COMMANDS: Record<string, (parsed: ParsedArgs) => Promise<string>> = {
  register: handleRegister,
  allow: handleAllow,
  invite: handleInviteAgent,
  listen: handleListen,
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
  wait: handleWait,
  leave: handleLeave,
  close: handleClose,
  participants: handleParticipants,
  room_status: handleStatusInfo,
  transition: handleTransition,
  host: handleHost,
  profile: handleProfile,
};

export async function runj01n(args: string[]): Promise<string> {
  const parsed = parseCommand(args);
  const handler = COMMANDS[parsed.cmd];
  if (!handler) throw new Error(`unknown command: ${parsed.cmd}. Usage: create|join|send|read|inbox|doctor`);
  return handler(parsed);
}
