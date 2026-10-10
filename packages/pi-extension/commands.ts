import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildMinimalInvite, createRoom, deleteInvite, getClientUpdateNotice, inviteAgent, inviteLink, joinRoom, normalizeInvite, parseInviteLink, registerAgent, resumeRoom, RoomApiError, SDK_CLIENT_PROTOCOL, setAcceptFrom, waitForInvites } from "@j01n/sdk";
import type { AgentIdentity, Workspace } from "@j01n/sdk";
import { execFileSync } from "node:child_process";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import { roomReplyHint, roomReplyHints, runProfileCommand, runReservationCommand, runRoomCommand } from "@j01n/sdk/room-commands";
import { detectWorkspace } from "@j01n/sdk/node";
import { checkConflicts } from "@j01n/sdk/conflicts-node";
import type { Invite, RoomClient } from "@j01n/sdk";
import { parseArgs, type ParsedArgs } from "./args";
import { listHerdrPeers, notifyHerdrPeer } from "./herdr";
import { requirePrivateIdentityDir } from "./spawn-herdr";
import { getExtensionDiagnostics } from "./version";

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
  "status", "webhook", "participants", "room_status", "transition", "host", "profile", "reserve", "release", "reservations", "tasks", "claim", "done", "conflicts", "block", "unblock", "leave", "close",
]);

const AGENT_COMMANDS = new Set(["register", "allow", "invite", "listen", "herdr_agents", "invite_herdr"]);

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
  if (invite.join_secret === "resume-only" && saved.joinSecret) invite = { ...invite, join_secret: saved.joinSecret };
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
  const model = flag("--model") || process.env.J01N_MODEL || process.env.PI_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL;
  const provider = flag("--provider") || process.env.J01N_PROVIDER || process.env.PI_PROVIDER;
  const detected = parsed.rest.includes("--no-workspace") ? undefined : detectWorkspace(client.invite.join_secret, client.invite.room_id);
  let workspace = detected?.workspace;
  // Re-joining from the same place announces nothing new (every seal differs, so compare the opened values).
  const teamList = workspace || model || provider ? await client.team().catch(() => []) : [];
  const mine = teamList.find((p) => p.id === parsed.me);
  if (mine && JSON.stringify(mine.workspace) === JSON.stringify(workspace)) workspace = undefined;
  const profile: { capabilities?: string[]; workspace?: Workspace; checkout?: string; model?: string; provider?: string } = { capabilities, workspace };
  if (detected?.checkout !== mine?.checkout) profile.checkout = detected?.checkout;
  if (model && mine?.model !== model) profile.model = model;
  if (provider && mine?.provider !== provider) profile.provider = provider;
  if (capabilities || workspace || profile.checkout || profile.model || profile.provider) await client.setProfile(profile);
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
  const extension = getExtensionDiagnostics();
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
    ...(extension.warnings.length ? { extension_warning: extension.warnings } : {}),
  }, null, 2);
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
  // --release: also release your file reservations (leaving while holding some is refused).
  await client.leave({ release: parsed.rest.includes("--release") });
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
  return join(process.env.J01N_AGENT_DIR || ".", `.j01n-agent-${me.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
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
  if (`${task} ${options.role ?? ""}`.includes(client.invite.join_secret)) throw new Error("peer task and role must not contain the room secret");
  const identityDir = process.env.J01N_AGENT_DIR || join(homedir(), ".local", "share", "j01n", "agents");
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  requirePrivateIdentityDir(identityDir);
  const base = new URL(client.invite.room_url).origin;
  const preferredName = "host-" + createHash("sha256").update(`${client.invite.room_url}\0${client.participantId}`).digest("hex").slice(0, 16);
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
  return { client, sender, link: inviteLink(client.invite.room_url, client.invite.join_secret), name: options.name || "peer-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12), role: `${options.role?.trim() || "collaborator"}: ${task}`, identityDir };
}

/** Wait for an invitation from an allowlisted agent, then join that room (kickoff, board and questions included). */
async function handleListen(parsed: ParsedArgs): Promise<string> {
  // listen <me> [timeout] [join flags, e.g. --capabilities code,shell or --no-workspace]
  const [me, ...args] = parsed.rest;
  const timeout = args.find((arg) => /^\d+$/.test(arg));
  const joinFlags = args.filter((arg) => arg !== timeout);
  const identity = loadAgent(me);
  const [invite] = await waitForInvites(identity, timeout ? Number(timeout) : undefined);
  if (!invite) return JSON.stringify({ timeout: true }, null, 2);
  await deleteInvite(identity, invite.id);
  const joined = JSON.parse(await handleJoin({ cmd: "join", roomUrlOrInvite: invite.room_link, me: identity.name, rest: joinFlags }));
  return JSON.stringify({ invited_by: invite.from, ...joined }, null, 2);
}

const COMMANDS: Record<string, (parsed: ParsedArgs) => Promise<string>> = {
  reserve: handleReservation,
  release: handleReservation,
  reservations: handleReservation,
  register: handleRegister,
  allow: handleAllow,
  invite: handleInviteAgent,
  listen: handleListen,
  herdr_agents: handleHerdrAgents,
  invite_herdr: handleInviteHerdr,
  create: handleCreate,
  join: handleJoin,
  send: sharedCommand,
  read: sharedCommand,
  inbox: sharedCommand,
  doctor: handleDoctor,
  board: sharedCommand,
  tasks: sharedCommand,
  conflicts: sharedCommand,
  claim: sharedCommand,
  done: sharedCommand,
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

export async function runj01n(args: string[]): Promise<string> {
  const parsed = parseCommand(args);
  const handler = COMMANDS[parsed.cmd];
  if (!handler) throw new Error(`unknown command: ${parsed.cmd}. Usage: create|join|send|read|inbox|doctor`);
  return handler(parsed);
}
