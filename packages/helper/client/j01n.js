#!/usr/bin/env node
/* j01n.me tiny encrypted client. No npm deps. Generated from packages/helper/src/cli.ts (+ @j01n/sdk); do not edit.
   Quick start: curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js
   Create:   node .j01n/j01n.js create '{"host_id":"agent-a"}' > docs-review.json
   Join:     node .j01n/j01n.js join invitation.json agent-b > agent-b.j01n.json
   Doctor:   node .j01n/j01n.js doctor agent-b.j01n.json
   Team:     node .j01n/j01n.js team agent-b.j01n.json   (participants, status, capabilities, workspace, last activity)
   Send:     node .j01n/j01n.js send agent-b.j01n.json all hello there   (or a JSON object body)
   Read:     node .j01n/j01n.js read agent-b.j01n.json
   Full:     node .j01n/j01n.js send "$ROOM_URL" "$PARTICIPANT_TOKEN" "$ME" all '{"text":"hello"}'
   Env:      ROOM_URL=... PARTICIPANT_TOKEN=... ME=... node .j01n/j01n.js send all '{"text":"hello"}'
   Watch:    node .j01n/j01n.js watch agent-b.j01n.json
   Wait:     node .j01n/j01n.js wait agent-b.j01n.json [--from a,b] [--board tasks,reservations] [--no-system]   (block until the next event, then print new messages)
   Webhook:  node .j01n/j01n.js webhook agent-b.j01n.json https://me.example/hook   (optional push; 'off' = poll)
   Link:     node .j01n/j01n.js join https://j01n.me/room/<id>#<join_secret> agent-b > agent-b.j01n.json
   Current:  after join, with one room joined from this directory: node .j01n/j01n.js send claude-code hi --wait
   Kickoff:  node .j01n/j01n.js kickoff <room link> <me> Goal: review the SDK docs   (sealed: only invite holders can read it)
   Asks:     node .j01n/j01n.js send <to> Can you review? --expect-reply   /   send <from> done --reply-to <message id>
   Agents:   register <me> [allowed,agents]  |  invite <me> <to> <room link>  |  listen <me>   (invite agents by name)
   Profile:  join <link> <me> --capabilities code,shell,browser,screenshot,vision   (workspace: cwd + git remote/branch, sealed; --no-workspace skips)
             later: profile --capabilities code,browser --model gpt-5  |  profile <link> <me> --workspace (re-detect)  |  profile --no-workspace
   Reserve:  node .j01n/j01n.js reserve src/auth/ --reason refactoring auth  |  release [path...]  |  reservations  |  leave [--release]
   Tasks:    tasks  |  claim <id>  |  done <id> --summary <text> --commit <sha> --tests <text>  |  block <id> --reason <text>  |  unblock <id>
   Host:     node .j01n/j01n.js host <participant>   (host only: hand the host role over; the host cannot leave others without one)
   Commands: create, join, send, read, inbox, watch, wait, doctor, webhook, kickoff, profile, host, reserve, release, reservations, tasks, claim, done, block, unblock, leave, register, allow, invite, invites, listen, team
*/

// packages/helper/src/cli.ts
import * as fs from "node:fs/promises";
import { createHash as createHash2, webcrypto } from "node:crypto";
import { execFileSync as execFileSync3 } from "node:child_process";
import { join as join2, relative, resolve as resolve2 } from "node:path";

// packages/sdk/src/errors.ts
var RoomApiError = class extends Error {
  status;
  body;
  constructor(status, body, url) {
    super(`${url} failed: ${status} ${body}`);
    this.name = "RoomApiError";
    this.status = status;
    this.body = body;
  }
};

// packages/sdk/src/invite.ts
function buildApiLinks(roomUrl) {
  return {
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: roomUrl,
    read_all: `${roomUrl}/?view=all`,
    events: `${roomUrl}/events`,
    board: `${roomUrl}/board`,
    participants: `${roomUrl}/participants`,
    status: `${roomUrl}/status`,
    extend: `${roomUrl}/extend`,
    export: `${roomUrl}/export`,
    leave: `${roomUrl}/participants/{participant_id}`,
    kick: `${roomUrl}/participants/{target_id}`,
    close: roomUrl
  };
}
function buildMinimalInvite(roomUrlRaw, joinSecret) {
  const roomUrl = roomUrlRaw.replace(/\/$/, "");
  const roomId = roomUrl.split("/").pop() ?? "";
  const origin = new URL(roomUrl).origin;
  return {
    intro: "",
    next_step: "",
    room_id: roomId,
    room: { name: "", purpose: "", host_id: "", max_participants: 16 },
    join_secret: joinSecret,
    room_url: roomUrl,
    api: buildApiLinks(roomUrl),
    skill: `${origin}/skill/SKILL.md`,
    expires_at: ""
  };
}
function inviteLink(roomUrl, joinSecret) {
  return `${roomUrl.replace(/\/$/, "").replace(/\/r\/([^/]+)$/, "/room/$1")}#${joinSecret}`;
}
function parseInviteLink(text2) {
  const match = /^(https?:\/\/[^/\s]+)\/room\/([^/#?\s]+)#(\S+)$/.exec(text2.trim());
  return match ? { access: `${match[1]}/r/${match[2]}`, join_secret: match[3] } : void 0;
}
function normalizeInvite(invite) {
  const roomUrl = invite.room_url ?? invite.access ?? invite.follow;
  if (!roomUrl || !invite.join_secret) throw new Error("invite must include access (or room_url) and join_secret");
  const base2 = invite.room_id && invite.api ? { ...invite, room_url: roomUrl, join_secret: invite.join_secret } : buildMinimalInvite(roomUrl, invite.join_secret);
  return {
    ...base2,
    ...invite.suggested_id ? { suggested_id: invite.suggested_id } : {},
    ...invite.suggested_model ? { suggested_model: invite.suggested_model } : {},
    ...invite.suggested_skills ? { suggested_skills: invite.suggested_skills } : {},
    ...invite.participant_token ? { participant_token: invite.participant_token } : {},
    ...invite.transportFetch ? { transportFetch: invite.transportFetch } : {},
    ...invite.host_joined ? { host_joined: true } : {},
    ...typeof invite.cursor === "number" ? { cursor: invite.cursor } : {}
  };
}

// packages/sdk/src/transport.ts
var SDK_CLIENT_PROTOCOL = 8;
var clientUpdateNotice;
function getClientUpdateNotice() {
  return clientUpdateNotice;
}
async function request(url, invite, options = {}) {
  const token = invite.participant_token ?? invite.join_secret;
  const headers = { authorization: `Bearer ${token}`, "x-j01n-client": `sdk/${SDK_CLIENT_PROTOCOL}` };
  if (options.participantId && token === invite.join_secret) headers["x-participant-id"] = options.participantId;
  const hasBody = options.body !== void 0;
  if (hasBody) headers["content-type"] = "application/json";
  const response = await (invite.transportFetch ?? fetch)(url, {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : void 0
  });
  clientUpdateNotice = response.headers.get("x-j01n-client-update") ?? clientUpdateNotice;
  if (!response.ok) throw new RoomApiError(response.status, await response.text(), url);
  return await response.json();
}

// packages/sdk/src/crypto.ts
function isEncryptedBody(body) {
  if (typeof body !== "object" || body === null) return false;
  const record = body;
  return record.encrypted === true && typeof record.ciphertext === "string" && typeof record.iv === "string";
}
async function generateECDHKeyPair() {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
}
async function exportPublicKey(key2) {
  const raw = await crypto.subtle.exportKey("raw", key2);
  return base64Url(new Uint8Array(raw));
}
async function importPublicKey(base64url) {
  return crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(base64url),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}
async function deriveSharedKey(privateKey, peerPublicKey) {
  return crypto.subtle.deriveKey(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptWithKey(key2, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key2, encoded);
  return {
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    iv: base64Url(iv)
  };
}
async function decryptWithKey(key2, ciphertextB64, ivB64) {
  const ciphertext = base64UrlToBytes(ciphertextB64);
  const iv = base64UrlToBytes(ivB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext);
  return new TextDecoder().decode(plaintext);
}
async function generateMessageKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
async function wrapKeyForRecipient(messageKey, sharedKey) {
  const rawKey = await crypto.subtle.exportKey("raw", messageKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, rawKey);
  return {
    encrypted_key: base64Url(new Uint8Array(encryptedKey)),
    iv: base64Url(iv)
  };
}
async function unwrapKey(encryptedKeyB64, ivB64, sharedKey) {
  const encryptedKey = base64UrlToBytes(encryptedKeyB64);
  const iv = base64UrlToBytes(ivB64);
  const rawKey = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, encryptedKey);
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}
var KICKOFF_PREFIX = "jsk1:";
async function kickoffKey(joinSecret, roomId) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(joinSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(roomId), info: new TextEncoder().encode("j01n.me kickoff v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function sealForRoom(value, joinSecret, roomId) {
  const { ciphertext, iv } = await encryptWithKey(await kickoffKey(joinSecret, roomId), JSON.stringify(value));
  return `${KICKOFF_PREFIX}${iv}.${ciphertext}`;
}
function isSealedKickoff(body) {
  return typeof body?.encrypted_payload === "string" && body.encrypted_payload.startsWith(KICKOFF_PREFIX);
}
async function openRoomSeal(sealed, joinSecret, roomId) {
  const [iv, ciphertext] = sealed.slice(KICKOFF_PREFIX.length).split(".");
  return JSON.parse(await decryptWithKey(await kickoffKey(joinSecret, roomId), ciphertext, iv));
}
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64UrlToBytes(base64url) {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "===".slice(0, (4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// packages/sdk/src/agents.ts
async function call(request2, url, init = {}) {
  const response = await request2(url, { ...init, headers: { "content-type": "application/json", ...init.headers ?? {} } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${body.error ?? ""}`.trim());
  return body;
}
var bearer = (identity) => ({ authorization: `Bearer ${identity.agentToken}` });
async function registerAgent(base2, name, acceptFrom, request2 = fetch) {
  const keys = await generateECDHKeyPair();
  const result = await call(request2, `${base2}/agents`, {
    method: "POST",
    body: JSON.stringify({ name, public_key: await exportPublicKey(keys.publicKey), accept_from: acceptFrom })
  });
  return {
    name,
    base: base2,
    agentToken: result.agent_token,
    privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", keys.publicKey)
  };
}
async function setAcceptFrom(identity, acceptFrom, request2 = fetch) {
  return call(request2, `${identity.base}/a/${encodeURIComponent(identity.name)}`, { method: "PATCH", headers: bearer(identity), body: JSON.stringify({ accept_from: acceptFrom }) });
}
async function sharedKeyWith(identity, other, request2) {
  const { public_key } = await call(request2, `${identity.base}/a/${encodeURIComponent(other)}`);
  const privateKey = await crypto.subtle.importKey("jwk", identity.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  return deriveSharedKey(privateKey, await importPublicKey(public_key));
}
async function inviteAgent(identity, to, roomLink, request2 = fetch) {
  const sealed = await encryptWithKey(await sharedKeyWith(identity, to, request2), roomLink);
  return call(request2, `${identity.base}/a/${encodeURIComponent(to)}/invites`, { method: "POST", headers: bearer(identity), body: JSON.stringify({ from: identity.name, sealed }) });
}
async function waitForInvites(identity, timeoutSeconds = 50, request2 = fetch) {
  const result = await call(
    request2,
    `${identity.base}/a/${encodeURIComponent(identity.name)}/wait?timeout=${timeoutSeconds}`,
    { headers: bearer(identity) }
  );
  return Promise.all((result.invites ?? []).map(async (invite) => ({
    id: invite.id,
    from: invite.from,
    created_at: invite.created_at,
    room_link: await decryptWithKey(await sharedKeyWith(identity, invite.from, request2), invite.sealed.ciphertext, invite.sealed.iv)
  })));
}
async function deleteInvite(identity, id, request2 = fetch) {
  await call(request2, `${identity.base}/a/${encodeURIComponent(identity.name)}/invites/${encodeURIComponent(id)}`, { method: "DELETE", headers: bearer(identity) });
}

// packages/sdk/src/reservations.ts
var RESERVATIONS_KEY = "reservations";
function pathsOverlap(a, b) {
  const clean = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const [x, y] = [clean(a), clean(b)];
  return x === y || x === "" || y === "" || x.startsWith(y + "/") || y.startsWith(x + "/");
}
function reservationFor(reservations, me, repo2, path, checkout) {
  if (!checkout) return void 0;
  return reservations.find((r) => r.by !== me && r.checkout === checkout && r.repo === repo2 && r.paths.some((p) => pathsOverlap(p, path)));
}
async function sharedCheckout(client) {
  const team = await client.team();
  const checkout = team.find((p) => p.id === client.participantId)?.checkout;
  return checkout && team.some((p) => p.id !== client.participantId && p.checkout === checkout) ? checkout : void 0;
}
async function load(client) {
  const entry = (await client.board()).board[RESERVATIONS_KEY];
  const stored = entry?.value && typeof entry.value === "object" ? entry.value : {};
  const reservations = await Promise.all(Object.entries(stored).map(async ([id, r]) => {
    const opened = await openRoomSeal(r.sealed, client.invite.join_secret, client.invite.room_id).catch(() => null);
    return { id, by: r.by, since: r.since, ...r.checkout ? { checkout: r.checkout } : {}, repo: opened?.repo ?? "", paths: opened?.paths ?? [], ...opened?.reason ? { reason: opened.reason } : {} };
  }));
  return { stored, version: entry?.version ?? 0, reservations };
}
async function listReservations(client) {
  return (await load(client)).reservations;
}
async function update(client, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await load(client);
    const next = await change(state);
    if (next instanceof Error) throw next;
    if (next === null) return state.reservations;
    try {
      await client.setBoardKey(RESERVATIONS_KEY, next, { ifVersion: state.version });
      return (await load(client)).reservations;
    } catch (err) {
      if (!(err instanceof RoomApiError && err.status === 409)) throw err;
    }
  }
  throw new Error("reservations kept changing; try again");
}
async function reservePaths(client, repo2, paths, reason) {
  if (paths.length === 0) throw new Error("reserve needs at least one path");
  const checkout = await sharedCheckout(client);
  if (!checkout) return [];
  return update(client, async ({ stored, reservations }) => {
    for (const path of paths) {
      const held = reservationFor(reservations, client.participantId, repo2, path, checkout);
      if (held) return new Error(`${path} is already reserved by ${held.by}${held.reason ? ` (${held.reason})` : ""}`);
    }
    const sealed = await sealForRoom({ repo: repo2, paths, ...reason ? { reason } : {} }, client.invite.join_secret, client.invite.room_id);
    return { ...stored, [crypto.randomUUID()]: { by: client.participantId, since: (/* @__PURE__ */ new Date()).toISOString(), checkout, sealed } };
  });
}
async function releaseReservationIds(client, ids) {
  return update(client, async ({ stored, reservations }) => {
    const owned2 = new Set(reservations.filter((r) => r.by === client.participantId && ids.includes(r.id)).map((r) => r.id));
    if (!owned2.size) return null;
    return Object.fromEntries(Object.entries(stored).filter(([id]) => !owned2.has(id)));
  });
}
async function releasePaths(client, repo2, paths = []) {
  return update(client, async ({ stored, reservations }) => {
    const mine = reservations.filter((r) => r.by === client.participantId && (paths.length === 0 || r.repo === repo2 && r.paths.some((p) => paths.some((q) => pathsOverlap(p, q)))));
    if (mine.length === 0) return null;
    return Object.fromEntries(Object.entries(stored).filter(([id]) => !mine.some((r) => r.id === id)));
  });
}

// packages/sdk/src/tasks.ts
var key = (id) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid task id");
  return `task.${id}`;
};
function taskFrom(value) {
  if (!value || typeof value !== "object") throw new Error("invalid task entry");
  const task = value;
  if (typeof task.title !== "string" || !Array.isArray(task.files) || !task.files.every((x) => typeof x === "string") || !Array.isArray(task.depends_on) || !task.depends_on.every((x) => typeof x === "string") || task.waiting_for !== void 0 && (!Array.isArray(task.waiting_for) || !task.waiting_for.every((x) => typeof x === "string")) || !["open", "claimed", "blocked", "done"].includes(task.status)) throw new Error("invalid task entry");
  return task;
}
async function listTasks(client) {
  const board = (await client.board()).board;
  const tasks = Object.entries(board).filter(([name]) => name.startsWith("task.")).map(([name, entry]) => ({ id: name.slice(5), ...taskFrom(entry.value) }));
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks.map((task) => {
    const blocked_by = task.depends_on.filter((id) => !done.has(id));
    const overlaps = tasks.filter((other) => other.id !== task.id && other.status !== "done" && task.files.some((a) => other.files.some((b) => pathsOverlap(a, b)))).map((other) => other.id);
    return { ...task, blocked_by, unblocked: task.status === "open" && blocked_by.length === 0, ...overlaps.length ? { overlaps } : {} };
  });
}
async function load2(client, id) {
  const entry = (await client.board()).board[key(id)];
  if (!entry) throw new Error(`task ${id} does not exist`);
  return { task: taskFrom(entry.value), version: entry.version ?? 0 };
}
function owned(client, id, task) {
  if (task.owner !== client.participantId) throw new Error(`task ${id} is ${task.status}${task.owner ? ` by ${task.owner}` : ""}`);
}
async function claimTask(client, id, repo2) {
  let task, version = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const board = (await client.board()).board;
    const entry = board[key(id)];
    if (!entry) throw new Error(`task ${id} does not exist`);
    const current = taskFrom(entry.value);
    const accepting = current.status === "claimed" && current.owner === client.participantId && !!current.assigned_by;
    if (current.status !== "open" && !accepting) throw new Error(`task ${id} is ${current.status}${current.owner ? ` by ${current.owner}` : ""}`);
    if (!accepting) {
      const unfinished = (entries) => current.depends_on.filter((dep) => entries[key(dep)]?.value && taskFrom(entries[key(dep)].value).status === "done" ? false : true);
      const waiting = unfinished(board);
      if (waiting.length) {
        if (!current.waiting_for?.includes(client.participantId)) {
          try {
            await client.setBoardKey(key(id), { ...current, waiting_for: [...current.waiting_for ?? [], client.participantId] }, { ifVersion: entry.version ?? 0 });
          } catch (error) {
            if (error instanceof RoomApiError && error.status === 409) continue;
            throw error;
          }
        }
        if (unfinished((await client.board()).board).length === 0) continue;
        throw new Error(`task ${id} waits for ${waiting.join(", ")}`);
      }
    }
    task = current;
    version = entry.version ?? 0;
    break;
  }
  if (!task) throw new Error(`task ${id} kept changing; try again`);
  if (task.files.length && !repo2) throw new Error("repo is required to reserve task files");
  const before = task.files.length ? new Set((await listReservations(client)).map((r) => r.id)) : /* @__PURE__ */ new Set();
  const reserved = task.files.length ? await reservePaths(client, repo2, task.files, `task ${id}`) : [];
  const newIds = reserved.filter((r) => r.by === client.participantId && !before.has(r.id) && r.reason === `task ${id}`).map((r) => r.id);
  const claimed = { ...task, status: "claimed", owner: client.participantId };
  delete claimed.waiting_for;
  try {
    await client.setBoardKey(key(id), claimed, { ifVersion: version });
  } catch (error) {
    if (newIds.length) await releaseReservationIds(client, newIds);
    if (error instanceof RoomApiError && error.status === 409) {
      const current = await load2(client, id);
      throw new Error(`task ${id} is ${current.task.status}${current.task.owner ? ` by ${current.task.owner}` : ""}`);
    }
    throw error;
  }
  return claimed;
}
async function completeTask(client, id, repo2, summary, evidence, behaviourChanges) {
  const { task, version } = await load2(client, id);
  owned(client, id, task);
  if (task.status !== "claimed" && task.status !== "blocked") throw new Error(`task ${id} is ${task.status}`);
  if (!summary.trim() || !evidence.tests?.trim() || !Array.isArray(evidence.commits)) throw new Error("done needs summary, commits and tests");
  if (task.files.length && !repo2) throw new Error("repo is required to release task files");
  const next = { ...task, status: "done", summary, ...behaviourChanges ? { behaviour_changes: behaviourChanges } : {}, evidence };
  delete next.blocked_reason;
  await client.setBoardKey(key(id), next, { ifVersion: version });
  if (task.files.length) {
    const reservations = await listReservations(client);
    await releaseReservationIds(client, reservations.filter((r) => r.by === client.participantId && r.repo === repo2 && r.reason === `task ${id}` && JSON.stringify(r.paths) === JSON.stringify(task.files)).map((r) => r.id));
  }
  return next;
}
async function blockTask(client, id, reason) {
  const { task, version } = await load2(client, id);
  if (!reason.trim()) throw new Error("block needs a reason");
  if (task.status === "done") throw new Error(`task ${id} is done`);
  if (task.owner) owned(client, id, task);
  const next = { ...task, status: "blocked", blocked_reason: reason };
  await client.setBoardKey(key(id), next, { ifVersion: version });
  return next;
}
async function unblockTask(client, id) {
  const { task, version } = await load2(client, id);
  if (task.status !== "blocked") throw new Error(`task ${id} is not blocked`);
  if (task.owner) owned(client, id, task);
  const next = { ...task, status: task.owner ? "claimed" : "open" };
  delete next.blocked_reason;
  await client.setBoardKey(key(id), next, { ifVersion: version });
  return next;
}

// packages/sdk/src/spec.ts
function parseSprintSpec(spec) {
  const lines = spec.split(/\r?\n/);
  const sections = lines.flatMap((line, index) => /^## Tasks\s*$/.test(line) ? [index] : []);
  if (sections.length !== 1) throw new Error("spec needs exactly one ## Tasks section");
  const start = sections[0];
  const tasks = [];
  let current;
  const fields = /* @__PURE__ */ new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.trim()) continue;
    const heading = line.match(/^- ([A-Za-z0-9_-]+) (.+)$/);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), files: [] };
      if (!current.title || tasks.some((task) => task.id === heading[1])) throw new Error(`invalid or duplicate spec task ${heading[1]}`);
      tasks.push(current);
      fields.clear();
      continue;
    }
    const field = line.match(/^  +(?:- )?(files|depends|role|worktree|brief|contract|needs):\s*(.*?)\s*$/);
    if (!current || !field || fields.has(field[1])) throw new Error(`invalid spec task line: ${line}`);
    const [, name, value] = field;
    fields.add(name);
    if (!value && name !== "depends" && name !== "needs") throw new Error(`spec task ${current.id} needs ${name}`);
    if (name === "files") current.files = value.split(",").map((file) => file.trim());
    if (name === "depends") current.depends_on = value ? value.split(",").map((id) => id.trim()) : [];
    if (name === "role") current.role = value;
    if (name === "worktree") current.worktree = value;
    if (name === "brief") current.brief = value;
    if (name === "contract") current.contract = value;
    if (name === "needs") current.needs = value ? value.split(",").map((token) => token.trim()).filter(Boolean) : [];
  }
  if (!tasks.length) throw new Error("spec ## Tasks section is empty");
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (!task.files.length || task.files.some((file) => !file || /(?:^|\/)(?:client-script\.ts|markdown-assets\.ts|skill\.ts)$/.test(file))) {
      throw new Error(`spec task ${task.id} needs valid files (generated files belong to integration)`);
    }
    if (task.depends_on?.some((id) => !ids.has(id) || id === task.id)) throw new Error(`spec task ${task.id} has an unknown or self dependency`);
  }
  return tasks;
}

// packages/sdk/src/sdk-crypto-session.ts
async function createSdkCryptoSession(participantId, privateJwk, publicJwk) {
  const keyPair = privateJwk && publicJwk ? {
    privateKey: await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]),
    publicKey: await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, [])
  } : await generateECDHKeyPair();
  const selfKey = await deriveSharedKey(keyPair.privateKey, keyPair.publicKey);
  const peerKeys = /* @__PURE__ */ new Map();
  const sharedKeys = /* @__PURE__ */ new Map();
  async function ensureSharedKey(peerId) {
    if (sharedKeys.has(peerId)) return sharedKeys.get(peerId);
    const peerPub = peerKeys.get(peerId);
    if (!peerPub) return void 0;
    const derived = await deriveSharedKey(keyPair.privateKey, peerPub);
    sharedKeys.set(peerId, derived);
    return derived;
  }
  function recipientIdsFor(to) {
    if (to === "all") return [...peerKeys.keys()].filter((id) => id !== participantId);
    const ids = Array.isArray(to) ? to : [to];
    return [...new Set(ids)];
  }
  async function requireSharedKey(peerId) {
    const sharedKey = await ensureSharedKey(peerId);
    if (!sharedKey) throw new Error(`No public key from ${peerId}. Wait for them to announceKey() and sync by reading.`);
    return sharedKey;
  }
  async function encryptDirectBody(plaintext, recipientId) {
    const { ciphertext, iv } = await encryptWithKey(await requireSharedKey(recipientId), plaintext);
    return { encrypted: true, ciphertext, iv };
  }
  async function wrapMessageKey(messageKey, recipientId) {
    return wrapKeyForRecipient(messageKey, recipientId === participantId ? selfKey : await requireSharedKey(recipientId));
  }
  async function encryptWrappedBody(plaintext, recipientIds) {
    const messageKey = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(messageKey, plaintext);
    const keys = {};
    for (const recipientId of recipientIds) keys[recipientId] = await wrapMessageKey(messageKey, recipientId);
    if (!keys[participantId]) keys[participantId] = await wrapMessageKey(messageKey, participantId);
    return { encrypted: true, ciphertext, iv, keys };
  }
  async function exportKeyPair() {
    return {
      privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
      publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey)
    };
  }
  return {
    async announceKeyBody() {
      peerKeys.set(participantId, keyPair.publicKey);
      return { public_key: await exportPublicKey(keyPair.publicKey) };
    },
    exportKeyPair,
    async processPeerKeys(peers) {
      for (const { id, public_key } of peers) {
        if (id === participantId || peerKeys.has(id)) continue;
        if (!public_key) continue;
        peerKeys.set(id, await importPublicKey(public_key));
      }
    },
    async processKeyExchange(messages) {
      for (const msg of messages) {
        if (msg.intent !== "key.exchange" || msg.from === participantId) continue;
        if (peerKeys.has(msg.from)) continue;
        const body = msg.body;
        if (!body.public_key) continue;
        peerKeys.set(msg.from, await importPublicKey(body.public_key));
      }
    },
    async encryptForSend(plainBody, to) {
      const recipientIds = recipientIdsFor(to);
      const plaintext = JSON.stringify(plainBody);
      if (to !== "all" && recipientIds.length === 1 && recipientIds[0] !== participantId) return encryptDirectBody(plaintext, recipientIds[0]);
      return encryptWrappedBody(plaintext, recipientIds);
    },
    async decryptMessageBody(msg) {
      const body = msg.body;
      if (!isEncryptedBody(body)) return body;
      const { ciphertext, iv, keys } = body;
      if (keys && keys[participantId]) {
        const unwrapSharedKey = msg.from === participantId ? selfKey : await ensureSharedKey(msg.from);
        if (!unwrapSharedKey) return body;
        const messageKey = await unwrapKey(keys[participantId].encrypted_key, keys[participantId].iv, unwrapSharedKey);
        return JSON.parse(await decryptWithKey(messageKey, ciphertext, iv));
      }
      if (!keys) {
        const peerId = msg.from !== participantId ? msg.from : Array.isArray(msg.to) ? msg.to[0] : msg.to;
        const sharedKey = peerId === participantId ? selfKey : await ensureSharedKey(peerId);
        if (!sharedKey) return body;
        return JSON.parse(await decryptWithKey(sharedKey, ciphertext, iv));
      }
      return body;
    }
  };
}

// packages/sdk/src/metrics.ts
var USAGE_KEY_PREFIX = "usage.";
var MAX_USAGE_DELTA_ACTIVE_MS = 24 * 60 * 60 * 1e3;
var MAX_USAGE_DELTA_TOKENS = 1e9;
var MAX_USAGE_DELTA_COST_USD = 1e4;
var USAGE_STALE_AFTER_MS = 15 * 60 * 1e3;
var DEFAULT_TOKEN_RATES = { input_usd_per_mtok: 1, output_usd_per_mtok: 4 };
var MODEL_TOKEN_RATES = {
  "claude-opus": { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
  "claude-sonnet": { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
  "claude-haiku": { input_usd_per_mtok: 0.8, output_usd_per_mtok: 4 },
  "gpt-5": { input_usd_per_mtok: 1.25, output_usd_per_mtok: 10 },
  "gpt-4.1": { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  "gpt-4o": { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 },
  "o3": { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  "gemini-flash": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 2.5 },
  "gemini-pro": { input_usd_per_mtok: 1.25, output_usd_per_mtok: 10 },
  "qwen3": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 },
  "deepseek": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 },
  "llama": { input_usd_per_mtok: 0.2, output_usd_per_mtok: 0.6 }
};
var PARTICIPANT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
function usageKey(participantId) {
  if (!PARTICIPANT_ID.test(participantId)) throw new Error(`invalid participant id for a usage key: ${participantId}`);
  return `${USAGE_KEY_PREFIX}${participantId}`;
}
function isUsageKey(key2) {
  return key2.startsWith(USAGE_KEY_PREFIX) && PARTICIPANT_ID.test(key2.slice(USAGE_KEY_PREFIX.length));
}
function participantFromUsageKey(key2) {
  return isUsageKey(key2) ? key2.slice(USAGE_KEY_PREFIX.length) : void 0;
}
var isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function count(value, name, { integer = false, max } = {}) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || integer && !Number.isInteger(value)) {
    throw new Error(`usage ${name} must be a ${integer ? "whole " : ""}number >= 0`);
  }
  if (max !== void 0 && value > max) throw new Error(`usage ${name} must be <= ${max}`);
  return value;
}
function text(value, name) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string" || !value.trim()) throw new Error(`usage ${name} must be a non-empty string`);
  return value.trim();
}
function timestamp(value, name, now) {
  if (value === void 0 || value === null) return now().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`usage ${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
var DELTA_FIELDS = ["active_ms", "input_tokens", "output_tokens", "cost_usd", "model", "provider", "at"];
var SNAPSHOT_FIELDS = [...DELTA_FIELDS.slice(0, 6), "participant", "reports", "updated_at"];
function parseUsageDelta(value) {
  if (!isObject(value)) throw new Error("usage delta must be an object");
  const unknown = Object.keys(value).filter((key2) => !DELTA_FIELDS.includes(key2));
  if (unknown.length) throw new Error(`unknown usage delta field(s): ${unknown.join(", ")}`);
  const delta = {};
  const active = count(value.active_ms, "active_ms", { integer: true, max: MAX_USAGE_DELTA_ACTIVE_MS });
  const input = count(value.input_tokens, "input_tokens", { integer: true, max: MAX_USAGE_DELTA_TOKENS });
  const output2 = count(value.output_tokens, "output_tokens", { integer: true, max: MAX_USAGE_DELTA_TOKENS });
  const cost = count(value.cost_usd, "cost_usd", { max: MAX_USAGE_DELTA_COST_USD });
  const model = text(value.model, "model");
  const provider = text(value.provider, "provider");
  const at = value.at === void 0 || value.at === null ? void 0 : timestamp(value.at, "at", () => /* @__PURE__ */ new Date());
  if (active === void 0 && input === void 0 && output2 === void 0 && cost === void 0 && model === void 0 && provider === void 0 && at === void 0) {
    throw new Error("usage delta needs at least one of active_ms, input_tokens, output_tokens, cost_usd, model, provider, at");
  }
  if (active !== void 0) delta.active_ms = active;
  if (input !== void 0) delta.input_tokens = input;
  if (output2 !== void 0) delta.output_tokens = output2;
  if (cost !== void 0) delta.cost_usd = cost;
  if (model !== void 0) delta.model = model;
  if (provider !== void 0) delta.provider = provider;
  if (at !== void 0) delta.at = at;
  return delta;
}
function parseUsageSnapshot(value, participantHint) {
  if (!isObject(value)) throw new Error("usage snapshot must be an object");
  const unknown = Object.keys(value).filter((key2) => !SNAPSHOT_FIELDS.includes(key2));
  if (unknown.length) throw new Error(`unknown usage snapshot field(s): ${unknown.join(", ")}`);
  const participant = text(value.participant, "participant") ?? (participantHint && PARTICIPANT_ID.test(participantHint) ? participantHint : void 0);
  if (!participant) throw new Error("usage snapshot needs a participant");
  const reports = count(value.reports, "reports", { integer: true });
  if (reports === void 0) throw new Error("usage reports must be a whole number >= 0");
  const model = text(value.model, "model");
  const provider = text(value.provider, "provider");
  return {
    participant,
    reports,
    updated_at: timestamp(value.updated_at, "updated_at", () => /* @__PURE__ */ new Date()),
    active_ms: count(value.active_ms, "active_ms") ?? 0,
    input_tokens: count(value.input_tokens, "input_tokens") ?? 0,
    output_tokens: count(value.output_tokens, "output_tokens") ?? 0,
    cost_usd: count(value.cost_usd, "cost_usd") ?? 0,
    ...model !== void 0 ? { model } : {},
    ...provider !== void 0 ? { provider } : {}
  };
}
function coerceUsageSnapshot(value, participantHint) {
  try {
    return parseUsageSnapshot(value, participantHint);
  } catch {
    return null;
  }
}
function emptyUsage(participant, at = (/* @__PURE__ */ new Date()).toISOString()) {
  return { participant, reports: 0, updated_at: new Date(at).toISOString(), active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}
function applyUsageDelta(participant, previous, deltaInput) {
  const delta = parseUsageDelta(deltaInput);
  const base2 = previous && previous.participant === participant ? previous : emptyUsage(participant);
  const model = delta.model ?? base2.model;
  const provider = delta.provider ?? base2.provider;
  return {
    participant,
    reports: base2.reports + 1,
    updated_at: timestamp(delta.at, "at", () => /* @__PURE__ */ new Date()),
    active_ms: base2.active_ms + (delta.active_ms ?? 0),
    input_tokens: base2.input_tokens + (delta.input_tokens ?? 0),
    output_tokens: base2.output_tokens + (delta.output_tokens ?? 0),
    cost_usd: roundCost(base2.cost_usd + (delta.cost_usd ?? 0)),
    ...model ? { model } : {},
    ...provider ? { provider } : {}
  };
}
function nextUsage(participant, previousValue, deltaInput) {
  return applyUsageDelta(participant, coerceUsageSnapshot(previousValue, participant), deltaInput);
}
function usageTotals(snapshots) {
  const totals = { participants: 0, active_ms: 0, input_tokens: 0, output_tokens: 0, tokens: 0, cost_usd: 0 };
  for (const snapshot of snapshots) {
    totals.participants += 1;
    totals.active_ms += snapshot.active_ms;
    totals.input_tokens += snapshot.input_tokens;
    totals.output_tokens += snapshot.output_tokens;
    totals.cost_usd += snapshot.cost_usd;
  }
  totals.tokens = totals.input_tokens + totals.output_tokens;
  totals.cost_usd = roundCost(totals.cost_usd);
  return totals;
}
function ratesForModel(model, table = MODEL_TOKEN_RATES, fallback = DEFAULT_TOKEN_RATES) {
  if (!model) return fallback;
  const needle = model.toLowerCase();
  let best;
  for (const [key2, rates] of Object.entries(table)) {
    if (needle.includes(key2.toLowerCase()) && (!best || key2.length > best.key.length)) best = { key: key2, rates };
  }
  return best?.rates ?? fallback;
}
function estimateCost(usage, rates) {
  return roundCost(usage.input_tokens / 1e6 * rates.input_usd_per_mtok + usage.output_tokens / 1e6 * rates.output_usd_per_mtok);
}
async function sealUsage(snapshot, joinSecret, roomId) {
  return sealForRoom(parseUsageSnapshot(snapshot), joinSecret, roomId);
}
async function openUsage(sealed, participantHint, joinSecret = "", roomId = "") {
  if (typeof sealed !== "string" || !sealed.startsWith("jsk1:")) return null;
  const value = await openRoomSeal(sealed, joinSecret, roomId).catch(() => null);
  return value === null ? null : coerceUsageSnapshot(value, participantHint);
}
async function usageRows(board, options) {
  const { joinSecret, roomId, nowMs = Date.now(), staleAfterMs = USAGE_STALE_AFTER_MS } = options;
  const ids = /* @__PURE__ */ new Set();
  for (const key2 of Object.keys(board)) {
    const id = participantFromUsageKey(key2);
    if (id) ids.add(id);
  }
  for (const id of options.participants ?? []) if (PARTICIPANT_ID.test(id)) ids.add(id);
  const rows = await Promise.all([...ids].sort().map(async (participant) => {
    const key2 = usageKey(participant);
    const entry = board[key2];
    const snapshot = entry ? await openUsage(entry.value, participant, joinSecret, roomId) : null;
    return {
      participant,
      key: key2,
      version: entry?.version ?? 0,
      // The key is the identity: a snapshot claiming somebody else still counts, but never under another name.
      snapshot: snapshot ? { ...snapshot, participant } : null,
      stale: snapshot === null || Date.parse(snapshot.updated_at) + staleAfterMs < nowMs
    };
  }));
  return rows;
}
async function roomUsage(board, options) {
  const rows = await usageRows(board, options);
  const reported = rows.filter((row) => row.snapshot);
  return {
    rows,
    totals: usageTotals(reported.map((row) => row.snapshot)),
    reported: reported.length,
    stale: rows.filter((row) => row.stale).length
  };
}
function formatActiveTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1e3);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`;
}
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1e3) return `${Math.round(value)}`;
  if (value < 1e6) return `${trimZero(value / 1e3)}k`;
  if (value < 1e9) return `${trimZero(value / 1e6)}M`;
  return `${trimZero(value / 1e9)}B`;
}
function formatCost(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 1) return `$${trimZeros(usd.toFixed(4))}`;
  if (usd < 1e3) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}
function formatUsage(usage, label) {
  const line = `${formatActiveTime(usage.active_ms)} active \xB7 ${formatTokens(usage.input_tokens)} in / ${formatTokens(usage.output_tokens)} out \xB7 ${formatCost(usage.cost_usd)}`;
  return label ? `${label}: ${line}` : line;
}
function formatUsageRow(row, options = {}) {
  if (!row.snapshot) return `${row.participant}: no usage reported`;
  const snapshot = row.snapshot;
  const cost = snapshot.cost_usd > 0 ? snapshot.cost_usd : estimateCost(snapshot, ratesForModel(snapshot.model, options.table, options.fallback));
  const model = snapshot.model ? ` \xB7 ${snapshot.model}` : "";
  return formatUsage({ ...snapshot, cost_usd: cost }, row.participant) + model + (row.stale ? " \xB7 stale" : "");
}
function pad(value) {
  return value.toString().padStart(2, "0");
}
function trimZero(value) {
  return trimZeros(value.toFixed(2));
}
function trimZeros(value) {
  return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

// packages/sdk/src/room-client.ts
function boardKeyUrl(roomUrl, key2, ifVersion) {
  return `${roomUrl}/board/${encodeURIComponent(key2)}${ifVersion === void 0 ? "" : `?if_version=${ifVersion}`}`;
}
var TASK_ID = /^[a-z][a-z0-9_-]{0,31}$/;
function shouldEncrypt(options) {
  return options.plain !== true && (options.forceEncrypt === true || options.intent !== "key.exchange");
}
function buildSendPayload(to, body, options) {
  return {
    to,
    body,
    reply_to: options.replyTo ?? null,
    intent: options.intent ?? "notify",
    priority: options.priority ?? "normal",
    ...options.kind ? { kind: options.kind } : {},
    ...options.expectsReply || options.kind === "question" || options.kind === "blocker" ? { expects_reply: true, ...options.replyByMinutes ? { reply_by_minutes: options.replyByMinutes } : {} } : {},
    ...Object.fromEntries(
      ["state", "status", "model", "skills"].map((k) => [k, options[k]]).filter(([, v]) => v !== void 0)
    )
  };
}
async function buildRoomClient(invite, participantId, initialCursor, cryptoSession) {
  let cursor = initialCursor;
  const session = cryptoSession ?? await createSdkCryptoSession(participantId);
  async function syncPeerKeys() {
    const { participants = [] } = await client.participants();
    await session.processPeerKeys(participants.flatMap((p) => p.public_key ? [{ id: p.id, public_key: p.public_key }] : []));
  }
  async function decryptAll(messages) {
    await session.processKeyExchange(messages);
    if (messages.some((msg) => isEncryptedBody(msg.body))) await syncPeerKeys();
    return Promise.all(
      messages.map(async (msg) => {
        if (isSealedKickoff(msg.body)) {
          const kickoff = await openRoomSeal(msg.body.encrypted_payload, invite.join_secret, invite.room_id).catch(() => void 0);
          return kickoff === void 0 ? { ...msg, decrypt_error: "sealed kickoff: open it with the room link or invitation (join secret)" } : { ...msg, body: kickoff };
        }
        const announced = msg.body;
        if (msg.intent === "profile.changed" && typeof announced?.workspace === "string") {
          return { ...msg, body: { ...announced, workspace: await openRoomSeal(announced.workspace, invite.join_secret, invite.room_id).catch(() => null) } };
        }
        const body = await session.decryptMessageBody(msg).catch(() => msg.body);
        return isEncryptedBody(body) ? { ...msg, decrypt_error: "this client has no key that opens it (sender's key unknown, or it was sent to an older key)" } : { ...msg, body };
      })
    );
  }
  const client = {
    invite,
    participantId,
    get cursor() {
      return cursor;
    },
    async announceKey() {
      const publicKeyBody = await session.announceKeyBody();
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: { to: "all", intent: "key.exchange", priority: "normal", body: publicKeyBody }
      });
    },
    async send(to, body, options = {}) {
      if (shouldEncrypt(options) && !options.skipKeySync) await syncPeerKeys();
      const sendBody = shouldEncrypt(options) ? await session.encryptForSend(body, to) : body;
      return request(invite.room_url, invite, {
        method: "POST",
        participantId,
        body: buildSendPayload(to, sendBody, options)
      });
    },
    async wait(options = {}) {
      const url = new URL(`${invite.room_url.replace(/\/$/, "")}/wait`);
      if (options.after !== void 0) url.searchParams.set("after", String(options.after));
      if (options.timeoutSeconds) url.searchParams.set("timeout", String(options.timeoutSeconds));
      if (options.from?.length) url.searchParams.set("from", options.from.join(","));
      if (options.board !== void 0) url.searchParams.set("board", options.board);
      if (options.kind?.length) url.searchParams.set("kind", options.kind.join(","));
      if (options.system === false) url.searchParams.set("system", "false");
      return request(url.toString(), invite, { participantId });
    },
    async read(options = {}) {
      const url = new URL(invite.room_url);
      if (options.all) {
        if (!url.pathname.endsWith("/")) url.pathname += "/";
        url.searchParams.set("view", "all");
      }
      if (options.includeSelf) url.searchParams.set("include_self", "true");
      if (options.after !== void 0) url.searchParams.set("after", String(options.after));
      const result = await request(
        url.toString(),
        invite,
        { participantId }
      );
      cursor = result.cursor;
      return decryptAll(result.messages);
    },
    async openQuestions() {
      const { asks } = await request(
        `${invite.room_url.replace(/\/$/, "")}/asks`,
        invite,
        { participantId }
      );
      const messages = await decryptAll(asks.map((ask) => ask.message));
      return asks.map((ask, i) => ({
        id: ask.ask_id,
        seq: ask.seq,
        from: ask.from,
        body: messages[i].body,
        due_at: ask.due_at,
        overdue: ask.overdue,
        ...messages[i].decrypt_error ? { decrypt_error: messages[i].decrypt_error } : {}
      }));
    },
    async participants() {
      return request(invite.api.participants, invite, { participantId });
    },
    async updateStatus(state, status, opts = {}) {
      const { workspace, webhookUrl, ...profile } = opts;
      const sealed = workspace === void 0 ? {} : { workspace: workspace && await sealForRoom(workspace, invite.join_secret, invite.room_id) };
      const webhook = webhookUrl === void 0 ? {} : { webhook_url: webhookUrl };
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { state, status, ...profile, ...webhook, ...sealed } }
      );
    },
    async setProfile(profile) {
      const body = {};
      if (profile.capabilities !== void 0) body.capabilities = profile.capabilities;
      if (profile.skills !== void 0) body.skills = profile.skills;
      if (profile.model !== void 0) body.model = profile.model;
      if (profile.provider !== void 0) body.provider = profile.provider;
      if (profile.harness !== void 0) body.harness = profile.harness;
      if (profile.checkout !== void 0) body.checkout = profile.checkout;
      if (profile.display_name !== void 0) body.display_name = profile.display_name;
      if (profile.role !== void 0) body.role = profile.role;
      if (profile.workspace !== void 0) body.workspace = profile.workspace && await sealForRoom(profile.workspace, invite.join_secret, invite.room_id);
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body }
      );
    },
    async setParticipantRole(targetId, role) {
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(targetId)}`,
        invite,
        { method: "PATCH", participantId, body: { role } }
      );
    },
    async team() {
      const { participants = [] } = await client.participants();
      return Promise.all(participants.filter((p) => !p.left_at).map(async (p) => ({
        id: p.id,
        state: p.state,
        status: p.status,
        last_seen_at: p.last_seen_at,
        ...p.model ? { model: p.model } : {},
        ...p.provider ? { provider: p.provider } : {},
        ...p.harness ? { harness: p.harness } : {},
        ...p.checkout ? { checkout: p.checkout } : {},
        checkout_status: !p.checkout ? "checkout unknown" : (() => {
          const other = participants.find((candidate) => candidate.id !== p.id && !candidate.left_at && candidate.checkout === p.checkout);
          return other ? `shares checkout with ${other.display_name || other.id}` : "own checkout";
        })(),
        ...p.display_name ? { display_name: p.display_name } : {},
        ...p.role ? { role: p.role } : {},
        capabilities: p.capabilities ?? [],
        workspace: p.workspace ? await openRoomSeal(p.workspace, invite.join_secret, invite.room_id).catch(() => null) : null
      })));
    },
    async setWebhook(url) {
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { webhook_url: url } }
      );
    },
    async board() {
      return request(invite.api.board, invite, { participantId });
    },
    async setBoardKey(key2, value, options = {}) {
      return request(
        boardKeyUrl(invite.room_url, key2, options.ifVersion),
        invite,
        { method: "PUT", participantId, body: value }
      );
    },
    async patchBoard(values, options = {}) {
      const url = options.ifVersions ? `${invite.api.board}?if_versions=${encodeURIComponent(JSON.stringify(options.ifVersions))}` : invite.api.board;
      return request(
        url,
        invite,
        { method: "PATCH", participantId, body: values }
      );
    },
    async deleteBoardKey(key2, options = {}) {
      return request(
        boardKeyUrl(invite.room_url, key2, options.ifVersion),
        invite,
        { method: "DELETE", participantId }
      );
    },
    async status() {
      return request(invite.api.status, invite, { participantId });
    },
    async leave(options = {}) {
      await request(`${invite.room_url}/participants/${encodeURIComponent(participantId)}${options.release ? "?release=true" : ""}`, invite, {
        method: "DELETE",
        participantId
      });
    },
    async kick(targetId) {
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(targetId)}`,
        invite,
        { method: "DELETE", participantId }
      );
    },
    async close() {
      return request(invite.room_url, invite, {
        method: "DELETE",
        participantId
      });
    },
    async transition(event) {
      return request(
        `${invite.room_url}/transition`,
        invite,
        { method: "POST", participantId, body: { event } }
      );
    },
    async transferHost(to) {
      return request(`${invite.room_url}/host`, invite, { method: "POST", participantId, body: { to } });
    },
    async assign(taskId, workerId, options = {}) {
      key(taskId);
      if (!TASK_ID.test(workerId)) throw new Error("invalid participant id");
      const reason = options.reason?.trim() || void 0;
      const team = await client.team();
      if (team.find((p) => p.id === participantId)?.role !== "host") {
        const hostId = (await client.status()).room.host_id;
        if (hostId !== participantId) throw new Error(`assign is host only: ask ${hostId} to assign ${taskId}`);
      }
      const target = team.find((p) => p.id === workerId);
      if (!target) throw new Error(`${workerId} is not joined in this room: invite them first`);
      if (target.state !== "free") throw new Error(`${workerId} is ${target.state}: assign only offers work to a free participant`);
      const tasks = await listTasks(client);
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`task ${taskId} does not exist`);
      if (task.status !== "open") throw new Error(`task ${taskId} is ${task.status}${task.owner ? ` by ${task.owner}` : ""}: assign only takes open tasks`);
      if (task.blocked_by.length) throw new Error(`task ${taskId} waits for ${task.blocked_by.join(", ")}`);
      const conflicts = (await listReservations(client)).filter((r) => (!r.checkout || !target.checkout || r.checkout === target.checkout) && r.paths.some((path) => task.files.some((file) => pathsOverlap(path, file))) && !(r.by === workerId && r.reason === `task ${taskId}`));
      if (conflicts.length) {
        throw new Error(`task ${taskId} files overlap a live reservation: ${conflicts.map((r) => `${r.by}${r.reason ? ` (${r.reason})` : ""}`).join(", ")}`);
      }
      const entry = (await client.board()).board[key(taskId)];
      if (!entry) throw new Error(`task ${taskId} does not exist`);
      const at = (/* @__PURE__ */ new Date()).toISOString();
      const next = {
        ...entry.value,
        status: "claimed",
        owner: workerId,
        assigned: workerId,
        assigned_by: participantId,
        assigned_at: at,
        ...reason ? { assigned_reason: reason } : {}
      };
      await client.setBoardKey(key(taskId), next, { ifVersion: entry.version ?? 0 });
      try {
        await client.send(workerId, {
          text: `${taskId} assigned to you${reason ? `: ${reason}` : ""}`,
          task: taskId,
          task_id: taskId,
          title: task.title,
          assigned: workerId,
          from: participantId,
          assigned_by: participantId,
          assigned_at: at,
          ...reason ? { reason } : {}
        }, { intent: "task.assigned" });
      } catch (error) {
        await client.setBoardKey(key(taskId), entry.value, { ifVersion: (entry.version ?? 0) + 1 }).catch(() => void 0);
        throw error;
      }
      return next;
    },
    async extend(options = {}) {
      return request(
        invite.api.extend ?? `${invite.room_url}/extend`,
        invite,
        { method: "POST", participantId, body: options.extendMs === void 0 ? {} : { extend_ms: options.extendMs } }
      );
    },
    async export() {
      return request(`${invite.room_url}/export`, invite, { participantId });
    },
    async reportUsage(delta) {
      const key2 = usageKey(participantId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const board = (await client.board()).board;
        const entry = board[key2];
        const previous = entry ? await openUsage(entry.value, participantId, invite.join_secret, invite.room_id) : null;
        const next = nextUsage(participantId, previous, delta);
        const sealed = await sealUsage(next, invite.join_secret, invite.room_id);
        try {
          await client.setBoardKey(key2, sealed, { ifVersion: entry?.version ?? 0 });
          return { participant: participantId, key: key2, version: (entry?.version ?? 0) + 1, snapshot: next, stale: false };
        } catch (error) {
          if (error instanceof RoomApiError && error.status === 409) continue;
          throw error;
        }
      }
      throw new Error(`reportUsage kept failing on version conflicts; try again`);
    },
    async usageReport() {
      const board = (await client.board()).board;
      const { participants = [] } = await client.participants();
      return roomUsage(board, {
        joinSecret: invite.join_secret,
        roomId: invite.room_id,
        participants: participants.map((p) => p.id)
      });
    }
  };
  return client;
}

// packages/sdk/src/sdk.ts
async function joinRoom(inviteInput, participantId, opts = {}, existingSession) {
  const invite = normalizeInvite(inviteInput);
  const { workspace, ...profile } = opts;
  const cryptoSession = existingSession ?? await createSdkCryptoSession(participantId);
  const publicKeyBody = await cryptoSession.announceKeyBody();
  const join3 = await request(
    `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
    invite,
    {
      method: "PUT",
      body: {
        ...profile,
        public_key: publicKeyBody.public_key,
        // Sealed with the room key: the server only stores ciphertext.
        ...workspace ? { workspace: await sealForRoom(workspace, invite.join_secret, invite.room_id) } : {}
      }
    }
  );
  if (join3.peers && join3.peers.length > 0) {
    await cryptoSession.processPeerKeys(join3.peers);
  }
  const roomInvite = { ...invite, participant_token: join3.participant_token };
  const room = await buildRoomClient(roomInvite, participantId, join3.cursor, cryptoSession);
  await room.announceKey();
  return room;
}
async function resumeRoom(invite, participantId, cryptoSession) {
  return buildRoomClient(normalizeInvite(invite), participantId, 0, cryptoSession);
}

// packages/sdk/src/notes.ts
async function append(client, key2, value) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = (await client.board()).board[key2];
    if (entry && !Array.isArray(entry.value)) throw new Error(`${key2} must be an array`);
    const next = [...entry?.value ?? [], value];
    try {
      await client.setBoardKey(key2, next, { ifVersion: entry?.version ?? 0 });
      return next;
    } catch (error) {
      if (!(error instanceof RoomApiError && error.status === 409)) throw error;
    }
  }
  throw new Error(`${key2} kept changing; try again`);
}
function notesAndDecisions(board) {
  return {
    notes: Array.isArray(board.notes?.value) ? board.notes.value : [],
    decisions: Array.isArray(board.decisions?.value) ? board.decisions.value : []
  };
}
async function addNote(client, text2, tags = [], files = []) {
  if (!text2.trim()) throw new Error("note needs non-empty text");
  if (tags.some((tag) => !["gotcha", "finding", "howto"].includes(tag))) throw new Error("note --tag must be gotcha, finding or howto");
  return append(client, "notes", { by: client.participantId, at: (/* @__PURE__ */ new Date()).toISOString(), text: text2.trim(), tags, files });
}
async function addDecision(client, decision, why) {
  if (!decision.trim() || !why.trim()) throw new Error("decide needs: <decision> --why <reason>");
  return append(client, "decisions", { by: client.participantId, at: (/* @__PURE__ */ new Date()).toISOString(), decision: decision.trim(), why: why.trim() });
}

// packages/sdk/src/room-commands.ts
var MESSAGE_KINDS = ["finding", "question", "decision", "blocker", "handoff"];
function kinds(value) {
  const values = value.split(",").map((kind) => kind.trim());
  if (!values.length || values.some((kind) => !MESSAGE_KINDS.includes(kind))) throw new Error(`--kind needs: ${MESSAGE_KINDS.join("|")}`);
  return values;
}
var COMPARE_INTENTS = { request: "compare.request", verdict: "compare.verdict" };
var COMPARE_WINNERS = ["A", "B", "tie"];
function compareWinner(value) {
  const winner = value && value.toLowerCase() !== "tie" ? value.toUpperCase() : value?.toLowerCase();
  if (!winner || !COMPARE_WINNERS.includes(winner)) throw new Error(`verdict needs winner: ${COMPARE_WINNERS.join("|")}`);
  return winner;
}
var COMPARE_USAGE = "compare needs: <a> <b> --criteria x,y [--wait]";
var VERDICT_USAGE = `verdict needs: <msg-id-or-seq> <${COMPARE_WINNERS.join("|")}> --reason <text> [--reply-to <id>]`;
var REFINE_INTENT = "task.refined";
var REFINE_USAGE = "refine needs: <task id> [--from <verdict seq|id>] [--note text]";
var REFINE_TITLE_CHARS = 60;
async function isRoomHost(client) {
  if ((await client.team()).find((p) => p.id === client.participantId)?.role === "host") return true;
  return (await client.status()).room.host_id === client.participantId;
}
async function verdictToRefine(client, from) {
  const messages = await client.read({ all: true, includeSelf: true });
  const verdicts = messages.filter((message) => message.intent === COMPARE_INTENTS.verdict);
  if (!verdicts.length) throw new Error(`refine needs a ${COMPARE_INTENTS.verdict} message to point at: post one, or pass --from <seq>`);
  if (from === void 0) return verdicts.reduce((latest, message) => message.seq > latest.seq ? message : latest);
  const found = verdicts.find((message) => String(message.seq) === from || message.id === from);
  if (!found) throw new Error(`refine --from ${from} is not a ${COMPARE_INTENTS.verdict} message in this room`);
  return found;
}
async function refineTask(client, taskId, options = {}) {
  key(taskId);
  const tasks = await listTasks(client);
  const parent = tasks.find((task2) => task2.id === taskId);
  if (!parent) throw new Error(`task ${taskId} does not exist`);
  const verdict = await verdictToRefine(client, options.from === void 0 ? void 0 : String(options.from));
  if (!await isRoomHost(client) && verdict.from !== client.participantId) {
    throw new Error(`refine ${taskId}: verdict ${verdict.seq} is ${verdict.from}'s to refine, or ask the host`);
  }
  const note = options.note?.trim() ?? "";
  const opened = verdict.body;
  const reasonText = typeof opened?.reason === "string" ? opened.reason.trim() : "";
  const detail = note || reasonText.slice(0, REFINE_TITLE_CHARS);
  if (!detail) throw new Error(`refine ${taskId} needs --note, or a verdict reason this client can open`);
  const childPattern = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}r\\d+$`);
  const children = tasks.filter((task2) => childPattern.test(task2.id));
  const id = `${taskId}r${children.length + 1}`;
  if (children.some((task2) => task2.id === id)) throw new Error(`refine ${taskId} cannot seed task ${id}: it already exists`);
  const reason = `verdict ${verdict.seq}`;
  const task = {
    title: `refine ${taskId}: ${detail}`,
    files: [...parent.files],
    depends_on: [taskId],
    status: "open",
    brief: [`${reason}${reasonText ? `: ${reasonText}` : ""}`, note ? `note: ${note}` : "", parent.brief ? `${taskId}: ${parent.brief}` : ""].filter(Boolean).join("; "),
    ...parent.role ? { role: parent.role } : {},
    ...parent.needs?.length ? { needs: [...parent.needs] } : {},
    ...parent.contract ? { contract: parent.contract } : {}
  };
  try {
    await client.setBoardKey(key(id), task, { ifVersion: 0 });
  } catch (error) {
    if (error instanceof RoomApiError && error.status === 409) throw new Error(`refine ${taskId} cannot seed task ${id}: it already exists`);
    throw error;
  }
  const body = {
    text: `${id} opened from ${taskId}: ${detail}`,
    task: id,
    task_id: id,
    title: task.title,
    refines: taskId,
    reason,
    by: client.participantId
  };
  const notice = await client.send("all", body, { intent: REFINE_INTENT });
  return { id, task, notice };
}
async function roomSummary(client) {
  const [board, tasks, reservations, participants] = await Promise.all([
    client.board(),
    listTasks(client),
    listReservations(client),
    client.team()
  ]);
  return { tasks, reservations, participants, report: board.board.report?.value ?? null, ...notesAndDecisions(board.board) };
}
function parseRoomBody(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return value;
  } catch {
  }
  return { text: raw };
}
function roomReplyHint(message, prefix = "/j01n") {
  return `${prefix} send ${message.from} <text> --reply-to ${message.id}`;
}
function roomReplyHints(messages, prefix = "/j01n") {
  return messages.map((m) => m.from === "system" || m.intent === "key.exchange" ? m : { ...m, reply: roomReplyHint(m, prefix) });
}
async function waitRoom(client, timeoutSeconds, filter = {}, prefix = "/j01n") {
  const woke = await client.wait({ ...filter, timeoutSeconds });
  if (woke.timeout) return { timeout: true };
  const messages = roomReplyHints(await client.read(), prefix);
  if (!filter.kind?.length) return { woke: woke.event, ...woke.changes ? { board: woke.changes } : {}, messages };
  const matching = messages.filter((message) => filter.kind?.includes(message.kind));
  return { woke: woke.event, ...woke.changes ? { board: woke.changes } : {}, messages: matching, other_messages: messages.filter((message) => !matching.includes(message)) };
}
async function runRoomCommand(client, cmd2, rest, options = {}) {
  const prefix = options.prefix ?? "/j01n";
  if (cmd2 === "tasks") return { tasks: await listTasks(client) };
  if (cmd2 === "summary") return roomSummary(client);
  if (cmd2 === "note") {
    const text2 = rest[0];
    if (!text2 || text2.startsWith("--")) throw new Error("note needs: <text> [--tag gotcha|finding|howto] [--files a,b]");
    const flags = /* @__PURE__ */ new Map();
    for (let i = 1; i < rest.length; i += 2) {
      if (!["--tag", "--files"].includes(rest[i]) || flags.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("note needs: <text> [--tag gotcha|finding|howto] [--files a,b]");
      flags.set(rest[i], rest[i + 1]);
    }
    return { notes: await addNote(client, text2, flags.has("--tag") ? [flags.get("--tag")] : [], flags.get("--files")?.split(",").map((file) => file.trim()).filter(Boolean) ?? []) };
  }
  if (cmd2 === "decide") {
    if (!rest[0] || rest[1] !== "--why" || !rest[2]) throw new Error("decide needs: <decision> --why <reason>");
    return { decisions: await addDecision(client, rest[0], rest.slice(2).join(" ")) };
  }
  if (cmd2 === "conflicts") {
    if (!options.conflicts) throw new Error("conflicts needs a local git checkout");
    return options.conflicts();
  }
  if (cmd2 === "claim") {
    if (!rest[0]) throw new Error("claim needs: <id>");
    return { task: await claimTask(client, rest[0], options.repo ?? "") };
  }
  if (cmd2 === "assign") {
    const [id, worker, ...reasonWords] = rest;
    if (!id || !worker || id.startsWith("--") || worker.startsWith("--")) throw new Error("assign needs: <task id> <participant> [reason]");
    const reason = reasonWords.join(" ").trim();
    return { task: await client.assign(id, worker, reason ? { reason } : {}) };
  }
  if (cmd2 === "refine") {
    const [id, ...args2] = rest;
    if (!id || id.startsWith("--")) throw new Error(REFINE_USAGE);
    const flags = {};
    for (let i = 0; i < args2.length; i++) {
      const name = args2[i];
      const value = args2[i + 1];
      if (name !== "--from" && name !== "--note") throw new Error(REFINE_USAGE);
      const already = name === "--from" ? flags.from : flags.note;
      if (!value || value.startsWith("--") || already !== void 0) throw new Error(REFINE_USAGE);
      if (name === "--from") flags.from = value;
      else flags.note = value;
      i++;
    }
    await options.beforeSend?.();
    return refineTask(client, id, flags);
  }
  if (cmd2 === "done") {
    const [id, ...args2] = rest;
    if (!id) throw new Error("done needs: <id> --summary <text> --commit <sha>... --tests <text> [--contract <text>]");
    const flag = (name) => {
      const at = args2.indexOf(name);
      return at < 0 ? void 0 : args2[at + 1];
    };
    const commits = [];
    for (let i = 0; i < args2.length; i++) if (args2[i] === "--commit" && args2[i + 1] && !args2[i + 1].startsWith("--")) commits.push(args2[++i]);
    const summary = flag("--summary"), tests = flag("--tests"), contract = flag("--contract"), changes = flag("--behaviour-changes");
    if (!summary || !tests || !commits.length) throw new Error("done needs --summary, --commit and --tests");
    const task = await completeTask(client, id, options.repo ?? "", summary, { commits, tests, ...contract ? { contract } : {} }, changes);
    if (!options.conflicts) return { task };
    try {
      const branch = (await client.team()).find((p) => p.id === client.participantId)?.workspace?.branch;
      const report = await options.conflicts(branch);
      if (report.conflicts.length) await client.send("all", { text: `${id} merge conflicts: ${report.conflicts.map((p) => `${p.branches.join(" vs ")}: ${p.files.join(", ")}`).join("; ")}` });
      return { task, conflicts: report.conflicts };
    } catch (error) {
      return { task, conflicts_error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (cmd2 === "block") {
    const [id, ...args2] = rest;
    const at = args2.indexOf("--reason");
    if (!id || at < 0 || !args2[at + 1]) throw new Error("block needs: <id> --reason <text>");
    return { task: await blockTask(client, id, args2.slice(at + 1).join(" ")) };
  }
  if (cmd2 === "unblock") {
    if (!rest[0]) throw new Error("unblock needs: <id>");
    return { task: await unblockTask(client, rest[0]) };
  }
  if (cmd2 === "send") {
    const [toRaw, ...args2] = rest;
    const words = [];
    let andWait = false, replyTo, expectsReply = false, kind;
    for (let i = 0; i < args2.length; i++) {
      if (args2[i] === "--wait") andWait = true;
      else if (args2[i] === "--expect-reply") expectsReply = true;
      else if (args2[i] === "--reply-to") replyTo = args2[++i];
      else if (args2[i] === "--kind") {
        const parsed = kinds(args2[++i] ?? "");
        if (parsed.length !== 1) throw new Error("send --kind needs one kind");
        kind = parsed[0];
      } else words.push(args2[i]);
    }
    if (!toRaw || !words.length) throw new Error("send needs: <to> <text or json_body> [--reply-to <id>] [--expect-reply] [--wait]");
    const to = options.recipientList && toRaw.includes(",") ? toRaw.split(",").map((s) => s.trim()) : options.recipientList ? toRaw.trim() : toRaw;
    await options.beforeSend?.();
    const sendOptions = { replyTo, expectsReply: expectsReply || kind === "question" || kind === "blocker", kind };
    const sent = await client.send(to, parseRoomBody(words.join(" ")), sendOptions);
    return andWait ? { sent, ...await waitRoom(client, options.waitDefault, {}, prefix) } : sent;
  }
  if (cmd2 === "compare") {
    const [a, b, ...args2] = rest;
    let criteria;
    let andWait = false;
    for (let i = 0; i < args2.length; i++) {
      if (args2[i] === "--criteria") criteria = (args2[++i] ?? "").split(",").map((criterion) => criterion.trim()).filter(Boolean);
      else if (args2[i] === "--wait") andWait = true;
      else throw new Error(COMPARE_USAGE);
    }
    if (!a || !b || a.startsWith("--") || b.startsWith("--") || !criteria?.length) throw new Error(COMPARE_USAGE);
    await options.beforeSend?.();
    const sent = await client.send("all", { a, b, criteria }, { intent: COMPARE_INTENTS.request, kind: "question", expectsReply: true });
    return andWait ? { sent, ...await waitRoom(client, options.waitDefault, {}, prefix) } : sent;
  }
  if (cmd2 === "verdict") {
    const [target, winnerRaw, ...args2] = rest;
    let reason, replyTo;
    for (let i = 0; i < args2.length; i++) {
      if (args2[i] === "--reason") {
        const words = [];
        for (i++; i < args2.length && !args2[i].startsWith("--"); ) words.push(args2[i++]);
        reason = words.join(" ");
        i--;
      } else if (args2[i] === "--reply-to") replyTo = args2[++i];
      else throw new Error(VERDICT_USAGE);
    }
    if (!target || target.startsWith("--") || !winnerRaw || winnerRaw.startsWith("--")) throw new Error(VERDICT_USAGE);
    const winner = compareWinner(winnerRaw);
    if (!reason) throw new Error(VERDICT_USAGE);
    await options.beforeSend?.();
    return client.send("all", { of: target, winner, reason }, { intent: COMPARE_INTENTS.verdict, kind: "finding", ...replyTo ? { replyTo } : {} });
  }
  if (cmd2 === "read" || cmd2 === "inbox") {
    return roomReplyHints(await client.read({ all: options.readAll || cmd2 === "inbox", includeSelf: true }), prefix);
  }
  if (cmd2 === "wait") {
    let timeout;
    const filter = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--from") filter.from = (rest[++i] ?? "").split(",").map((name) => options.trimWaitFrom ? name.trim() : name).filter(Boolean);
      else if (rest[i] === "--board") filter.board = rest[++i] ?? "";
      else if (rest[i] === "--kind") filter.kind = kinds(rest[++i] ?? "");
      else if (rest[i] === "--no-system") filter.system = false;
      else timeout = rest[i];
    }
    const seconds = timeout === void 0 ? options.waitDefault : options.parseWaitFallback ? Number(timeout) || options.waitDefault : timeout ? Number(timeout) : void 0;
    return waitRoom(client, seconds, filter, prefix);
  }
  if (cmd2 === "board") return client.board();
  if (cmd2 === "board_set") {
    const [key2, valueJson, ifVersion] = rest;
    if (!key2 || !valueJson) throw new Error("board_set needs: <key> <json_value> [if_version]");
    return client.setBoardKey(key2, JSON.parse(valueJson), { ifVersion: ifVersion === void 0 ? void 0 : Number(ifVersion) });
  }
  if (cmd2 === "board_patch") {
    const [valueJson, ifVersionsJson] = rest;
    if (!valueJson) throw new Error("board_patch needs: <json_values> [if_versions_json]");
    return client.patchBoard(JSON.parse(valueJson), { ifVersions: ifVersionsJson ? JSON.parse(ifVersionsJson) : void 0 });
  }
  if (cmd2 === "board_delete") {
    const [key2, ifVersion] = rest;
    if (!key2) throw new Error("board_delete needs: <key> [if_version]");
    return client.deleteBoardKey(key2, { ifVersion: ifVersion === void 0 ? void 0 : Number(ifVersion) });
  }
  if (cmd2 === "unassign") {
    const [id, ...noteWords] = rest;
    if (!id) throw new Error("unassign needs: <task id> [note]");
    const note = noteWords.join(" ").trim() || void 0;
    const team = await client.team();
    const me = team.find((p) => p.id === client.participantId);
    if (me?.role !== "host") {
      const hostId = (await client.status()).room.host_id;
      if (hostId !== client.participantId) throw new Error(`unassign is host only: ask ${hostId} to unassign ${id}`);
    }
    const board = await client.board();
    const entry = board.board[`task.${id}`];
    if (!entry) throw new Error(`task ${id} does not exist`);
    const task = entry.value;
    if (!task.assigned_by) {
      throw new Error(`task ${id} was not assigned (no assigned_by field)`);
    }
    if (task.evidence) {
      throw new Error(`task ${id} has evidence (already completed, cannot unassign)`);
    }
    const { owner, assigned, assigned_by, assigned_at, assigned_reason, ...taskRest } = task;
    const unassigned = {
      ...taskRest,
      status: "open",
      ...note ? { assigned_reason: note } : {}
    };
    await client.setBoardKey(`task.${id}`, unassigned, { ifVersion: entry.version });
    return { task: unassigned };
  }
  if (cmd2 === "status") {
    const [state, status] = rest;
    if (!state || !status) throw new Error("status needs: <free|busy> <status_text>");
    return client.updateStatus(state, status);
  }
  if (cmd2 === "webhook") {
    const [url] = rest;
    if (!url) throw new Error("webhook needs: <https_url|off>");
    const result = await client.setWebhook(url === "off" ? null : url);
    return options.webhookResult === "helper" ? { ok: true, webhook: url === "off" ? "off (poll with read/watch)" : url } : result;
  }
  if (cmd2 === "participants") return client.participants();
  if (cmd2 === "room_status") return client.status();
  if (cmd2 === "transition") {
    if (!rest[0]) throw new Error("transition needs: <event>");
    return client.transition(rest[0]);
  }
  if (cmd2 === "host") {
    if (!rest[0]) throw new Error("host needs: <participant to make host>");
    return client.transferHost(rest[0]);
  }
  throw new Error(`unknown room command: ${cmd2}`);
}
async function runReservationCommand(client, cmd2, rest, options) {
  if (cmd2 === "reservations") return { reservations: await listReservations(client) };
  const at = rest.indexOf("--reason");
  if (cmd2 === "release") return { ok: true, reservations: await releasePaths(client, options.repo, (options.releaseReasonDelimiter && at >= 0 ? rest.slice(0, at) : rest).map(options.path)) };
  const paths = (at >= 0 ? rest.slice(0, at) : rest).map(options.path);
  if (options.requirePaths && !paths.length) throw new Error("reserve needs: <path>... [--reason text]");
  const reason = at >= 0 ? rest.slice(at + 1).join(" ") || void 0 : void 0;
  const reservations = await reservePaths(client, options.repo, paths, reason);
  return { ok: true, reservations, ...reservations.length ? {} : { message: "nobody shares your checkout: no reservation needed" } };
}
async function runProfileCommand(client, rest, options) {
  const target = rest[0] && !rest[0].startsWith("--") ? rest[0] : void 0;
  if (target) {
    const role = rest[1] === "--role" ? rest[2] : void 0;
    if (rest.length !== 3 || role !== "owner" && role !== "clear") throw new Error("profile <participant> needs --role owner|clear");
    await client.setParticipantRole(target, role === "owner" ? "owner" : null);
    return { ok: true, team: await client.team() };
  }
  const flag = (name) => {
    const at2 = rest.indexOf(name);
    return at2 >= 0 && rest[at2 + 1] && !rest[at2 + 1].startsWith("--") ? rest[at2 + 1] : void 0;
  };
  const profile = {};
  const at = rest.indexOf("--capabilities");
  if (at >= 0) profile.capabilities = (flag("--capabilities") || "").split(",").map((name) => name.trim()).filter(Boolean);
  const model = flag("--model") || options.modelFallback;
  const provider = flag("--provider") || options.providerFallback;
  if (model) profile.model = model;
  if (provider) profile.provider = provider;
  if (flag("--harness")) profile.harness = flag("--harness") === "clear" ? null : flag("--harness");
  if (flag("--display-name")) profile.display_name = flag("--display-name");
  if (flag("--role")) profile.role = flag("--role");
  if (rest.includes("--no-workspace")) {
    profile.workspace = null;
    profile.checkout = null;
  } else if (rest.includes("--workspace")) {
    if (options.secret === "resume-only") throw new Error(options.workspaceError);
    profile.workspace = options.workspace();
    profile.checkout = options.checkout?.();
  }
  if (Object.keys(profile).length) await client.setProfile(profile);
  return { ok: true, team: await client.team() };
}

// packages/sdk/src/node.ts
import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
function git(cwd, ...args2) {
  try {
    return execFileSync("git", args2, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || void 0;
  } catch {
    return void 0;
  }
}
function localStateDir(cwd = process.cwd()) {
  if (process.env.J01N_KEY_DIR) {
    mkdirSync(process.env.J01N_KEY_DIR, { recursive: true, mode: 448 });
    return process.env.J01N_KEY_DIR;
  }
  const path = realpathSync(cwd);
  if (path !== "/Volumes" && !path.startsWith("/Volumes/")) return ".";
  const dir = join(homedir(), ".config", "j01n", "rooms", createHash("sha256").update(path).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 448 });
  return dir;
}
function detectWorkspace(joinSecret, roomId, cwd = process.cwd(), host = hostname()) {
  const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel") || resolve(cwd));
  const url = pathToFileURL(root);
  url.hostname = host;
  const key2 = hkdfSync("sha256", joinSecret, roomId, "j01n.me checkout v1", 32);
  const checkout = createHmac("sha256", Buffer.from(key2)).update(url.href).digest("base64url");
  const repo2 = git(cwd, "remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//");
  const branch = git(cwd, "branch", "--show-current");
  return { workspace: { path: root, host, ...repo2 ? { repo: repo2 } : {}, ...branch ? { branch } : {} }, checkout };
}

// packages/sdk/src/conflicts-node.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function git2(root, ...args2) {
  return execFileSync2("git", args2, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function conflictedFilesFromOutput(output2) {
  const files = /* @__PURE__ */ new Set();
  for (const match of output2.matchAll(/^\d{6} [0-9a-f]+ [123]\t(.+)$/gm)) files.add(match[1]);
  for (const match of output2.matchAll(/^CONFLICT .*: Merge conflict in (.+)$/gm)) files.add(match[1]);
  let block = null;
  const close = () => {
    if (block?.saw_our && block.saw_their && block.file) files.add(block.file);
    block = null;
  };
  for (const line of output2.split("\n")) {
    if (line === "changed in both") {
      close();
      block = {};
      continue;
    }
    if (line === "simple conflict") {
      close();
      block = { saw_our: true, saw_their: true };
      continue;
    }
    if (block && /^(?:merged|added in (?:both|local|remote)|removed in (?:local|remote)|unchanged|missing (?:local|remote))$/.test(line)) {
      close();
      continue;
    }
    if (!block) continue;
    const header = line.match(/^ {2}(?:base|our|their)\s+\d{6} [0-9a-f]+ (.+)$/);
    if (header && !block.file) block.file = header[1];
    else if (/^\+?<<<<<<< \.our$/.test(line)) block.saw_our = true;
    else if (/^\+?>>>>>>> \.their$/.test(line)) block.saw_their = true;
  }
  close();
  return files;
}
async function checkConflicts(client, root, finishedBranch) {
  const repo2 = (() => {
    try {
      return git2(root, "remote", "get-url", "origin").replace(/\/\/[^@/]+@/, "//");
    } catch {
      return git2(root, "rev-parse", "--show-toplevel");
    }
  })();
  const team = await client.team();
  const branches = /* @__PURE__ */ new Set();
  for (const task of await listTasks(client)) {
    const participant = team.find((p) => p.id === task.owner);
    if (participant?.workspace?.repo === repo2 && participant.workspace.branch) branches.add(participant.workspace.branch);
    else if (task.worktree) {
      try {
        if (git2(task.worktree, "remote", "get-url", "origin").replace(/\/\/[^@/]+@/, "//") === repo2) branches.add(git2(task.worktree, "branch", "--show-current"));
      } catch {
      }
    }
  }
  if (finishedBranch) branches.add(finishedBranch);
  const existing = [...branches].filter((branch) => {
    try {
      git2(root, "rev-parse", "--verify", `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }).sort();
  const main2 = ["main", "origin/main"].find((branch) => {
    try {
      git2(root, "rev-parse", "--verify", branch === "main" ? "refs/heads/main" : "refs/remotes/origin/main");
      return true;
    } catch {
      return false;
    }
  });
  if (!main2) throw new Error("conflicts needs a local main or origin/main ref");
  const comparisons = [];
  for (let i = 0; i < existing.length; i++) {
    for (const other of [main2, ...existing.slice(i + 1)]) {
      if (other === existing[i] || finishedBranch && existing[i] !== finishedBranch && other !== finishedBranch) continue;
      const pair = [existing[i], other];
      let output2;
      try {
        output2 = git2(root, "merge-tree", "--write-tree", ...pair);
      } catch (error) {
        const e = error;
        if (e.status === 1) output2 = e.stdout || "";
        else if (e.status === 128 || (e.stderr || "").includes("unknown rev")) {
          const base2 = git2(root, "merge-base", ...pair);
          output2 = git2(root, "merge-tree", base2, ...pair);
        } else throw new Error(`merge-tree ${pair.join(" vs ")}: ${e.stderr || String(error)}`);
      }
      const files = [...conflictedFilesFromOutput(output2)].sort();
      comparisons.push({ branches: pair, files });
    }
  }
  return { branches: existing, comparisons, conflicts: comparisons.filter((pair) => pair.files.length > 0) };
}

// packages/helper/src/cli.ts
if (!globalThis.crypto) globalThis.crypto = webcrypto;
var args = process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== "--");
var cmd = args[0];
var output = (value) => console.log(JSON.stringify(value, null, 2));
var names = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);
var base = (process.env.BASE_URL || "https://j01n.me").replace(/\/$/, "");
var safe = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
var stateDir = localStateDir();
var activeDir = join2(stateDir, ".j01n-rooms");
var activePath = (url, me) => `${activeDir}/${createHash2("sha256").update(url + "\0" + me).digest("hex")}.json`;
var isUrl = (value) => !!value && /^https?:/.test(value);
var git3 = (...argv) => {
  try {
    return execFileSync3("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || void 0;
  } catch {
    return void 0;
  }
};
var repo = () => {
  const root = git3("rev-parse", "--show-toplevel") || process.cwd();
  return { root, id: git3("remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//") || root };
};
var modelProfileFlag = (rest, name) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : void 0;
};
var declaredHarness = (rest) => process.env.J01N_PEER_ROLE ? process.env.J01N_HARNESS : modelProfileFlag(rest, "--harness") || process.env.J01N_HARNESS;
var modelProfile = (rest) => {
  const flag = (name) => modelProfileFlag(rest, name);
  const inherited = process.env.J01N_PEER_ROLE && process.env.J01N_HARNESS === "claude" ? void 0 : process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL;
  const model = flag("--model") || process.env.J01N_MODEL || inherited;
  const provider = flag("--provider") || process.env.J01N_PROVIDER;
  return { ...model ? { model } : {}, ...provider ? { provider } : {} };
};
var USAGE_REPORT_FLAGS = {
  "--active": { field: "active_ms", number: true, scale: 6e4 },
  "--active-ms": { field: "active_ms", number: true },
  "--active-minutes": { field: "active_ms", number: true, scale: 6e4 },
  "--input-tokens": { field: "input_tokens", number: true },
  "--output-tokens": { field: "output_tokens", number: true },
  "--cost": { field: "cost_usd", number: true },
  "--cost-usd": { field: "cost_usd", number: true },
  "--model": { field: "model" },
  "--provider": { field: "provider" },
  "--at": { field: "at" }
};
var usageHelp = (command) => `${command} [--active <minutes> | --active-ms N | --active-minutes N] [--tokens <in,out> | --input-tokens N --output-tokens N] [--cost <usd> | --cost-usd X] [--model M] [--provider P] [--at ISO]`;
function usageDeltaFromFlags(args2) {
  const delta = {};
  const put = (name, field, value) => {
    if (delta[field] !== void 0) throw Error(`usage report ${name} conflicts with another ${field.replace(/_/g, "-")} flag`);
    delta[field] = value;
  };
  const number = (name, raw, scale = 1) => {
    const parsed = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(parsed)) throw Error(`usage report ${name} needs a number, got "${raw}"`);
    return scale === 1 ? parsed : Math.round(parsed * scale);
  };
  for (let i = 0; i < args2.length; i++) {
    const name = args2[i];
    if (!name.startsWith("--")) throw Error(`usage report takes "<flag> <value>" pairs only, got the argument "${name}"`);
    const value = args2[++i];
    if (value === void 0 || value.startsWith("--")) throw Error(`usage report ${name} needs a value`);
    if (name === "--tokens") {
      const parts = value.split(",");
      if (parts.length !== 2 || parts.some((part) => part.trim() === "")) throw Error(`usage report --tokens needs "<in,out>", got "${value}"`);
      put(name, "input_tokens", number(name, parts[0]));
      put(name, "output_tokens", number(name, parts[1]));
      continue;
    }
    const spec = USAGE_REPORT_FLAGS[name];
    if (!spec) throw Error(`unknown usage flag: ${name}
Usage: ${usageHelp("usage report")}`);
    put(name, spec.field, spec.number ? number(name, value, spec.scale) : value);
  }
  if (!Object.keys(delta).length) throw Error(`usage report needs at least one flag
Usage: ${usageHelp("usage report")}`);
  return parseUsageDelta(delta);
}
var roomCommand = (client, command, rest, beforeSend) => runRoomCommand(client, command, rest, { prefix: "node .j01n/j01n.js", readAll: true, waitDefault: 50, parseWaitFallback: true, trimWaitFrom: true, webhookResult: "helper", beforeSend, repo: repo().id, conflicts: (branch) => checkConflicts(client, repo().root, branch) });
async function isRoomRef(ref) {
  if (!ref) return false;
  if (ref.trim().startsWith("{")) return true;
  try {
    const v = JSON.parse(await fs.readFile(ref, "utf8"));
    return v && typeof v === "object" && ["access", "room_url", "join_secret", "participant_token"].some((k) => k in v);
  } catch {
    return false;
  }
}
async function activeRooms() {
  const files = await fs.readdir(activeDir).catch(() => []);
  const rooms = [];
  for (const file of files.filter((n) => /^[0-9a-f]{64}\.json$/.test(n))) {
    const room = JSON.parse(await fs.readFile(`${activeDir}/${file}`, "utf8"));
    if (typeof room.room_url !== "string" || typeof room.participant_id !== "string" || activePath(room.room_url, room.participant_id) !== `${activeDir}/${file}`) throw Error(`invalid active-room file ${file}; rejoin with the room link`);
    rooms.push(room);
  }
  return rooms;
}
async function remember(url, me) {
  await fs.mkdir(activeDir, { recursive: true, mode: 448 });
  const path = activePath(url, me);
  await fs.writeFile(`${path}.${process.pid}.tmp`, JSON.stringify({ room_url: url, participant_id: me }), { mode: 384 });
  await fs.rename(`${path}.${process.pid}.tmp`, path);
}
async function resolveRoom() {
  const env = process.env;
  const envRoom = env.ROOM_URL && (env.PARTICIPANT_TOKEN || env.JOIN_SECRET) && env.ME;
  if (envRoom && (cmd === "send" && args.length <= 3 || cmd === "join" && (!args[1] || args[1].startsWith("--")) || ["read", "team", "inbox", "watch", "doctor"].includes(cmd || "") && args.length === 1)) return { roomUrl: env.ROOM_URL, secret: env.PARTICIPANT_TOKEN || env.JOIN_SECRET, token: env.PARTICIPANT_TOKEN, joinSecret: env.JOIN_SECRET, me: env.ME, rest: args.slice(1) };
  const link = parseInviteLink(args[1] || "");
  if (link) return { roomUrl: link.access, secret: link.join_secret, joinSecret: link.join_secret, me: args[2], rest: args.slice(3) };
  if (isUrl(args[1])) return { roomUrl: args[1], secret: args[2], token: cmd === "join" ? void 0 : args[2], positionalSecret: args[2], me: args[3], rest: args.slice(4) };
  if (await isRoomRef(args[1])) {
    const ref = args[1].trim().startsWith("{") ? args[1] : await fs.readFile(args[1], "utf8");
    const invite = JSON.parse(ref);
    const roomUrl = invite.access || invite.follow || invite.room_url;
    if (!roomUrl) throw Error("profile must include access");
    if (invite.participant_token) {
      const me = invite.participant_id || invite.me;
      return { roomUrl, secret: invite.participant_token, token: invite.participant_token, joinSecret: invite.join_secret, me, rest: args.slice(args[2] === me ? 3 : 2) };
    }
    if (!invite.join_secret) throw Error("invite must include access and join_secret");
    return { roomUrl, secret: invite.join_secret, joinSecret: invite.join_secret, me: args[2], rest: args.slice(3) };
  }
  const rooms = await activeRooms();
  if (rooms.length > 1) throw Error("several rooms are active in this directory; pass the room link or participant profile");
  if (rooms.length) return { roomUrl: rooms[0].room_url, secret: "resume-only", me: rooms[0].participant_id, rest: args.slice(1) };
  if (args[1]) throw Error(`ENOENT: cannot read invitation ${args[1]}`);
  return { roomUrl: env.ROOM_URL || "", secret: env.PARTICIPANT_TOKEN || env.JOIN_SECRET || "", token: env.PARTICIPANT_TOKEN, joinSecret: env.JOIN_SECRET, me: env.ME || "", rest: args.slice(1) };
}
async function agents() {
  let me = args[1];
  const rest = args.slice(me ? 2 : 1);
  if (!me) {
    const seeds = (await fs.readdir(stateDir).catch(() => [])).filter((n) => /^\.j01n-agent-[a-z0-9_-]+\.json$/.test(n)).map((n) => n.slice(".j01n-agent-".length, -".json".length));
    if (seeds.length !== 1) throw Error("usage: j01n register <me> [allowed,agents] | allow <me> <allowed,agents> | invite <me> <to> <room link> | invites <me> | listen <me> [timeout]" + (seeds.length > 1 ? ` (several seeded identities: ${seeds.join(", ")})` : " (no seeded identity in this directory)"));
    me = seeds[0];
  }
  const file = join2(stateDir, `.j01n-agent-${safe(me)}.json`);
  if (cmd === "register") {
    const identity2 = await registerAgent(base, me, names(rest[0]));
    await fs.writeFile(file, JSON.stringify(identity2, null, 2), { mode: 384 });
    output({ ok: true, address: `${base}/a/${me}`, accept_from: names(rest[0]), identity_file: file });
    return;
  }
  const identity = JSON.parse(await fs.readFile(file, "utf8").catch(() => {
    throw Error(`no agent identity ${file}; run: register ${me} [allowed,agents]`);
  }));
  if (cmd === "allow") output(await setAcceptFrom(identity, names(rest[0])));
  if (cmd === "invite") {
    if (!rest[0] || !rest[1]) throw Error("invite needs: <me> <to> <room link>");
    output(await inviteAgent(identity, rest[0], rest[1]));
  }
  if (cmd === "invites") {
    const response = await fetch(`${identity.base}/a/${encodeURIComponent(me)}/invites`, { headers: { authorization: `Bearer ${identity.agentToken}` } });
    if (!response.ok) throw Error(await response.text());
    const result = await response.json();
    output((result.invites || []).map(({ id, from, created_at }) => ({ id, from, created_at })));
  }
  if (cmd === "listen") {
    const as = rest.indexOf("--as");
    const participant = process.env.J01N_PEER_PARTICIPANT_ID || (as >= 0 ? rest[as + 1] : me);
    if (!participant || !/^[a-z][a-z0-9_-]{0,31}$/.test(participant)) throw Error("--as needs a valid room participant id");
    const flags = rest.filter((arg, i) => !/^\d+$/.test(arg) && (as < 0 || i !== as && i !== as + 1));
    const role = process.env.J01N_PEER_ROLE;
    if (role) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(role) || role === "owner" || role === "host") throw Error("invalid or reserved peer role");
      if (!process.env.J01N_PEER_SKILLS || !process.env.J01N_PEER_SKILLS.split(",").every((name) => /^[a-z][a-z0-9_-]*$/.test(name))) throw Error("spawned peer needs validated skill names");
      for (const name of ["--role", "--skills", "--model", "--provider", "--harness"]) {
        let index;
        while ((index = flags.indexOf(name)) >= 0) flags.splice(index, 2);
      }
      flags.push("--role", role, "--skills", process.env.J01N_PEER_SKILLS);
    }
    const pending = await waitForInvites(identity, Number(rest.find((arg) => /^\d+$/.test(arg))) || 50);
    if (!pending.length) {
      output({ timeout: true });
      return;
    }
    const invite = pending[0];
    const room = parseInviteLink(invite.room_link);
    if (!room?.access || !room.join_secret) throw Error("invalid room invitation");
    const assignedRoom = process.env.J01N_PEER_ROOM_ID;
    if (assignedRoom && room.access.split("/").pop() !== assignedRoom) throw Error("invitation is for a different room");
    await deleteInvite(identity, invite.id);
    const joined = JSON.parse(execFileSync3(process.execPath, [process.argv[1], "join", ...flags], { encoding: "utf8", env: { ...process.env, PARTICIPANT_TOKEN: "", ROOM_URL: room.access, JOIN_SECRET: room.join_secret, ME: participant } }));
    if (role) {
      delete joined.participant_token;
      delete joined.key_file;
    }
    output({ invited_by: invite.from, ...joined });
  }
}
async function main() {
  if (cmd === "create") {
    const url = isUrl(args[1]) ? args[1] : base;
    const optionsIndex = isUrl(args[1]) ? 2 : 1;
    const joinHost = args[optionsIndex + 1] === "--join";
    if (args.length > optionsIndex + (joinHost ? 2 : 1)) throw Error("create needs: <options-json> [--join]");
    const options = JSON.parse(args[optionsIndex] || "{}");
    if (joinHost && (typeof options.host_id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(options.host_id))) throw Error("create --join needs a valid host_id");
    let specText;
    if (options.spec !== void 0) {
      if (typeof options.spec !== "string" || !options.spec) throw Error("create spec needs a Markdown file path");
      if (typeof options.host_id !== "string" || !options.host_id) throw Error("create spec needs host_id (the host joins to post the sealed spec)");
      if (options.tasks !== void 0 || options.template !== void 0 && options.template !== "sprint") throw Error("create spec cannot override tasks or sprint template");
      specText = await fs.readFile(options.spec, "utf8");
      options.tasks = parseSprintSpec(specText);
      options.template = "sprint";
      delete options.spec;
    }
    const session2 = joinHost ? await createSdkCryptoSession(options.host_id) : void 0;
    if (session2) options.host_public_key = (await session2.announceKeyBody()).public_key;
    const response = await fetch(`${url.replace(/\/$/, "")}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(options) });
    const text2 = await response.text();
    if (!response.ok) throw Error(joinHost ? `failed to create room (${response.status})` : text2);
    if (session2) {
      const invite2 = normalizeInvite(JSON.parse(text2));
      if (!invite2.host_joined || typeof invite2.cursor !== "number" || !invite2.participant_token) throw Error("room service did not auto-join the host; private invitation withheld (room will expire)");
      const client2 = await buildRoomClient(invite2, options.host_id, invite2.cursor, session2);
      const keyFile2 = join2(stateDir, `.j01n-${safe(new URL(invite2.room_url).pathname)}-${safe(options.host_id)}.json`);
      try {
        await fs.writeFile(keyFile2, JSON.stringify({ ...await session2.exportKeyPair(), peers: {}, participantToken: invite2.participant_token, joinSecret: invite2.join_secret, roomUrl: invite2.room_url }), { mode: 384 });
        await remember(invite2.room_url, options.host_id);
      } catch {
        await client2.close().catch(() => void 0);
        await fs.rm(keyFile2, { force: true });
        await fs.rm(activePath(invite2.room_url, options.host_id), { force: true });
        throw Error("could not save the host identity; room closed or will expire");
      }
      if (specText !== void 0) await client2.send("all", { encrypted_payload: await sealForRoom(specText, invite2.join_secret, invite2.room_id) }, { intent: "kickoff", plain: true });
      output({ room_id: invite2.room_id, participant_id: options.host_id, host_joined: true });
      return;
    }
    if (specText !== void 0) {
      const invite2 = normalizeInvite(JSON.parse(text2));
      const me2 = options.host_id;
      const session3 = await createSdkCryptoSession(me2);
      const client2 = await joinRoom(invite2, me2, process.env.J01N_HARNESS ? { harness: process.env.J01N_HARNESS } : {}, session3);
      const keyFile2 = join2(stateDir, `.j01n-${safe(new URL(invite2.room_url).pathname)}-${safe(me2)}.json`);
      await fs.writeFile(keyFile2, JSON.stringify({ ...await session3.exportKeyPair(), peers: {}, participantToken: client2.invite.participant_token, joinSecret: invite2.join_secret, roomUrl: invite2.room_url }), { mode: 384 });
      await remember(invite2.room_url, me2);
      await client2.send("all", { encrypted_payload: await sealForRoom(specText, invite2.join_secret, invite2.room_id) }, { intent: "kickoff", plain: true });
    }
    console.log(text2);
    return;
  }
  if (["register", "allow", "invite", "invites", "listen"].includes(cmd || "")) {
    await agents();
    return;
  }
  const { roomUrl, secret, me, rest, token, joinSecret, positionalSecret } = await resolveRoom();
  if (!cmd || !roomUrl || !secret || !me) throw Error("usage: j01n <create|join|send|read|team|watch|doctor|extend> [invitation.json me | participant.j01n.json | access token me] [to] [json_body]\nTip: after join, use the participant .j01n.json profile or set ROOM_URL, PARTICIPANT_TOKEN, and ME.");
  const keyFile = join2(stateDir, `.j01n-${safe(new URL(roomUrl).pathname)}-${safe(me)}.json`);
  let state;
  try {
    state = JSON.parse(await fs.readFile(keyFile, "utf8"));
  } catch {
    state = { ...await createSdkCryptoSession(me).then((s) => s.exportKeyPair()), peers: {}, created: true };
  }
  const created = !!state.created;
  const session = await createSdkCryptoSession(me, state.privateJwk, state.publicJwk);
  const roomSecret = secret === "resume-only" ? state.joinSecret || secret : secret;
  const invite = buildMinimalInvite(roomUrl, roomSecret);
  invite.participant_token = token || state.participantToken;
  const save = async () => fs.writeFile(keyFile, JSON.stringify({ privateJwk: state.privateJwk, publicJwk: state.publicJwk, peers: state.peers || {}, participantToken: state.participantToken, joinSecret: state.joinSecret, announcedKey: state.announcedKey, roomUrl }, null, 2), { mode: 384 });
  if (created) await save();
  let client;
  if (cmd === "join") {
    try {
      client = await joinRoom(invite, me, declaredHarness(rest) ? { harness: declaredHarness(rest) } : {}, session);
      state.announcedKey = (await session.announceKeyBody()).public_key;
    } catch (error) {
      if (!(error instanceof RoomApiError && error.status === 409)) throw error;
      client = await resumeRoom(invite, me, session);
      if (!state.announcedKey) {
        await client.announceKey();
        state.announcedKey = (await session.announceKeyBody()).public_key;
      }
    }
    state.participantToken = client.invite.participant_token || state.participantToken;
    state.joinSecret = secret;
    await save();
  } else client = await resumeRoom(invite, me, session);
  const announce = async () => {
    const key2 = (await session.announceKeyBody()).public_key;
    if (state.announcedKey !== key2) {
      await client.announceKey();
      state.announcedKey = key2;
      await save();
    }
  };
  if (cmd === "join") {
    const announced = {};
    const i = rest.indexOf("--capabilities");
    if (i >= 0) announced.capabilities = names(rest[i + 1]);
    const k = rest.indexOf("--skills");
    if (k >= 0) announced.skills = names(rest[k + 1]);
    const d = rest.indexOf("--display-name");
    if (d >= 0 && rest[d + 1]) announced.display_name = rest[d + 1];
    const r = rest.indexOf("--role");
    if (r >= 0 && rest[r + 1]) announced.role = rest[r + 1];
    const mine = (await client.team()).find((p) => p.id === me);
    const harness = declaredHarness(rest);
    if (harness && mine?.harness !== harness) announced.harness = harness;
    const model = modelProfile(rest);
    if (model.model && model.model !== mine?.model) announced.model = model.model;
    if (model.provider && model.provider !== mine?.provider) announced.provider = model.provider;
    if (!rest.includes("--no-workspace")) {
      const detected = detectWorkspace(client.invite.join_secret, client.invite.room_id);
      if (JSON.stringify(detected.workspace) !== JSON.stringify(mine?.workspace)) announced.workspace = detected.workspace;
      if (detected.checkout !== mine?.checkout) announced.checkout = detected.checkout;
    }
    if (Object.keys(announced).length) await client.setProfile(announced);
    const profile = { access: roomUrl, participant_id: me, participant_token: state.participantToken, key_file: keyFile };
    await remember(roomUrl, me);
    let board = null;
    try {
      board = (await client.board()).board;
    } catch {
    }
    let kickoff = board?.kickoff?.value ?? null;
    const messages = await client.read({ all: true, includeSelf: true }).catch(() => []);
    const sealedKickoff = messages.find((m) => m.intent === "kickoff" && !m.decrypt_error)?.body;
    if (kickoff === null) kickoff = sealedKickoff ?? null;
    const spec = typeof sealedKickoff === "string" ? { spec: sealedKickoff } : {};
    output({ ...profile, kickoff, ...spec, board, ...notesAndDecisions(board ?? {}), questions: await client.openQuestions(), team: await client.team() });
    return;
  }
  if (cmd === "invite-link") {
    if (rest.length && (rest.length !== 1 || rest[0] !== "--open")) throw Error("invite-link needs: [--open]");
    if ((await client.status()).room.host_id !== me) throw Error("invite-link is host only");
    if (!state.joinSecret || state.joinSecret === "resume-only") throw Error("room link unavailable in local key file; rejoin with the invitation");
    const link = inviteLink(roomUrl, state.joinSecret);
    if (rest.includes("--open")) execFileSync3("open", [link], { stdio: "ignore" });
    output({ invite_link: link, ...rest.includes("--open") ? { opened: true } : {} });
    return;
  }
  if (["send", "read", "inbox", "wait"].includes(cmd)) {
    output(await roomCommand(client, cmd, rest, cmd === "send" ? announce : void 0));
    return;
  }
  if (cmd === "team") {
    output({ ok: true, team: await client.team() });
    return;
  }
  if (cmd === "watch") {
    await announce();
    let seq = Number(rest[0] || 0);
    if (!Number.isFinite(seq)) seq = 0;
    const print = async (event) => {
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
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (event === "ping" || event === "ready") continue;
        if (event === "message") await print("message");
        else if (event === "changed") await print("message");
        else {
          const text2 = data.join("\n");
          let parsed = text2 || void 0;
          try {
            parsed = JSON.parse(text2);
          } catch {
          }
          output({ event, data: parsed });
        }
      }
    }
    return;
  }
  if (cmd === "doctor") {
    const participants = await client.participants().catch(() => ({ participants: [] }));
    const joined = participants.participants.some((p) => p.id === me);
    if (joined) await announce().catch(() => void 0);
    const raw = joined ? await request(`${roomUrl}/?view=all&include_self=true`, client.invite, { participantId: me }) : { messages: [] };
    const messages = joined ? await client.read({ all: true, includeSelf: true }) : [];
    const encrypted = raw.messages.filter((m) => m.body?.encrypted);
    const decryptable = encrypted.filter((m) => !messages.find((opened) => opened.id === m.id)?.decrypt_error).length;
    let openQuestions = null;
    let openQuestionsError = joined ? void 0 : "not joined";
    if (joined) try {
      openQuestions = (await client.openQuestions()).length;
    } catch (err) {
      openQuestionsError = String(err);
    }
    output({ ok: joined, client_protocol: SDK_CLIENT_PROTOCOL, ...getClientUpdateNotice() ? { client_update: getClientUpdateNotice() } : {}, open_questions: openQuestions, ...openQuestionsError ? { open_questions_error: openQuestionsError } : {}, participant_id: me, joined, key_file: keyFile, local_key_created: created, key_announced: messages.some((m) => m.from === me && m.intent === "key.exchange"), known_peers: participants.participants.filter((p) => p.id !== me && p.public_key).map((p) => p.id), encrypted_messages_seen: encrypted.length, encrypted_messages_decryptable: decryptable, key_note: `Reuse this key file from the same directory to retain your ECDH keypair across sessions: ${keyFile}` });
    return;
  }
  if (cmd === "kickoff") {
    if (!rest.length) throw Error("kickoff needs: <text or json>; run it with the room link or invitation (it needs the join secret)");
    output(await client.send("all", { encrypted_payload: await sealForRoom(parseRoomBody(rest.join(" ")), roomSecret, invite.room_id) }, { intent: "kickoff", plain: true }));
    return;
  }
  if (["webhook", "tasks", "claim", "assign", "refine", "unassign", "done", "block", "unblock", "conflicts", "summary", "note", "decide", "compare", "verdict"].includes(cmd || "")) {
    output(await roomCommand(client, cmd, rest));
    return;
  }
  if (cmd === "profile") {
    output(await runProfileCommand(client, rest, {
      modelFallback: process.env.J01N_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL,
      providerFallback: process.env.J01N_PROVIDER,
      workspace: () => detectWorkspace(client.invite.join_secret, client.invite.room_id).workspace,
      checkout: () => detectWorkspace(client.invite.join_secret, client.invite.room_id).checkout,
      secret: roomSecret,
      workspaceError: "re-announcing the workspace needs the room link (it is sealed with the room key): profile <room link> <me> --workspace"
    }));
    return;
  }
  if (["reserve", "release", "reservations"].includes(cmd)) {
    const { root, id } = repo();
    output(await runReservationCommand(client, cmd, rest, {
      repo: id,
      path: (path) => relative(root, resolve2(path)) || ".",
      requirePaths: true,
      releaseReasonDelimiter: true
    }));
    return;
  }
  const sealSecret = [joinSecret, state.joinSecret, positionalSecret].find((value) => value && value !== "resume-only") || "";
  const usageClient = async (missing) => {
    if (!sealSecret) throw Error(missing);
    if (sealSecret === client.invite.join_secret) return client;
    const sealInvite = buildMinimalInvite(roomUrl, sealSecret);
    sealInvite.participant_token = token || state.participantToken;
    return resumeRoom(sealInvite, me, session);
  };
  if (cmd === "usage") {
    if (!sealSecret) throw Error("usage needs the room link or invitation (usage is sealed with the room key, and a participant token is not one): usage <room link> <me> [report ...], or run it in the directory that joined the room");
    const usageClientInstance = await usageClient("usage needs the room link or invitation (usage is sealed with the room key, and a participant token is not one): usage <room link> <me> [report ...], or run it in the directory that joined the room");
    const [sub, ...args2] = rest;
    if (sub === "report") {
      const row = await usageClientInstance.reportUsage(usageDeltaFromFlags(args2));
      output({ ok: true, participant: row.participant, key: row.key, version: row.version, snapshot: row.snapshot, line: formatUsageRow(row) });
      return;
    }
    if (sub !== void 0) throw Error(`unknown usage command: ${sub}; expected "report" or nothing
Usage: ${usageHelp("usage [report]")}`);
    const { rows, totals, reported, stale } = await usageClientInstance.usageReport();
    output({ rows, totals, reported, stale, lines: [...rows.map((row) => formatUsageRow(row)), formatUsage(totals, "room")] });
    return;
  }
  if (cmd === "report") {
    let outPath;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--out") {
        if (outPath !== void 0) throw Error("report takes one --out path");
        outPath = rest[++i];
        if (!outPath || outPath.startsWith("--")) throw Error("--out needs a file path");
      } else throw Error(`report needs: [--out <file>], got "${rest[i]}"`);
    }
    const [summary, messages, asks] = await Promise.all([
      roomCommand(client, "summary", []),
      client.read({ all: true, includeSelf: true }),
      client.openQuestions().catch(() => [])
    ]);
    const WINNERS = ["A", "B", "tie"];
    const verdicts = messages.filter((m) => m.intent === "compare.verdict").map((m) => {
      const body = m.body ?? {};
      return {
        seq: Number(m.seq ?? 0),
        by: m.from,
        of: typeof body.of === "string" ? body.of : null,
        winner: WINNERS.includes(String(body.winner)) ? String(body.winner) : null,
        reason: typeof body.reason === "string" ? body.reason : null
      };
    });
    const tasks = summary.tasks;
    const taskStats = {
      total: tasks.length,
      done: tasks.filter((t) => t.status === "done").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      all_have_evidence: tasks.length ? tasks.every((t) => (t.evidence?.commits?.length ?? 0) > 0) : null,
      all_contract_phrased: tasks.length ? tasks.every((t) => String(t.evidence?.contract ?? "").includes("check:contract --peer passed")) : null
    };
    let usage = null;
    try {
      const usageReader = await usageClient("usage needs the room link or invitation (usage is sealed with the room key, and a participant token is not one): usage <room link> <me> [report ...], or run it in the directory that joined the room");
      const { rows, totals } = await usageReader.usageReport();
      usage = { rows, totals };
    } catch {
    }
    const { id: repoId, root: repoRoot } = repo();
    const repoName = repoId ? repoId.split("/").pop()?.replace(/\.git$/, "") || repoId : repoRoot.split("/").pop() || repoRoot;
    const record = {
      generated_at: (/* @__PURE__ */ new Date()).toISOString(),
      family: `${repoName}:feature`,
      room: client.invite.room_id,
      repo: repoName,
      workers: summary.participants.length,
      tasks: taskStats,
      usage,
      open_asks: asks.length,
      verdicts
    };
    if (outPath) {
      await fs.mkdir(resolve2(outPath, ".."), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(record, null, 2));
      output({ ok: true, out: outPath, room: client.invite.room_id });
    } else {
      output(record);
    }
    return;
  }
  if (cmd === "leave") {
    await client.leave({ release: rest.includes("--release") });
    await fs.rm(activePath(roomUrl, me), { force: true });
    output({ ok: true, left: true });
    return;
  }
  if (cmd === "host") {
    output(await roomCommand(client, cmd, rest));
    return;
  }
  if (cmd === "extend") {
    if (rest.length > 1) throw Error("extend needs: [minutes]");
    let extendMs;
    if (rest[0] !== void 0) {
      const minutes = Number(rest[0]);
      if (!Number.isFinite(minutes) || minutes <= 0) throw Error(`extend minutes needs a positive number, got "${rest[0]}"`);
      extendMs = Math.round(minutes * 6e4);
    }
    if ((await client.status()).room.host_id !== me) throw Error("extend is host only; ask the host to run it");
    const extended = await client.extend(extendMs === void 0 ? void 0 : { extendMs });
    output({ ok: true, expires_at: extended.expires_at });
    return;
  }
  throw Error(`unknown command: ${cmd}. Usage: create|join|send|read|team|inbox|watch|wait|doctor|webhook|kickoff|profile|host|extend|reserve|release|reservations|tasks|claim|assign|refine|unassign|done|block|unblock|conflicts|summary|usage|report|invite-link|note|decide|leave`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
