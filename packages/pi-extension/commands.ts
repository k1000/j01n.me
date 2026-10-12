import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { buildMinimalInvite, buildRoomClient, createRoom, deleteInvite, getClientUpdateNotice, inviteAgent, inviteLink, joinRoom, normalizeInvite, parseInviteLink, parseSprintSpec, registerAgent, resumeRoom, RoomApiError, SDK_CLIENT_PROTOCOL, sealForRoom, setAcceptFrom, waitForInvites } from "@j01n/sdk";
import type { AgentIdentity, Workspace } from "@j01n/sdk";
import { execFileSync } from "node:child_process";
import { createSdkCryptoSession, type SdkCryptoSession } from "@j01n/sdk/crypto-session";
import { roomReplyHint, roomReplyHints, runProfileCommand, runReservationCommand, runRoomCommand } from "@j01n/sdk/room-commands";
import { notesAndDecisions } from "@j01n/sdk/notes";
import { request } from "@j01n/sdk/transport";
import { detectWorkspace, localStateDir } from "@j01n/sdk/node";
import { checkConflicts } from "@j01n/sdk/conflicts-node";
import type { Invite, RoomClient } from "@j01n/sdk";
import { parseArgs, type ParsedArgs } from "./args";
import { reportSessionUsage, startUsageTimer, stopAllUsageTimers, stopUsageTimer } from "./usage";
import { listHerdrPeers, notifyHerdrPeer } from "./herdr";
import { assertSafePeerPromptText, removeMergedPeerWorktrees, requirePrivateIdentityDir } from "./spawn-herdr";
import { getExtensionDiagnostics } from "./version";

const sessions = new Map<string, RoomClient>();
const processRoomIdentities = new Map<string, string>();
export const processRoomParticipant = (roomUrl: string): string | undefined => processRoomIdentities.get(roomUrl);
/** Key files and identities: this directory, or a private folder on the internal disk when it is on /Volumes. */
const activeRoomsDir = () => join(localStateDir(), ".j01n-rooms");

async function getClient(parsed: ParsedArgs): Promise<RoomClient> {
  if (!parsed.me) throw new Error("needs: participant_id. Use join first to create a session.");
  return openSession(resolveInvite(parsed), parsed.me);
}

/** Same key file name and format as the tiny CLI helper, so both share one identity per room. */
function keyFilePath(roomUrl: string, me: string): string {
  return join(localStateDir(), ".j01n-" + new URL(roomUrl).pathname.replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + me.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}

interface SavedSession {
  privateJwk?: JsonWebKey;
  publicJwk?: JsonWebKey;
  peers?: Record<string, string>;
  participantToken?: string;
  /** Saved at join (private key file) so short commands can open sealed content (kickoff, workspaces, reservations). */
  joinSecret?: string;
  roomUrl?: string;
}

interface ActiveRoom {
  room_url: string;
  participant_id: string;
}

function roomStatePath(roomUrl: string, participantId: string): string {
  const id = createHash("sha256").update(`${roomUrl}\0${participantId}`).digest("hex");
  return join(activeRoomsDir(), `${id}.json`);
}

function activeRooms(): ActiveRoom[] {
  const dir = activeRoomsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => {
      const room: ActiveRoom = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!room || typeof room.room_url !== "string" || typeof room.participant_id !== "string" ||
        roomStatePath(room.room_url, room.participant_id) !== join(dir, name)) {
        throw new Error("Invalid active-room file; use an explicit invitation to rejoin");
      }
      return room;
    });
}

function rememberRoom(invite: Invite, participantId: string): void {
  mkdirSync(activeRoomsDir(), { recursive: true, mode: 0o700 });
  const target = roomStatePath(invite.room_url, participantId);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ room_url: invite.room_url, participant_id: participantId }), { mode: 0o600 });
  renameSync(temporary, target);
  processRoomIdentities.set(invite.room_url, participantId);
}

function forgetRoom(invite: Invite, participantId: string): void {
  rmSync(roomStatePath(invite.room_url, participantId), { force: true });
  if (processRoomIdentities.get(invite.room_url) === participantId) processRoomIdentities.delete(invite.room_url);
}

async function activeCommand(cmd: string, rest: string[]): Promise<ParsedArgs> {
  const savedRooms = activeRooms();
  // Only disambiguation needs a remote check. A stale local marker is not proof that a room still exists.
  const checked = savedRooms.length > 1 ? await Promise.all(savedRooms.map(async (room) => {
    const file = keyFilePath(room.room_url, room.participant_id);
    const saved: SavedSession = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    if (!saved.participantToken || saved.roomUrl !== room.room_url) return room; // unknown, not safely discardable
    try {
      const invite = { ...buildMinimalInvite(room.room_url, "resume-only"), participant_token: saved.participantToken };
      const status = await request<{ closed?: boolean; expires_at?: string }>(`${room.room_url}/status`, invite, { participantId: room.participant_id });
      return status.closed || (status.expires_at && Date.parse(status.expires_at) <= Date.now()) ? null : room;
    } catch (error) {
      return error instanceof RoomApiError && (error.status === 404 || error.status === 410) ? null : room;
    }
  })) : savedRooms;
  const rooms = checked.filter((room): room is ActiveRoom => room !== null);
  if (!rooms.length) throw new Error("no active room; saved rooms are closed or expired. Join with a new invitation.");
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
  return /^https?:/.test(ref) || ref.startsWith("{") || isRoomFile(ref);
}

/** A file names a room only if it holds an invitation or participant profile, not just because it exists (reserve src/x.ts). */
function isRoomFile(ref: string): boolean {
  try {
    const value = JSON.parse(readFileSync(ref, "utf8")) as Record<string, unknown>;
    return !!value && typeof value === "object" && ["access", "room_url", "join_secret", "participant_token"].some((key) => key in value);
  } catch {
    return false;
  }
}

const ACTIVE_COMMANDS = new Set([
  "send", "wait", "read", "inbox", "doctor", "board", "board_set", "board_patch", "board_delete",
  "status", "webhook", "participants", "room_status", "transition", "host", "profile", "reserve", "release", "reservations", "tasks", "claim", "done", "conflicts", "block", "unblock", "summary", "note", "decide", "invite-link", "leave", "close",
]);

const AGENT_COMMANDS = new Set(["register", "allow", "invite", "listen", "herdr_agents", "invite_herdr", "worktrees", "use"]);

async function parseCommand(args: string[]): Promise<ParsedArgs> {
  const cmd = args[0];
  if (AGENT_COMMANDS.has(cmd)) return { cmd, rest: args.slice(1) };
  if (ACTIVE_COMMANDS.has(cmd) && args[1] && /^\.j01n-.*\.json$/.test(basename(args[1]))) {
    throw new Error("a saved .j01n-...json key file is not an invitation; pass a room link and participant_id instead");
  }
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
async function openSession(invite: Invite, me: string, created?: { client: RoomClient; crypto: SdkCryptoSession }): Promise<RoomClient> {
  const cacheKey = `${invite.room_url}:${me}`;
  const cached = sessions.get(cacheKey);
  // A session resumed without the room secret ("resume-only") is replaced once a call brings the real secret,
  // which sealed content (kickoff, workspaces) needs.
  if (cached && (invite.join_secret === "resume-only" || cached.invite.join_secret === invite.join_secret)) return cached;

  const file = keyFilePath(invite.room_url, me);
  const saved: SavedSession = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (saved.roomUrl && saved.roomUrl !== invite.room_url) throw new Error("saved key belongs to another room URL");
  if (invite.join_secret === "resume-only" && saved.joinSecret) invite = { ...invite, join_secret: saved.joinSecret };
  const crypto = created?.crypto ?? await createSdkCryptoSession(me, saved.privateJwk, saved.publicJwk);
  const token = invite.participant_token ?? saved.participantToken;

  let client: RoomClient;
  if (created) client = created.client;
  else if (token) {
    client = await resumeRoom({ ...invite, participant_token: token }, me, crypto);
  } else {
    try {
      client = await joinRoom(invite, me, { harness: "pi" }, crypto);
    } catch (err) {
      if (err instanceof RoomApiError && err.status === 409) {
        throw new Error(`${me} already joined this room but no participant token was found in ${file}. Run from the directory where you joined, or pass a participant profile containing participant_token.`);
      }
      throw err;
    }
  }
  const joinSecret = invite.join_secret !== "resume-only" ? invite.join_secret : saved.joinSecret;
  writeFileSync(file, JSON.stringify({ ...saved, ...(await crypto.exportKeyPair()), participantToken: client.invite.participant_token, ...(joinSecret ? { joinSecret } : {}), roomUrl: invite.room_url }, null, 2), { mode: 0o600 });
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
  const joinHost = parsed.rest[1] === "--join";
  if (parsed.rest.length > (joinHost ? 2 : 1)) throw new Error("create needs: <options-json> [--join]");
  const options = parsed.rest[0] ? JSON.parse(parsed.rest[0]) : {};
  if (joinHost && (typeof options.host_id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(options.host_id))) throw new Error("create --join needs a valid host_id");
  let specText: string | undefined;
  if (options.spec !== undefined) {
    if (typeof options.spec !== "string" || !options.spec) throw new Error("create spec needs a Markdown file path");
    if (typeof options.host_id !== "string" || !options.host_id) throw new Error("create spec needs host_id (the host joins to post the sealed spec)");
    if (options.tasks !== undefined || (options.template !== undefined && options.template !== "sprint")) throw new Error("create spec cannot override tasks or sprint template");
    specText = readFileSync(options.spec, "utf8");
  }
  const crypto = joinHost ? await createSdkCryptoSession(options.host_id) : undefined;
  const invite = await createRoom(createBaseUrl(parsed), {
    hostId: options.host_id,
    ...(crypto ? { hostPublicKey: (await crypto.announceKeyBody()).public_key } : {}),
    roomName: options.room_name,
    maxParticipants: options.max_participants,
    inviteTtlMs: options.invite_ttl_ms,
    purpose: options.purpose,
    board: parseOptionalObject(options.board),
    boardSchema: parseOptionalObject(options.board_schema),
    template: specText !== undefined ? "sprint" : options.template,
    tasks: specText !== undefined ? parseSprintSpec(specText) : options.tasks,
  });
  if (crypto) {
    if (!invite.host_joined || typeof invite.cursor !== "number" || !invite.participant_token) throw new Error("room service did not auto-join the host; private invitation withheld (room will expire)");
    const client = await buildRoomClient(invite, options.host_id, invite.cursor, crypto);
    try {
      await openSession(invite, options.host_id, { client, crypto });
      rememberRoom(invite, options.host_id);
    } catch {
      await client.close().catch(() => undefined);
      sessions.delete(`${invite.room_url}:${options.host_id}`);
      forgetRoom(invite, options.host_id);
      rmSync(keyFilePath(invite.room_url, options.host_id), { force: true });
      throw new Error("could not save the host identity; room closed or will expire");
    }
    if (specText !== undefined) await client.send("all", { encrypted_payload: await sealForRoom(specText, invite.join_secret, invite.room_id) }, { intent: "kickoff", plain: true });
    return JSON.stringify({ room_id: invite.room_id, participant_id: options.host_id, host_joined: true }, null, 2);
  }
  if (specText !== undefined) {
    // Legacy create with spec joins the host but keeps the invitation output for existing callers.
    const host = options.host_id;
    const client = await openSession(invite, host);
    rememberRoom(invite, host);
    await client.send("all", { encrypted_payload: await sealForRoom(specText, invite.join_secret, invite.room_id) }, { intent: "kickoff", plain: true });
  }
  return JSON.stringify(invite, null, 2);
}

function createBaseUrl(parsed: ParsedArgs): string {
  return (parsed.roomUrlOrInvite || process.env.BASE_URL || "https://j01n.me").replace(/\/$/, "");
}

/** Where this agent works: the current directory, its git remote (without credentials) and branch. */
function git(...args: string[]): string | undefined {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
}

/** The repo this directory belongs to: its root, and its identity (remote without credentials, else the root). */
export function currentRepo(): { root: string; repo: string } {
  const root = git("rev-parse", "--show-toplevel") ?? process.cwd();
  return { root, repo: git("remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//") ?? root };
}

/** A path as stored in reservations: relative to the repo root. */
export function repoPath(root: string, path: string): string {
  return relative(root, resolve(path)) || ".";
}

async function handleReservation(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  const { root, repo } = currentRepo();
  return JSON.stringify(await runReservationCommand(client, parsed.cmd as "reserve" | "release" | "reservations", parsed.rest, {
    repo, path: (path) => repoPath(root, path),
  }), null, 2);
}

async function handleJoin(parsed: ParsedArgs): Promise<string> {
  if (!parsed.me) throw new Error("join needs: participant_id");
  const invite = resolveInvite(parsed);
  const client = await openSession(invite, parsed.me);
  rememberRoom(invite, parsed.me);
  // Flags: --capabilities code,shell,..., --model gpt-5 --provider openai, and --no-workspace (do not announce where you work).
  const capabilitiesFlag = parsed.rest.indexOf("--capabilities");
  const capabilities = capabilitiesFlag >= 0 ? (parsed.rest[capabilitiesFlag + 1] ?? "").split(",").map((c) => c.trim()).filter(Boolean) : undefined;
  // An agent says which model it runs: explicit flag, then J01N_MODEL/J01N_PROVIDER, then the harness env.
  const flag = (name: string) => {
    const i = parsed.rest.indexOf(name);
    return i >= 0 && parsed.rest[i + 1] && !parsed.rest[i + 1].startsWith("--") ? parsed.rest[i + 1] : undefined;
  };
  const model = flag("--model") || process.env.J01N_MODEL || (process.env.J01N_PEER_ROLE ? undefined : process.env.PI_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL);
  const provider = flag("--provider") || process.env.J01N_PROVIDER || (process.env.J01N_PEER_ROLE ? undefined : process.env.PI_PROVIDER);
  const skills = flag("--skills")?.split(",").filter(Boolean);
  const detected = parsed.rest.includes("--no-workspace") ? undefined : detectWorkspace(client.invite.join_secret, client.invite.room_id);
  let workspace = detected?.workspace;
  // Re-joining from the same place announces nothing new (every seal differs, so compare the opened values).
  const teamList = await client.team().catch(() => []);
  const mine = teamList.find((p) => p.id === parsed.me);
  if (mine && JSON.stringify(mine.workspace) === JSON.stringify(workspace)) workspace = undefined;
  const display_name = flag("--display-name");
  const role = flag("--role");
  const profile: { capabilities?: string[]; skills?: string[]; workspace?: Workspace; checkout?: string; model?: string; provider?: string; harness?: string; display_name?: string; role?: string } = { capabilities, skills, workspace, display_name, role };
  if (mine?.harness !== "pi") profile.harness = "pi";
  if (detected?.checkout !== mine?.checkout) profile.checkout = detected?.checkout;
  if (model && mine?.model !== model) profile.model = model;
  if (provider && mine?.provider !== provider) profile.provider = provider;
  if (capabilities || skills || workspace || profile.checkout || profile.model || profile.provider || profile.harness || display_name || role) await client.setProfile(profile);
  let kickoff: unknown = null;
  let kickoffError: string | undefined;
  let board: Awaited<ReturnType<RoomClient["board"]>>["board"] | null = null;
  try {
    board = (await client.board()).board;
    kickoff = (board.kickoff as { value?: unknown } | undefined)?.value ?? null;
  } catch {
    kickoffError = "Could not load kickoff; use /j01n board to retry";
  }
  // Sprint rules stay in the board kickoff; expose the sealed Markdown spec separately on join.
  const sealedKickoff = (await client.read({ all: true, includeSelf: true }).catch(() => []))
    .find((m) => m.intent === "kickoff" && !m.decrypt_error)?.body;
  if (kickoff === null) kickoff = sealedKickoff ?? null;
  const extension = getExtensionDiagnostics();
  return JSON.stringify({
    ok: true,
    participant_id: parsed.me,
    room_id: invite.room_id,
    room_url: invite.room_url,
    cursor: client.cursor,
    kickoff,
    ...(typeof sealedKickoff === "string" ? { spec: sealedKickoff } : {}),
    ...(kickoffError ? { kickoff_error: kickoffError } : {}),
    // The whole board: every key with value, version, updated_by and updated_at.
    board,
    ...notesAndDecisions(board ?? {}),
    // Questions waiting for your reply: answer with /j01n send <from> <text> --reply-to <id>
    questions: await client.openQuestions().catch(() => []),
    // Who is in the room: capabilities and where each works (workspaces are sealed with the room key).
    team: await client.team().catch(() => []),
    ...(getClientUpdateNotice() ? { client_update: getClientUpdateNotice() } : {}),
    ...(extension.warnings.length ? { extension_warning: extension.warnings } : {}),
  }, null, 2);
}

async function handleInviteLink(parsed: ParsedArgs): Promise<string> {
  if (parsed.rest.length && (parsed.rest.length !== 1 || parsed.rest[0] !== "--open")) throw new Error("invite-link needs: [--open]");
  const client = await getClient(parsed);
  if ((await client.status()).room.host_id !== parsed.me) throw new Error("invite-link is host only");
  const saved: SavedSession = JSON.parse(readFileSync(keyFilePath(client.invite.room_url, client.participantId), "utf8"));
  if (!saved.joinSecret || saved.joinSecret === "resume-only") throw new Error("room link unavailable in local key file; rejoin with the invitation");
  const link = inviteLink(client.invite.room_url, saved.joinSecret);
  if (parsed.rest.includes("--open")) execFileSync("open", [link], { stdio: "ignore" });
  return JSON.stringify({ invite_link: link, ...(parsed.rest.includes("--open") ? { opened: true } : {}) }, null, 2);
}

async function sharedCommand(parsed: ParsedArgs): Promise<string> {
  if (parsed.cmd === "send" && !parsed.me) throw new Error("send needs: participant_id <to> <json_body>");
  if ((parsed.cmd === "read" || parsed.cmd === "inbox") && !parsed.me) throw new Error("read needs: participant_id");
  const client = await getClient(parsed);
  return JSON.stringify(await runRoomCommand(client, parsed.cmd, parsed.rest, {
    recipientList: true, repo: currentRepo().repo,
    conflicts: (branch) => checkConflicts(client, currentRepo().root, branch),
  }), null, 2);
}

/** A ready command to answer a message in its thread (closes it if it asked for a reply). */
export function replyHint(message: { id: string; from: string }): string {
  return roomReplyHint(message);
}

export function withReplyHints<T extends { id: string; from: string; intent?: string }>(messages: T[]): Array<T & { reply?: string }> {
  return roomReplyHints(messages);
}

/** Clients for every room joined from this directory (live delivery, presence and reservation checks use them). */
export async function activeRoomClients(): Promise<RoomClient[]> {
  const clients: RoomClient[] = [];
  for (const room of activeRooms()) {
    try {
      clients.push(await openSession(buildMinimalInvite(room.room_url, "resume-only"), room.participant_id));
    } catch { /* a room that cannot be resumed (left, expired) is skipped */ }
  }
  return clients;
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
    extension: getExtensionDiagnostics(),
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

function knownPeers(messages: Awaited<ReturnType<RoomClient["read"]>>, me: string): string[] {
  return messages.filter((m) => m.intent === "key.exchange" && m.from !== me).map((m) => m.from);
}

function isUndecrypted(message: Awaited<ReturnType<RoomClient["read"]>>[number]): boolean {
  const body = message.body as Record<string, unknown> | null;
  return body !== null && typeof body === "object" && body.encrypted === true;
}

async function handleLeave(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  stopUsageTimer(client);
  // --release: also release your file reservations (leaving while holding some is refused).
  await client.leave({ release: parsed.rest.includes("--release") });
  sessions.delete(`${client.invite.room_url}:${client.participantId}`);
  forgetRoom(client.invite, client.participantId);
  if (!activeRooms().length) stopAllUsageTimers();
  return JSON.stringify({ ok: true, left: true });
}

async function handleClose(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  stopUsageTimer(client);
  const result = await client.close();
  sessions.delete(`${client.invite.room_url}:${client.participantId}`);
  forgetRoom(client.invite, client.participantId);
  if (!activeRooms().length) stopAllUsageTimers();
  return JSON.stringify(result, null, 2);
}

async function handleProfile(parsed: ParsedArgs): Promise<string> {
  const client = await getClient(parsed);
  return JSON.stringify(await runProfileCommand(client, parsed.rest, {
    modelFallback: process.env.J01N_MODEL || process.env.PI_MODEL,
    providerFallback: process.env.J01N_PROVIDER,
    workspace: () => detectWorkspace(client.invite.join_secret, client.invite.room_id).workspace,
    checkout: () => detectWorkspace(client.invite.join_secret, client.invite.room_id).checkout,
    secret: client.invite.join_secret,
    workspaceError: "re-announcing the workspace needs the room link (it is sealed with the room key): /j01n profile <room link> <me> --workspace",
  }), null, 2);
}

// ── Agent inbox: invite agents by name (j01n.me/a/<name>); same identity file as the CLI helper ──
function agentFile(me: string): string {
  return join(process.env.J01N_AGENT_DIR || localStateDir(), `.j01n-agent-${me.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
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
  if (process.env.J01N_AGENT_DIR) mkdirSync(process.env.J01N_AGENT_DIR, { recursive: true, mode: 0o700 });
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

async function handleHerdrAgents(): Promise<string> {
  return JSON.stringify({ agents: listHerdrPeers() }, null, 2);
}

function handleUse(parsed: ParsedArgs): string {
  const [roomId, participantId] = parsed.rest;
  if (parsed.rest.length !== 2 || !roomId || !participantId) throw new Error("use needs: <room_id> <participant_id>");
  if (process.env.J01N_PEER_PARTICIPANT_ID && (process.env.J01N_PEER_PARTICIPANT_ID !== participantId || process.env.J01N_PEER_ROOM_ID !== roomId)) throw new Error("a spawned peer cannot select another room identity");
  const room = activeRooms().find((entry) => entry.room_url.split("/").pop() === roomId && entry.participant_id === participantId);
  if (!room) throw new Error("room identity is not joined from this directory");
  const saved: SavedSession = JSON.parse(readFileSync(keyFilePath(room.room_url, participantId), "utf8"));
  if (!saved.participantToken || saved.roomUrl !== room.room_url) throw new Error("saved room identity is unavailable; join again");
  processRoomIdentities.set(room.room_url, participantId);
  return JSON.stringify({ room_id: roomId, participant_id: participantId, selected: true }, null, 2);
}

async function handleInviteHerdr(parsed: ParsedArgs): Promise<string> {
  const [me, link, ...targets] = parsed.rest;
  if (!me || !link || !targets.length) throw new Error("invite_herdr needs: <your registered name> <room link> <pane-id=registered-name> [...]");
  if (!parseInviteLink(link)) throw new Error("invite_herdr requires a room link with its join secret");
  const current = new Map(listHerdrPeers().map((peer) => [peer.pane_id, peer]));
  const selected = new Set<string>();
  const addresses = new Set<string>();
  const mappings = targets.map((target) => {
    const match = /^([^=]+)=([a-zA-Z0-9_-]+)$/.exec(target);
    if (!match) throw new Error("invalid Herdr recipient; use pane-id=registered-name");
    const [, paneId, address] = match;
    if (!current.has(paneId)) throw new Error("recipient pane is not another agent in this Herdr workspace");
    if (selected.has(paneId) || addresses.has(address) || address === me) throw new Error("duplicate or self recipient");
    selected.add(paneId);
    addresses.add(address);
    return { paneId, address };
  });
  const identity = loadAgent(me);
  const invited = [];
  for (const { paneId, address } of mappings) {
    try {
      await inviteAgent(identity, address, link);
      let notified = false;
      if (["idle", "done"].includes(current.get(paneId)?.agent_status ?? "")) {
        try {
          notifyHerdrPeer(paneId, `A sealed j01n.me invitation from ${me} is waiting for ${address}. If you want to join, run your j01n.me listen command for ${address} (Pi: /j01n listen ${address}).`);
          notified = true;
        } catch { /* The encrypted invitation is still queued for later. */ }
      }
      invited.push({ pane_id: paneId, address, queued: true, notified });
    } catch (error) {
      invited.push({ pane_id: paneId, address, queued: false, notified: false, error: error instanceof Error ? error.message.replaceAll(link, "[room link]") : "invite failed" });
    }
  }
  return JSON.stringify({ ok: invited.every((item) => item.queued), invited }, null, 2);
}

export const FRIENDLY_NAMES = ["Maya", "Ravi", "Lena", "Omar", "Ines", "Kenji", "Nora", "Amira", "Sofia", "Tariq", "Asha", "Leo", "Zara", "Yuki", "Nia", "Arjun"];

export async function prepareRoomPeerSpawn(options: { task: string; role?: string; name?: string; roomId?: string }) {
  const task = options.task.trim();
  if (!task) throw new Error("provide a bounded peer task");
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_PANE_ID) throw new Error("spawn_room_peer requires a Herdr-managed pane");
  const clients = await activeRoomClients();
  const hosted = [] as RoomClient[];
  for (const client of clients) {
    try { if ((await client.status()).room.host_id === client.participantId) hosted.push(client); } catch { /* unavailable room */ }
  }
  const candidates = options.roomId ? hosted.filter((client) => client.invite.room_id === options.roomId) : hosted;
  if (candidates.length !== 1) throw new Error(candidates.length ? "multiple hosted rooms; provide roomId" : "no hosted room joined in this directory");
  const client = candidates[0];
  if (!client.invite.join_secret || client.invite.join_secret === "resume-only") throw new Error("room secret unavailable; rejoin this room using its invitation");
  assertSafePeerPromptText(client.invite, undefined, task, options.role ?? "");
  const identityDir = process.env.J01N_AGENT_DIR || join(homedir(), ".local", "share", "j01n", "agents");
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  requirePrivateIdentityDir(identityDir);
  const base = new URL(client.invite.room_url).origin;
  const preferredName = (() => { const name = process.env.J01N_HOST_INBOX; if (name && !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error("invalid host inbox address"); return name || "host-" + createHash("sha256").update(`${client.invite.room_url}\0${client.participantId}`).digest("hex").slice(0, 16); })();
  const aliasFile = join(identityDir, `.j01n-host-${preferredName}.json`);
  const savedName = existsSync(aliasFile) ? (JSON.parse(readFileSync(aliasFile, "utf8")) as { name: string }).name : preferredName;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(savedName)) throw new Error("invalid saved host inbox address");
  const senderFile = join(identityDir, `.j01n-agent-${savedName}.json`);
  let sender: AgentIdentity;
  if (existsSync(senderFile)) {
    sender = JSON.parse(readFileSync(senderFile, "utf8")) as AgentIdentity;
    if (sender.name !== savedName || sender.base !== base) throw new Error("saved host inbox identity does not match this room");
  } else {
    if (existsSync(aliasFile)) throw new Error("saved host inbox identity is missing");
    try { sender = await registerAgent(base, preferredName, []); }
    catch (error) {
      if (!(error instanceof Error) || !/failed: 409\b/.test(error.message)) throw error;
      sender = await registerAgent(base, "host-" + crypto.randomUUID().replaceAll("-", "").slice(0, 16), []);
    }
    writeFileSync(join(identityDir, `.j01n-agent-${sender.name}.json`), JSON.stringify(sender, null, 2), { flag: "wx", mode: 0o600 });
    if (sender.name !== preferredName) writeFileSync(aliasFile, JSON.stringify({ name: sender.name }), { flag: "wx", mode: 0o600 });
  }
  assertSafePeerPromptText(client.invite, sender.agentToken, task, options.role ?? "");
  const namesInRoom = new Set((await client.status()).participants
    .flatMap((p) => [p.id, (p as typeof p & { display_name?: string }).display_name])
    .filter((name): name is string => !!name)
    .map((name) => name.toLowerCase()));
  const preferred = options.name?.trim();
  if (preferred && !/^[a-z][a-z0-9_-]{0,31}$/i.test(preferred)) throw new Error("friendly name must be a short alphanumeric name");
  const available = FRIENDLY_NAMES.filter((name) => !namesInRoom.has(name.toLowerCase()));
  const displayName = preferred || available[Math.floor(Math.random() * available.length)];
  if (!displayName || namesInRoom.has(displayName.toLowerCase())) throw new Error("friendly name is already in the room; choose another");
  const name = `${displayName.toLowerCase()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (name.length > 32) throw new Error("friendly name is too long for a unique agent address");
  return { client, sender, link: inviteLink(client.invite.room_url, client.invite.join_secret), name, displayName, role: options.role?.trim() || "builder", task, identityDir };
}

/** Wait for an invitation from an allowlisted agent, then join that room (kickoff, board and questions included). */
async function handleListen(parsed: ParsedArgs): Promise<string> {
  // listen <me> [timeout] [join flags, e.g. --capabilities code,shell or --no-workspace]
  const [me, ...args] = parsed.rest;
  const timeout = args.find((arg) => /^\d+$/.test(arg));
  const joinFlags = args.filter((arg) => arg !== timeout);
  const as = joinFlags.indexOf("--as");
  const participantId = process.env.J01N_PEER_PARTICIPANT_ID || (as >= 0 ? joinFlags[as + 1] : me);
  if (!participantId || !/^[a-z][a-z0-9_-]{0,31}$/.test(participantId)) throw new Error("--as needs a valid room participant id");
  if (as >= 0) joinFlags.splice(as, 2);
  const peerRole = process.env.J01N_PEER_ROLE;
  if (peerRole) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(peerRole) || peerRole === "owner" || peerRole === "host") throw new Error("invalid peer role");
    const skillNames = process.env.J01N_PEER_SKILLS;
    if (!skillNames || !skillNames.split(",").every((name) => /^[a-z][a-z0-9_-]*$/.test(name))) throw new Error("spawned peer needs validated skill names");
    for (const flag of ["--role", "--skills", "--model", "--provider"]) {
      let index: number;
      while ((index = joinFlags.indexOf(flag)) >= 0) joinFlags.splice(index, 2);
    }
    joinFlags.push("--role", peerRole, "--skills", skillNames);
  }
  const identity = loadAgent(me);
  const [invite] = await waitForInvites(identity, timeout ? Number(timeout) : undefined);
  if (!invite) return JSON.stringify({ timeout: true }, null, 2);
  await deleteInvite(identity, invite.id);
  const joined = JSON.parse(await handleJoin({ cmd: "join", roomUrlOrInvite: invite.room_link, me: participantId, rest: joinFlags }));
  return JSON.stringify({ invited_by: invite.from, ...joined }, null, 2);
}

// ── Auto-join at session start: a pane with a seeded identity must not need a first model turn ──

/** One bounded inbox wait at boot: long enough for a host inviting while the pane opens, short enough to sit out. */
export const AUTOJOIN_LISTEN_SECONDS = 10;

export interface AutojoinResult {
  /** `resume` reuses the room identity joined in this directory; `listen` opened a seeded inbox invite. */
  via: "resume" | "listen";
  room_id: string;
  participant_id: string;
  open_questions: number;
}

/** Agent identity seeds we could read an inbox from (same directory rules as loadAgent). */
export function agentSeedNames(dir = process.env.J01N_AGENT_DIR || localStateDir()): string[] {
  try {
    return readdirSync(dir)
      .map((name) => /^\.j01n-agent-([a-z][a-z0-9_-]{0,31})\.json$/.exec(name)?.[1])
      .filter((name): name is string => !!name);
  } catch {
    return []; // no inbox directory here
  }
}

/** Room identities this directory can resume; a spawned peer only ever sees its own process identity. */
function resumableProfiles(): ActiveRoom[] {
  let rooms: ActiveRoom[];
  try {
    rooms = activeRooms();
  } catch {
    return [];
  }
  const peer = process.env.J01N_PEER_PARTICIPANT_ID;
  if (!peer) return rooms;
  const roomId = process.env.J01N_PEER_ROOM_ID;
  return rooms.filter((room) => room.participant_id === peer && (!roomId || room.room_url.split("/").pop() === roomId));
}

const questionCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : Array.isArray(value) ? value.length : 0;

/** Capabilities the runner asked this worker to announce, if it exported them (never an arbitrary flag). */
function declaredCapabilities(): string[] {
  return (process.env.J01N_WORKER_CAPABILITIES ?? "").split(",").map((name) => name.trim()).filter((name) => /^[a-z0-9_-]{1,32}$/.test(name));
}

/**
 * Join the room of this directory when a Pi session starts, without involving the model: resume the one
 * saved room profile, or open the one seeded inbox with a single bounded listen. Anything ambiguous,
 * stale or absent answers undefined, and the session then behaves exactly as it did before.
 */
export async function autojoinRoom(): Promise<AutojoinResult | undefined> {
  if (process.env.J01N_AUTOJOIN === "off") return undefined;
  const profiles = resumableProfiles();
  if (profiles.length > 1) return undefined; // several rooms are active here: never guess whose
  if (profiles.length === 1) {
    // doctor resumes the saved identity and confirms this participant is still in that room.
    try {
      const checked = JSON.parse(await runj01n(["doctor", profiles[0].room_url, "resume-only", profiles[0].participant_id])) as Record<string, unknown>;
      if (checked.joined !== true || typeof checked.room_id !== "string" || typeof checked.participant_id !== "string") return undefined;
      return { via: "resume", room_id: checked.room_id, participant_id: checked.participant_id, open_questions: questionCount(checked.open_questions) };
    } catch {
      return undefined; // left, expired or a profile of another room: silent, and the rest of the session is unchanged
    }
  }
  const seeds = agentSeedNames();
  if (seeds.length !== 1) return undefined;
  const capabilities = declaredCapabilities();
  try {
    const listened = JSON.parse(await runj01n(["listen", seeds[0], String(AUTOJOIN_LISTEN_SECONDS),
      ...(capabilities.length ? ["--capabilities", capabilities.join(",")] : [])])) as Record<string, unknown>;
    if (listened.timeout === true || typeof listened.room_id !== "string" || typeof listened.participant_id !== "string") return undefined;
    return { via: "listen", room_id: listened.room_id, participant_id: listened.participant_id, open_questions: questionCount(listened.questions) };
  } catch {
    return undefined;
  }
}

/** The only room content a boot shows the model: one short line, no room link, no secret, no messages. */
export function autojoinNote(result: AutojoinResult): string {
  return `j01n: joined ${result.room_id} as ${result.participant_id}; ${result.open_questions} open question${result.open_questions === 1 ? "" : "s"}`;
}

/** A task this participant still owns and has not finished; false stops the usage heartbeat. */
function claimedTask(client: RoomClient, taskId: string): () => Promise<boolean> {
  return async () => {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) return false;
    const entry = (await client.board()).board[`task.${taskId}`];
    const value = entry?.value as { status?: unknown; owner?: unknown } | undefined;
    return value?.status === "claimed" && value?.owner === client.participantId;
  };
}

/** `/j01n claim <id>`: after the board says the task is ours, keep its usage row fresh every ~2 minutes. */
async function handleClaim(parsed: ParsedArgs): Promise<string> {
  const output = await sharedCommand(parsed);
  const taskId = parsed.rest[0];
  if (!taskId) return output;
  const client = await getClient(parsed);
  startUsageTimer(client, { stillClaimed: claimedTask(client, taskId) });
  return output;
}

/** `/j01n done ...`: finish the task, then report the usage delta that covers the last stretch of work. */
async function handleDone(parsed: ParsedArgs): Promise<string> {
  const output = await sharedCommand(parsed);
  const client = await getClient(parsed);
  stopUsageTimer(client);
  const outcome = await reportSessionUsage(client).catch(() => ({ reported: false, note: "usage: report failed; run the helper usage command to retry" }));
  return withUsageNote(output, outcome.note);
}

/** Add the one-line usage note to a command's JSON answer, without ever carrying a path or a session id. */
function withUsageNote(output: string, note: string): string {
  try {
    const value = JSON.parse(output) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return output;
    return JSON.stringify({ ...(value as Record<string, unknown>), usage: note }, null, 2);
  } catch { return output; }
}

const COMMANDS: Record<string, (parsed: ParsedArgs) => Promise<string>> = {
  worktrees: async (parsed) => {
    if (parsed.rest.length !== 1 || parsed.rest[0] !== "--remove-merged") throw new Error("usage: /j01n worktrees --remove-merged");
    return JSON.stringify(removeMergedPeerWorktrees(), null, 2);
  },
  reserve: handleReservation,
  release: handleReservation,
  reservations: handleReservation,
  register: handleRegister,
  allow: handleAllow,
  invite: handleInviteAgent,
  listen: handleListen,
  herdr_agents: handleHerdrAgents,
  use: async (parsed) => handleUse(parsed),
  invite_herdr: handleInviteHerdr,
  create: handleCreate,
  join: handleJoin,
  send: sharedCommand,
  read: sharedCommand,
  inbox: sharedCommand,
  doctor: handleDoctor,
  board: sharedCommand,
  tasks: sharedCommand,
  summary: sharedCommand,
  note: sharedCommand,
  decide: sharedCommand,
  "invite-link": handleInviteLink,
  conflicts: sharedCommand,
  claim: handleClaim,
  done: handleDone,
  block: sharedCommand,
  unblock: sharedCommand,
  board_set: sharedCommand,
  board_patch: sharedCommand,
  board_delete: sharedCommand,
  status: sharedCommand,
  webhook: sharedCommand,
  wait: sharedCommand,
  leave: handleLeave,
  close: handleClose,
  participants: sharedCommand,
  room_status: sharedCommand,
  transition: sharedCommand,
  host: sharedCommand,
  profile: handleProfile,
};

export const J01N_HELP = [
  "Usage: /j01n <command> ... (or j01n tool args: [\"<command>\", ...])",
  "Help: /j01n help or j01n args=[\"help\"]",
  `Commands: ${["help", ...Object.keys(COMMANDS), "live"].join(" | ")}`,
  "Start: /j01n create '{\"host_id\":\"host\"}' --join, or /j01n join <invite-link> <participant-id>",
  "After joining: /j01n send all <text>, /j01n read, /j01n board, /j01n doctor",
  "Room commands use the active room in this directory; pass an invitation and participant ID to select a room explicitly.",
].join("\n");

export async function runj01n(args: string[]): Promise<string> {
  if (!args.length || args[0] === "help" || args[0] === "--help") return J01N_HELP;
  const parsed = await parseCommand(args);
  const handler = COMMANDS[parsed.cmd];
  if (!handler) throw new Error(`unknown command: ${parsed.cmd}. Run /j01n help (or j01n args=["help"]) for commands.`);
  return handler(parsed);
}
