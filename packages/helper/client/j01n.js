#!/usr/bin/env node
/* j01n.me standalone encrypted client. No npm deps.
   Quick start: curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js
   Commands: create, join, send, read, inbox, watch, wait, doctor, webhook, kickoff, profile, host, reserve, release, reservations, leave, register, allow, invite, invites, listen, team
*/

// packages/helper/src/cli.ts
import * as fs from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

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
function parseInviteLink(text) {
  const match = /^(https?:\/\/[^/\s]+)\/room\/([^/#?\s]+)#(\S+)$/.exec(text.trim());
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
  const response = await fetch(url, {
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
async function exportPublicKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
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
async function encryptWithKey(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    iv: base64Url(iv)
  };
}
async function decryptWithKey(key, ciphertextB64, ivB64) {
  const ciphertext = base64UrlToBytes(ciphertextB64);
  const iv = base64UrlToBytes(ivB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
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
function reservationFor(reservations, me, repo2, path) {
  return reservations.find((r) => r.by !== me && r.repo === repo2 && r.paths.some((p) => pathsOverlap(p, path)));
}
async function load(client) {
  const entry = (await client.board()).board[RESERVATIONS_KEY];
  const stored = entry?.value && typeof entry.value === "object" ? entry.value : {};
  const reservations = await Promise.all(Object.entries(stored).map(async ([id, r]) => {
    const opened = await openRoomSeal(r.sealed, client.invite.join_secret, client.invite.room_id).catch(() => null);
    return { id, by: r.by, since: r.since, repo: opened?.repo ?? "", paths: opened?.paths ?? [], ...opened?.reason ? { reason: opened.reason } : {} };
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
  return update(client, async ({ stored, reservations }) => {
    for (const path of paths) {
      const held = reservationFor(reservations, client.participantId, repo2, path);
      if (held) return new Error(`${path} is already reserved by ${held.by}${held.reason ? ` (${held.reason})` : ""}`);
    }
    const sealed = await sealForRoom({ repo: repo2, paths, ...reason ? { reason } : {} }, client.invite.join_secret, client.invite.room_id);
    return { ...stored, [crypto.randomUUID()]: { by: client.participantId, since: (/* @__PURE__ */ new Date()).toISOString(), sealed } };
  });
}
async function releasePaths(client, repo2, paths = []) {
  return update(client, async ({ stored, reservations }) => {
    const mine = reservations.filter((r) => r.by === client.participantId && (paths.length === 0 || r.repo === repo2 && r.paths.some((p) => paths.some((q) => pathsOverlap(p, q)))));
    if (mine.length === 0) return null;
    return Object.fromEntries(Object.entries(stored).filter(([id]) => !mine.some((r) => r.id === id)));
  });
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

// packages/sdk/src/room-client.ts
function boardKeyUrl(roomUrl, key, ifVersion) {
  return `${roomUrl}/board/${encodeURIComponent(key)}${ifVersion === void 0 ? "" : `?if_version=${ifVersion}`}`;
}
function shouldEncrypt(options) {
  return options.intent !== "key.exchange" && options.plain !== true;
}
function buildSendPayload(to, body, options) {
  return {
    to,
    body,
    reply_to: options.replyTo ?? null,
    intent: options.intent ?? "notify",
    priority: options.priority ?? "normal",
    ...options.expectsReply ? { expects_reply: true, ...options.replyByMinutes ? { reply_by_minutes: options.replyByMinutes } : {} } : {},
    ...Object.fromEntries(
      ["state", "status", "model", "skills"].map((k) => [k, options[k]]).filter(([, v]) => v !== void 0)
    )
  };
}
async function buildRoomClient(invite, participantId, initialCursor, cryptoSession) {
  let cursor = initialCursor;
  const session = cryptoSession ?? await createSdkCryptoSession(participantId);
  async function decryptAll(messages) {
    await session.processKeyExchange(messages);
    if (messages.some((msg) => isEncryptedBody(msg.body))) {
      const { participants = [] } = await client.participants();
      await session.processPeerKeys(participants.flatMap((p) => p.public_key ? [{ id: p.id, public_key: p.public_key }] : []));
    }
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
      if (shouldEncrypt(options)) await client.read({ all: true, includeSelf: true });
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
      return request(invite.api.participants, invite);
    },
    async updateStatus(state, status, opts = {}) {
      const { workspace: workspace2, ...profile } = opts;
      const sealed = workspace2 === void 0 ? {} : { workspace: workspace2 && await sealForRoom(workspace2, invite.join_secret, invite.room_id) };
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body: { state, status, ...profile, ...sealed } }
      );
    },
    async setProfile(profile) {
      const body = {};
      if (profile.capabilities !== void 0) body.capabilities = profile.capabilities;
      if (profile.model !== void 0) body.model = profile.model;
      if (profile.provider !== void 0) body.provider = profile.provider;
      if (profile.workspace !== void 0) body.workspace = profile.workspace && await sealForRoom(profile.workspace, invite.join_secret, invite.room_id);
      return request(
        `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
        invite,
        { method: "PATCH", participantId, body }
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
      return request(invite.api.board, invite);
    },
    async setBoardKey(key, value, options = {}) {
      return request(
        boardKeyUrl(invite.room_url, key, options.ifVersion),
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
    async deleteBoardKey(key, options = {}) {
      return request(
        boardKeyUrl(invite.room_url, key, options.ifVersion),
        invite,
        { method: "DELETE", participantId }
      );
    },
    async status() {
      return request(invite.api.status, invite);
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
    async extend(options = {}) {
      return request(
        invite.api.extend ?? `${invite.room_url}/extend`,
        invite,
        { method: "POST", participantId, body: options.extendMs === void 0 ? {} : { extend_ms: options.extendMs } }
      );
    },
    async export() {
      return request(`${invite.room_url}/export`, invite, { participantId });
    }
  };
  return client;
}

// packages/sdk/src/sdk.ts
async function joinRoom(inviteInput, participantId, opts = {}, existingSession) {
  const invite = normalizeInvite(inviteInput);
  const { workspace: workspace2, ...profile } = opts;
  const cryptoSession = existingSession ?? await createSdkCryptoSession(participantId);
  const publicKeyBody = await cryptoSession.announceKeyBody();
  const join = await request(
    `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
    invite,
    {
      method: "PUT",
      body: {
        ...profile,
        public_key: publicKeyBody.public_key,
        // Sealed with the room key: the server only stores ciphertext.
        ...workspace2 ? { workspace: await sealForRoom(workspace2, invite.join_secret, invite.room_id) } : {}
      }
    }
  );
  if (join.peers && join.peers.length > 0) {
    await cryptoSession.processPeerKeys(join.peers);
  }
  const roomInvite = { ...invite, participant_token: join.participant_token };
  const room = await buildRoomClient(roomInvite, participantId, join.cursor, cryptoSession);
  await room.announceKey();
  return room;
}
async function resumeRoom(invite, participantId, cryptoSession) {
  return buildRoomClient(normalizeInvite(invite), participantId, 0, cryptoSession);
}

// packages/helper/src/cli.ts
if (!globalThis.crypto) globalThis.crypto = webcrypto;
var args = process.argv.slice(2).filter((arg, i) => i !== 0 || arg !== "--");
var cmd = args[0];
var output = (value) => console.log(JSON.stringify(value, null, 2));
var names = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);
var base = (process.env.BASE_URL || "https://j01n.me").replace(/\/$/, "");
var safe = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
var activeDir = ".j01n-rooms";
var activePath = (url, me) => `${activeDir}/${createHash("sha256").update(url + "\0" + me).digest("hex")}.json`;
var isUrl = (value) => !!value && /^https?:/.test(value);
var git = (...argv) => {
  try {
    return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || void 0;
  } catch {
    return void 0;
  }
};
var repo = () => {
  const root = git("rev-parse", "--show-toplevel") || process.cwd();
  return { root, id: git("remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//") || root };
};
var workspace = () => ({ path: process.cwd(), ...git("remote", "get-url", "origin") ? { repo: git("remote", "get-url", "origin").replace(/\/\/[^@/]+@/, "//") } : {}, ...git("branch", "--show-current") ? { branch: git("branch", "--show-current") } : {} });
var modelProfile = (rest) => {
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : void 0;
  };
  return { ...flag("--model") || process.env.J01N_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL ? { model: flag("--model") || process.env.J01N_MODEL || process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || process.env.PI_MODEL || process.env.OPENCLAW_MODEL } : {}, ...flag("--provider") || process.env.J01N_PROVIDER ? { provider: flag("--provider") || process.env.J01N_PROVIDER } : {} };
};
var parseBody = (text) => {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
  }
  return { text };
};
var withReplies = (messages) => messages.map((m) => m.from === "system" || m.intent === "key.exchange" ? m : { ...m, reply: `node .j01n/j01n.js send ${m.from} <text> --reply-to ${m.id}` });
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
  if (envRoom && (cmd === "send" && args.length <= 3 || ["join", "read", "team", "inbox", "watch", "doctor"].includes(cmd || "") && args.length === 1)) return { roomUrl: env.ROOM_URL, secret: env.PARTICIPANT_TOKEN || env.JOIN_SECRET, token: env.PARTICIPANT_TOKEN, me: env.ME, rest: args.slice(1) };
  const link = parseInviteLink(args[1] || "");
  if (link) return { roomUrl: link.access, secret: link.join_secret, me: args[2], rest: args.slice(3) };
  if (isUrl(args[1])) return { roomUrl: args[1], secret: args[2], token: cmd === "join" ? void 0 : args[2], me: args[3], rest: args.slice(4) };
  if (await isRoomRef(args[1])) {
    const ref = args[1].trim().startsWith("{") ? args[1] : await fs.readFile(args[1], "utf8");
    const invite = JSON.parse(ref);
    const roomUrl = invite.access || invite.follow || invite.room_url;
    if (!roomUrl) throw Error("profile must include access");
    if (invite.participant_token) return { roomUrl, secret: invite.participant_token, token: invite.participant_token, me: invite.participant_id || invite.me, rest: args.slice(2) };
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
  const me = args[1];
  const rest = args.slice(2);
  if (!me) throw Error("usage: j01n register <me> [allowed,agents] | allow <me> <allowed,agents> | invite <me> <to> <room link> | invites <me> | listen <me> [timeout]");
  const file = `.j01n-agent-${safe(me)}.json`;
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
    const pending = await waitForInvites(identity, Number(rest[0]) || 50);
    if (!pending.length) {
      output({ timeout: true });
      return;
    }
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
    const text = await response.text();
    if (!response.ok) throw Error(text);
    console.log(text);
    return;
  }
  if (["register", "allow", "invite", "invites", "listen"].includes(cmd || "")) {
    await agents();
    return;
  }
  const { roomUrl, secret, me, rest, token } = await resolveRoom();
  if (!cmd || !roomUrl || !secret || !me) throw Error("usage: j01n <create|join|send|read|team|watch|doctor> [invitation.json me | participant.j01n.json | access token me] [to] [json_body]\nTip: after join, use the participant .j01n.json profile or set ROOM_URL, PARTICIPANT_TOKEN, and ME.");
  const keyFile = `.j01n-${safe(new URL(roomUrl).pathname)}-${safe(me)}.json`;
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
      client = await joinRoom(invite, me, {}, session);
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
    const key = (await session.announceKeyBody()).public_key;
    if (state.announcedKey !== key) {
      await client.announceKey();
      state.announcedKey = key;
      await save();
    }
  };
  const read = async () => withReplies(await client.read({ all: true, includeSelf: true }));
  const wait = async (timeout, from, board, system) => {
    const event = await client.wait({ timeoutSeconds: timeout, from, board, system });
    if (event.timeout) return { timeout: true };
    const messages = withReplies(await client.read());
    return { woke: event.event, ...event.changes ? { board: event.changes } : {}, messages };
  };
  if (cmd === "join") {
    const announced = {};
    const i = rest.indexOf("--capabilities");
    if (i >= 0) announced.capabilities = names(rest[i + 1]);
    const mine = (await client.team()).find((p) => p.id === me);
    const model = modelProfile(rest);
    if (model.model && model.model !== mine?.model) announced.model = model.model;
    if (model.provider && model.provider !== mine?.provider) announced.provider = model.provider;
    if (!rest.includes("--no-workspace") && JSON.stringify(workspace()) !== JSON.stringify(mine?.workspace)) announced.workspace = workspace();
    if (Object.keys(announced).length) await client.setProfile(announced);
    const profile = { access: roomUrl, participant_id: me, participant_token: state.participantToken, key_file: keyFile };
    await remember(roomUrl, me);
    let board = null;
    try {
      board = (await client.board()).board;
    } catch {
    }
    let kickoff = board?.kickoff?.value ?? null;
    if (kickoff === null) kickoff = (await client.read({ all: true, includeSelf: true })).find((m) => m.intent === "kickoff")?.body ?? null;
    output({ ...profile, kickoff, board, questions: await client.openQuestions(), team: await client.team() });
    return;
  }
  if (cmd === "send") {
    const [to, ...words] = rest;
    let andWait = false, expectsReply = false, replyTo;
    const body = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "--wait") andWait = true;
      else if (words[i] === "--expect-reply") expectsReply = true;
      else if (words[i] === "--reply-to") replyTo = words[++i];
      else body.push(words[i]);
    }
    if (!to || !body.length) throw Error("send needs: <to> <text or json_body> [--reply-to <id>] [--expect-reply] [--wait]");
    await announce();
    const sent = await client.send(to, parseBody(body.join(" ")), { replyTo, expectsReply });
    output(andWait ? { sent, ...await wait(50) } : sent);
    return;
  }
  if (cmd === "read" || cmd === "inbox") {
    output(await read());
    return;
  }
  if (cmd === "team") {
    output({ ok: true, team: await client.team() });
    return;
  }
  if (cmd === "wait") {
    let timeout = 50, from, board, system;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--from") from = names(rest[++i]);
      else if (rest[i] === "--board") board = rest[++i] || "";
      else if (rest[i] === "--no-system") system = false;
      else timeout = Number(rest[i]) || 50;
    }
    output(await wait(timeout, from, board, system));
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
          const text = data.join("\n");
          let parsed = text || void 0;
          try {
            parsed = JSON.parse(text);
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
    output(await client.send("all", { encrypted_payload: await sealForRoom(parseBody(rest.join(" ")), roomSecret, invite.room_id) }, { intent: "kickoff", plain: true }));
    return;
  }
  if (cmd === "webhook") {
    if (!rest[0]) throw Error("webhook needs: <https_url|off>");
    await client.setWebhook(rest[0] === "off" ? null : rest[0]);
    output({ ok: true, webhook: rest[0] === "off" ? "off (poll with read/watch)" : rest[0] });
    return;
  }
  if (cmd === "profile") {
    const body = { ...modelProfile(rest) };
    const i = rest.indexOf("--capabilities");
    if (i >= 0) body.capabilities = names(rest[i + 1]?.startsWith("--") ? "" : rest[i + 1]);
    if (rest.includes("--no-workspace")) body.workspace = null;
    else if (rest.includes("--workspace")) {
      if (roomSecret === "resume-only") throw Error("re-announcing the workspace needs the room link (it is sealed with the room key): profile <room link> <me> --workspace");
      body.workspace = workspace();
    }
    if (Object.keys(body).length) await client.setProfile(body);
    output({ ok: true, team: await client.team() });
    return;
  }
  if (cmd === "reserve" || cmd === "release") {
    const { root, id } = repo();
    const i = rest.indexOf("--reason");
    const paths = (i >= 0 ? rest.slice(0, i) : rest).map((p) => relative(root, resolve(p)) || ".");
    if (cmd === "reserve" && !paths.length) throw Error("reserve needs: <path>... [--reason text]");
    output({ ok: true, reservations: cmd === "reserve" ? await reservePaths(client, id, paths, i >= 0 ? rest.slice(i + 1).join(" ") || void 0 : void 0) : await releasePaths(client, id, paths) });
    return;
  }
  if (cmd === "reservations") {
    output({ reservations: await listReservations(client) });
    return;
  }
  if (cmd === "leave") {
    await client.leave({ release: rest.includes("--release") });
    await fs.rm(activePath(roomUrl, me), { force: true });
    output({ ok: true, left: true });
    return;
  }
  if (cmd === "host") {
    if (!rest[0]) throw Error("host needs: <participant to make host>");
    output(await client.transferHost(rest[0]));
    return;
  }
  throw Error(`unknown command: ${cmd}. Usage: create|join|send|read|team|inbox|watch|wait|doctor|webhook|kickoff|profile|host|reserve|release|reservations|leave`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
