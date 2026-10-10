#!/usr/bin/env node
/** Standalone Node CLI. Room protocol, encryption, agents and reservations come from @j01n/sdk. */
import * as fs from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import {
  buildMinimalInvite, getClientUpdateNotice, joinRoom, resumeRoom, parseInviteLink,
  registerAgent, setAcceptFrom, inviteAgent, waitForInvites, deleteInvite,
  sealForRoom, listReservations, reservePaths, releasePaths, SDK_CLIENT_PROTOCOL,
  type AgentIdentity, type RoomAccess,
} from "@j01n/sdk";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import { RoomApiError } from "@j01n/sdk/errors";
import { request } from "@j01n/sdk/transport";
import { parseRoomBody, runRoomCommand } from "@j01n/sdk/room-commands";
import type { RoomClient } from "@j01n/sdk";

if (!(globalThis as typeof globalThis & { crypto?: Crypto }).crypto) (globalThis as typeof globalThis & { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
const args = process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== "--");
const cmd = args[0];
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const names = (value?: string) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);
const base = (process.env.BASE_URL || "https://j01n.me").replace(/\/$/, "");
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const activeDir = ".j01n-rooms";
const activePath = (url: string, me: string) => `${activeDir}/${createHash("sha256").update(url + "\0" + me).digest("hex")}.json`;
const isUrl = (value?: string) => !!value && /^https?:/.test(value);
const git = (...argv: string[]) => { try { return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; } };
const repo = () => { const root = git("rev-parse", "--show-toplevel") || process.cwd(); return { root, id: git("remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//") || root }; };
const workspace = () => ({ path: process.cwd(), ...(git("remote", "get-url", "origin") ? { repo: git("remote", "get-url", "origin")!.replace(/\/\/[^@/]+@/, "//") } : {}), ...(git("branch", "--show-current") ? { branch: git("branch", "--show-current") } : {}) });
const modelProfile = (rest: string[]) => {
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined; };
  return { ...(flag("--model") || process.env.J01N_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL ? { model: flag("--model") || process.env.J01N_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL } : {}), ...(flag("--provider") || process.env.J01N_PROVIDER ? { provider: flag("--provider") || process.env.J01N_PROVIDER } : {}) };
};
const roomCommand = (client: RoomClient, command: string, rest: string[], beforeSend?: () => Promise<void>) => runRoomCommand(client, command, rest, { prefix: "node .j01n/j01n.js", readAll: true, waitDefault: 50, parseWaitFallback: true, trimWaitFrom: true, webhookResult: "helper", beforeSend });

async function isRoomRef(ref?: string) {
  if (!ref) return false;
  if (ref.trim().startsWith("{")) return true;
  try { const v = JSON.parse(await fs.readFile(ref, "utf8")); return v && typeof v === "object" && ["access", "room_url", "join_secret", "participant_token"].some((k) => k in v); } catch { return false; }
}
async function activeRooms(): Promise<Array<{ room_url: string; participant_id: string }>> {
  const files = await fs.readdir(activeDir).catch(() => []);
  const rooms = [];
  for (const file of files.filter((n) => /^[0-9a-f]{64}\.json$/.test(n))) {
    const room = JSON.parse(await fs.readFile(`${activeDir}/${file}`, "utf8"));
    if (typeof room.room_url !== "string" || typeof room.participant_id !== "string" || activePath(room.room_url, room.participant_id) !== `${activeDir}/${file}`) throw Error(`invalid active-room file ${file}; rejoin with the room link`);
    rooms.push(room);
  }
  return rooms;
}
async function remember(url: string, me: string) {
  await fs.mkdir(activeDir, { recursive: true, mode: 0o700 });
  const path = activePath(url, me);
  await fs.writeFile(`${path}.${process.pid}.tmp`, JSON.stringify({ room_url: url, participant_id: me }), { mode: 0o600 });
  await fs.rename(`${path}.${process.pid}.tmp`, path);
}
type Resolved = { roomUrl: string; secret: string; me: string; rest: string[]; token?: string };
async function resolveRoom(): Promise<Resolved> {
  const env = process.env;
  const envRoom = env.ROOM_URL && (env.PARTICIPANT_TOKEN || env.JOIN_SECRET) && env.ME;
  if (envRoom && ((cmd === "send" && args.length <= 3) || (["join", "read", "team", "inbox", "watch", "doctor"].includes(cmd || "") && args.length === 1))) return { roomUrl: env.ROOM_URL!, secret: env.PARTICIPANT_TOKEN || env.JOIN_SECRET!, token: env.PARTICIPANT_TOKEN, me: env.ME!, rest: args.slice(1) };
  const link = parseInviteLink(args[1] || "");
  if (link) return { roomUrl: link.access!, secret: link.join_secret!, me: args[2], rest: args.slice(3) };
  if (isUrl(args[1])) return { roomUrl: args[1], secret: args[2], token: cmd === "join" ? undefined : args[2], me: args[3], rest: args.slice(4) };
  if (await isRoomRef(args[1])) {
    const ref = args[1].trim().startsWith("{") ? args[1] : await fs.readFile(args[1], "utf8");
    const invite = JSON.parse(ref) as RoomAccess & { participant_id?: string; me?: string };
    const roomUrl = invite.access || invite.follow || invite.room_url;
    if (!roomUrl) throw Error("profile must include access");
    if (invite.participant_token) return { roomUrl, secret: invite.participant_token, token: invite.participant_token, me: invite.participant_id || invite.me!, rest: args.slice(2) };
    if (!invite.join_secret) throw Error("invite must include access and join_secret");
    return { roomUrl, secret: invite.join_secret, me: args[2], rest: args.slice(3) };
  }
  const rooms = await activeRooms();
  if (rooms.length > 1) throw Error("several rooms are active in this directory; pass the room link or participant profile");
  if (rooms.length) return { roomUrl: rooms[0].room_url, secret: "resume-only", me: rooms[0].participant_id, rest: args.slice(1) };
  if (args[1]) throw Error(`ENOENT: cannot read invitation ${args[1]}`);
  return { roomUrl: env.ROOM_URL || "", secret: env.PARTICIPANT_TOKEN || env.JOIN_SECRET || "", token: env.PARTICIPANT_TOKEN, me: env.ME || "", rest: args.slice(1) };
}

async function agents() {
  const me = args[1]; const rest = args.slice(2);
  if (!me) throw Error("usage: j01n register <me> [allowed,agents] | allow <me> <allowed,agents> | invite <me> <to> <room link> | invites <me> | listen <me> [timeout]");
  const file = `.j01n-agent-${safe(me)}.json`;
  if (cmd === "register") {
    const identity = await registerAgent(base, me, names(rest[0]));
    await fs.writeFile(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
    output({ ok: true, address: `${base}/a/${me}`, accept_from: names(rest[0]), identity_file: file });
    return;
  }
  const identity = JSON.parse(await fs.readFile(file, "utf8").catch(() => { throw Error(`no agent identity ${file}; run: register ${me} [allowed,agents]`); })) as AgentIdentity;
  if (cmd === "allow") output(await setAcceptFrom(identity, names(rest[0])));
  if (cmd === "invite") {
    if (!rest[0] || !rest[1]) throw Error("invite needs: <me> <to> <room link>");
    output(await inviteAgent(identity, rest[0], rest[1]));
  }
  if (cmd === "invites") {
    const response = await fetch(`${identity.base}/a/${encodeURIComponent(me)}/invites`, { headers: { authorization: `Bearer ${identity.agentToken}` } });
    if (!response.ok) throw Error(await response.text());
    const result = await response.json() as { invites: Array<{ id: string; from: string; created_at: string }> };
    output((result.invites || []).map(({ id, from, created_at }) => ({ id, from, created_at })));
  }
  if (cmd === "listen") {
    const pending = await waitForInvites(identity, Number(rest[0]) || 50);
    if (!pending.length) { output({ timeout: true }); return; }
    const invite = pending[0];
    await deleteInvite(identity, invite.id);
    const joined = JSON.parse(execFileSync(process.execPath, [process.argv[1], "join", invite.room_link, me], { encoding: "utf8", env: process.env }));
    output({ invited_by: invite.from, ...joined });
  }
}

async function main() {
  if (cmd === "create") {
    const url = isUrl(args[1]) ? args[1] : base;
    const options = (isUrl(args[1]) ? args[2] : args[1]) || "{}";
    const response = await fetch(`${url.replace(/\/$/, "")}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(JSON.parse(options)) });
    const text = await response.text(); if (!response.ok) throw Error(text);
    console.log(text); return;
  }
  if (["register", "allow", "invite", "invites", "listen"].includes(cmd || "")) { await agents(); return; }
  const { roomUrl, secret, me, rest, token } = await resolveRoom();
  if (!cmd || !roomUrl || !secret || !me) throw Error("usage: j01n <create|join|send|read|team|watch|doctor> [invitation.json me | participant.j01n.json | access token me] [to] [json_body]\nTip: after join, use the participant .j01n.json profile or set ROOM_URL, PARTICIPANT_TOKEN, and ME.");
  const keyFile = `.j01n-${safe(new URL(roomUrl).pathname)}-${safe(me)}.json`;
  let state: any;
  try { state = JSON.parse(await fs.readFile(keyFile, "utf8")); } catch { state = { ...await createSdkCryptoSession(me).then((s) => s.exportKeyPair()), peers: {}, created: true }; }
  const created = !!state.created;
  const session = await createSdkCryptoSession(me, state.privateJwk, state.publicJwk);
  const roomSecret = secret === "resume-only" ? state.joinSecret || secret : secret;
  const invite = buildMinimalInvite(roomUrl, roomSecret);
  invite.participant_token = token || state.participantToken;
  const save = async () => fs.writeFile(keyFile, JSON.stringify({ privateJwk: state.privateJwk, publicJwk: state.publicJwk, peers: state.peers || {}, participantToken: state.participantToken, joinSecret: state.joinSecret, announcedKey: state.announcedKey, roomUrl }, null, 2), { mode: 0o600 });
  if (created) await save();
  let client: RoomClient;
  if (cmd === "join") {
    // Rejoining a known participant must retain its original local ECDH keypair.
    try { client = await joinRoom(invite, me, {}, session); state.announcedKey = (await session.announceKeyBody()).public_key; }
    catch (error) { if (!(error instanceof RoomApiError && error.status === 409)) throw error; client = await resumeRoom(invite, me, session); if (!state.announcedKey) { await client.announceKey(); state.announcedKey = (await session.announceKeyBody()).public_key; } }
    state.participantToken = client.invite.participant_token || state.participantToken;
    state.joinSecret = secret;
    await save();
  } else client = await resumeRoom(invite, me, session);
  const announce = async () => { const key = (await session.announceKeyBody()).public_key; if (state.announcedKey !== key) { await client.announceKey(); state.announcedKey = key; await save(); } };
  if (cmd === "join") {
    const announced: { capabilities?: string[]; model?: string; provider?: string; workspace?: ReturnType<typeof workspace> } = {};
    const i = rest.indexOf("--capabilities"); if (i >= 0) announced.capabilities = names(rest[i + 1]);
    const mine = (await client.team()).find((p) => p.id === me);
    const model = modelProfile(rest);
    if (model.model && model.model !== mine?.model) announced.model = model.model;
    if (model.provider && model.provider !== mine?.provider) announced.provider = model.provider;
    if (!rest.includes("--no-workspace") && JSON.stringify(workspace()) !== JSON.stringify(mine?.workspace)) announced.workspace = workspace();
    if (Object.keys(announced).length) await client.setProfile(announced);
    const profile = { access: roomUrl, participant_id: me, participant_token: state.participantToken, key_file: keyFile };
    await remember(roomUrl, me);
    let board: Awaited<ReturnType<RoomClient["board"]>>["board"] | null = null;
    try { board = (await client.board()).board; } catch { /* join still succeeded */ }
    let kickoff: unknown = board?.kickoff?.value ?? null;
    if (kickoff === null) kickoff = (await client.read({ all: true, includeSelf: true })).find((m) => m.intent === "kickoff")?.body ?? null;
    output({ ...profile, kickoff, board, questions: await client.openQuestions(), team: await client.team() });
    return;
  }
  if (["send", "read", "inbox", "wait"].includes(cmd)) {
    output(await roomCommand(client, cmd, rest, cmd === "send" ? announce : undefined)); return;
  }
  if (cmd === "team") { output({ ok: true, team: await client.team() }); return; }
  if (cmd === "watch") {
    await announce(); let seq = Number(rest[0] || 0); if (!Number.isFinite(seq)) seq = 0;
    const print = async (event: string) => {
      const messages = (await client.read({ all: true, includeSelf: true })).filter((m) => Number(m.seq || 0) > seq);
      seq = Math.max(seq, ...messages.map((m) => Number(m.seq || 0)));
      if (messages.length) output({ event, messages });
    };
    await print("initial");
    const participantToken = state.participantToken;
    if (!participantToken) throw Error("participant token missing; run join first");
    const eventsUrl = `${roomUrl.replace(/\/$/, "")}/events?s=${encodeURIComponent(participantToken)}&include_self=true`;
    const response = await fetch(eventsUrl, { headers: { accept: "text/event-stream" } });
    if (!response.ok || !response.body) throw Error(`watch failed: ${response.status} ${await response.text()}`);
    console.error(`watching ${roomUrl} as ${me}...`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        let event = "message"; const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (event === "ping" || event === "ready") continue;
        if (event === "message") await print("message");
        else if (event === "changed") await print("message");
        else {
          const text = data.join("\n"); let parsed: unknown = text || undefined;
          try { parsed = JSON.parse(text); } catch { /* a plain-text SSE payload */ }
          output({ event, data: parsed });
        }
      }
    }
    return;
  }
  if (cmd === "doctor") {
    const participants = await client.participants().catch(() => ({ participants: [] }));
    const joined = participants.participants.some((p) => p.id === me);
    if (joined) await announce().catch(() => undefined);
    const raw = joined ? await request<{ messages: Array<{ id: string; body: { encrypted?: boolean } }> }>(`${roomUrl}/?view=all&include_self=true`, client.invite, { participantId: me }) : { messages: [] };
    const messages = joined ? await client.read({ all: true, includeSelf: true }) : [];
    const encrypted = raw.messages.filter((m) => m.body?.encrypted);
    const decryptable = encrypted.filter((m) => !messages.find((opened) => opened.id === m.id)?.decrypt_error).length;
    let openQuestions: number | null = null; let openQuestionsError: string | undefined = joined ? undefined : "not joined";
    if (joined) try { openQuestions = (await client.openQuestions()).length; } catch (err) { openQuestionsError = String(err); }
    output({ ok: joined, client_protocol: SDK_CLIENT_PROTOCOL, ...(getClientUpdateNotice() ? { client_update: getClientUpdateNotice() } : {}), open_questions: openQuestions, ...(openQuestionsError ? { open_questions_error: openQuestionsError } : {}), participant_id: me, joined, key_file: keyFile, local_key_created: created, key_announced: messages.some((m) => m.from === me && m.intent === "key.exchange"), known_peers: participants.participants.filter((p) => p.id !== me && p.public_key).map((p) => p.id), encrypted_messages_seen: encrypted.length, encrypted_messages_decryptable: decryptable, key_note: `Reuse this key file from the same directory to retain your ECDH keypair across sessions: ${keyFile}` }); return;
  }
  if (cmd === "kickoff") { if (!rest.length) throw Error("kickoff needs: <text or json>; run it with the room link or invitation (it needs the join secret)"); output(await client.send("all", { encrypted_payload: await sealForRoom(parseRoomBody(rest.join(" ")), roomSecret, invite.room_id) }, { intent: "kickoff", plain: true })); return; }
  if (cmd === "webhook") { output(await roomCommand(client, cmd, rest)); return; }
  if (cmd === "profile") {
    const body: { capabilities?: string[]; model?: string; provider?: string; workspace?: ReturnType<typeof workspace> | null } = { ...modelProfile(rest) };
    const i = rest.indexOf("--capabilities"); if (i >= 0) body.capabilities = names(rest[i + 1]?.startsWith("--") ? "" : rest[i + 1]);
    if (rest.includes("--no-workspace")) body.workspace = null;
    else if (rest.includes("--workspace")) { if (roomSecret === "resume-only") throw Error("re-announcing the workspace needs the room link (it is sealed with the room key): profile <room link> <me> --workspace"); body.workspace = workspace(); }
    if (Object.keys(body).length) await client.setProfile(body);
    output({ ok: true, team: await client.team() }); return;
  }
  if (cmd === "reserve" || cmd === "release") {
    const { root, id } = repo(); const i = rest.indexOf("--reason"); const paths = (i >= 0 ? rest.slice(0, i) : rest).map((p) => relative(root, resolve(p)) || ".");
    if (cmd === "reserve" && !paths.length) throw Error("reserve needs: <path>... [--reason text]");
    output({ ok: true, reservations: cmd === "reserve" ? await reservePaths(client, id, paths, i >= 0 ? rest.slice(i + 1).join(" ") || undefined : undefined) : await releasePaths(client, id, paths) }); return;
  }
  if (cmd === "reservations") { output({ reservations: await listReservations(client) }); return; }
  if (cmd === "leave") { await client.leave({ release: rest.includes("--release") }); await fs.rm(activePath(roomUrl, me), { force: true }); output({ ok: true, left: true }); return; }
  if (cmd === "host") { output(await roomCommand(client, cmd, rest)); return; }
  throw Error(`unknown command: ${cmd}. Usage: create|join|send|read|team|inbox|watch|wait|doctor|webhook|kickoff|profile|host|reserve|release|reservations|leave`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
