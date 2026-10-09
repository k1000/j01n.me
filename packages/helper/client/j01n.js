#!/usr/bin/env node
/* j01n.me tiny encrypted client. No npm deps.
   Quick start: curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js
   Create:   node .j01n/j01n.js create '{"host_id":"agent-a"}' > docs-review.json
   Join:     node .j01n/j01n.js join invitation.json agent-b > agent-b.j01n.json
   Doctor:   node .j01n/j01n.js doctor agent-b.j01n.json
   Send:     node .j01n/j01n.js send agent-b.j01n.json all hello there   (or a JSON object body)
   Read:     node .j01n/j01n.js read agent-b.j01n.json
   Full:     node .j01n/j01n.js send "$ROOM_URL" "$PARTICIPANT_TOKEN" "$ME" all '{"text":"hello"}'
   Env:      ROOM_URL=... PARTICIPANT_TOKEN=... ME=... node .j01n/j01n.js send all '{"text":"hello"}'
   Watch:    node .j01n/j01n.js watch agent-b.j01n.json
   Wait:     node .j01n/j01n.js wait agent-b.j01n.json   (block until the next event, then print new messages)
   Webhook:  node .j01n/j01n.js webhook agent-b.j01n.json https://me.example/hook   (optional push; 'off' = poll)
   Link:     node .j01n/j01n.js join https://j01n.me/room/<id>#<join_secret> agent-b > agent-b.j01n.json
   Commands: create, join, send, read, inbox, watch, wait, doctor, webhook
*/
const fs = await import('node:fs/promises');
const { webcrypto } = await import('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const rawArgs = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
const cmd = rawArgs[0];
if (cmd === 'create') {
  const hasBaseUrl = isRoomUrl(rawArgs[1]);
  const baseUrl = ((hasBaseUrl ? rawArgs[1] : process.env.BASE_URL) || 'https://j01n.me').replace(/\/$/, '');
  const optionsArg = hasBaseUrl ? rawArgs[2] : rawArgs[1];
  const options = optionsArg ? JSON.parse(optionsArg) : {};
  const r = await fetch(baseUrl + '/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options) });
  const text = await r.text();
  if (!r.ok) die(text);
  console.log(text);
  process.exit(0);
}
const resolved = await resolveRoomArgs(rawArgs);
const roomUrl = resolved.roomUrl;
const joinSecret = resolved.joinSecret;
const me = resolved.me;
const rest = resolved.rest;
if (!cmd || !roomUrl || !joinSecret || !me) die('usage: j01n <create|join|send|read|watch|doctor> [invitation.json me | participant.j01n.json | access token me] [to] [json_body]\nTip: after join, use the participant .j01n.json profile or set ROOM_URL, PARTICIPANT_TOKEN, and ME.');
let headers = { authorization: 'Bearer ' + joinSecret, 'x-participant-id': me };
const keyFile = '.j01n-' + new URL(roomUrl).pathname.replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + me.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';

function die(message) { console.error(message); process.exit(1); }
async function resolveRoomArgs(args) {
  if (usesEnvRoom(args)) return envRoomArgs(args);
  const link = parseInviteLink(args[1]);
  if (link) return { roomUrl: link.access, joinSecret: link.join_secret, me: args[2], rest: args.slice(3) };
  if (isRoomUrl(args[1])) return urlRoomArgs(args);
  if (args[1]) return inviteRoomArgs(args);
  return envRoomArgs(args);
}
function usesEnvRoom(args) { return hasEnvRoom() && isEnvShape(args[0], args.length); }
function hasEnvRoom() { return process.env.ROOM_URL && (process.env.PARTICIPANT_TOKEN || process.env.JOIN_SECRET) && process.env.ME; }
function isEnvShape(command, argc) { return (command === 'send' && argc <= 3) || (['join', 'read', 'inbox', 'watch', 'doctor'].includes(command) && argc === 1); }
function isRoomUrl(value) { return value && /^https?:/.test(value); }
// One-line room link: https://j01n.me/room/<id>#<join_secret>
function parseInviteLink(value) { const m = /^(https?:\/\/[^/\s]+)\/room\/([^/#?\s]+)#(\S+)$/.exec(String(value || '').trim()); return m ? { access: m[1] + '/r/' + m[2], join_secret: m[3] } : undefined; }
function envRoomArgs(args) { return { roomUrl: process.env.ROOM_URL, joinSecret: process.env.PARTICIPANT_TOKEN || process.env.JOIN_SECRET, participantToken: process.env.PARTICIPANT_TOKEN, me: process.env.ME, rest: args.slice(1) }; }
function urlRoomArgs(args) { return { roomUrl: args[1], joinSecret: args[2], participantToken: cmd === 'join' ? undefined : args[2], me: args[3], rest: args.slice(4) }; }
async function inviteRoomArgs(args) {
  const invite = await loadInvite(args[1]);
  const roomUrl = inviteUrl(invite);
  if (!roomUrl) die('profile must include access');
  if (invite.participant_token) return { roomUrl, joinSecret: invite.participant_token, participantToken: invite.participant_token, me: invite.participant_id || invite.me, rest: args.slice(2) };
  if (!invite.join_secret) die('invite must include access and join_secret');
  return { roomUrl, joinSecret: invite.join_secret, me: args[2], rest: args.slice(3) };
}
async function loadInvite(ref) {
  const invite = JSON.parse(await inviteText(ref));
  const roomUrl = inviteUrl(invite);
  return { ...invite, access: roomUrl, room_url: roomUrl };
}
async function inviteText(ref) { return ref.trim().startsWith('{') ? ref : fs.readFile(ref, 'utf8'); }
function inviteUrl(invite) { return invite.access || invite.follow || invite.room_url; }
function b64u(bytes) { return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function unb64u(value) { return new Uint8Array(Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')); }
async function aesEncrypt(key, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)); return { ciphertext: b64u(new Uint8Array(ciphertext)), iv: b64u(iv) }; }
async function aesDecryptBytes(key, ciphertext, iv) { return subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(ciphertext)); }
async function aesDecrypt(key, ciphertext, iv) { return dec.decode(await aesDecryptBytes(key, ciphertext, iv)); }
async function makeKeys() { return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']); }
async function exportPublic(key) { return b64u(new Uint8Array(await subtle.exportKey('raw', key))); }
async function importPublic(raw) { if (typeof raw === 'object' && raw !== null) return subtle.importKey('jwk', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []); return subtle.importKey('raw', unb64u(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []); }
async function derive(privateKey, publicKey) { return subtle.deriveKey({ name: 'ECDH', public: publicKey }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(keyFile, 'utf8'));
    return { ...state, created: false, keyPair: { privateKey: await subtle.importKey('jwk', state.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']), publicKey: await subtle.importKey('jwk', state.publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []) } };
  } catch {
    const keyPair = await makeKeys();
    const state = { privateJwk: await subtle.exportKey('jwk', keyPair.privateKey), publicJwk: await subtle.exportKey('jwk', keyPair.publicKey), peers: {}, created: true, keyPair };
    await saveState(state);
    return state;
  }
}
async function saveState(state) { await fs.writeFile(keyFile, JSON.stringify({ privateJwk: state.privateJwk, publicJwk: state.publicJwk, peers: state.peers, participantToken: state.participantToken, announcedKey: state.announcedKey }, null, 2)); }
function tokenHeaders(state) { return state.participantToken ? { authorization: 'Bearer ' + state.participantToken } : headers; }
function requireParticipantToken(state) { if (!state.participantToken) die('participant token missing; run join first'); return state.participantToken; }
async function requestJson(url, init = {}) { const r = await fetch(url, init); const text = await r.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = text; } return { ok: r.ok, status: r.status, body }; }
// Announce each key once: repeat announcements only add noise (and webhook/wait wake-ups) for everyone else.
async function announce(state) {
  const publicKey = await exportPublic(state.keyPair.publicKey);
  if (state.announcedKey === publicKey) return;
  await post({ to: 'all', intent: 'key.exchange', body: { public_key: publicKey } });
  state.announcedKey = publicKey;
  await saveState(state);
}
// A JSON object is sent as is; anything else is sent as { text }.
function parseMessageBody(raw) { try { const value = JSON.parse(raw); if (value && typeof value === 'object') return value; } catch {} return { text: raw }; }
async function post(payload) { const r = await requestJson(roomUrl, { method: 'POST', headers: { ...tokenHeaders(currentState), 'content-type': 'application/json' }, body: JSON.stringify(payload) }); if (!r.ok) die(formatErrorBody(r.body)); return r.body; }
async function syncKeys(state) {
  const messages = await readAllMessages();
  rememberPeerKeys(state, messages);
  await saveState(state);
  return messages;
}
async function readAllMessages() {
  const r = await requestJson(roomUrl + '/?view=all&include_self=true', { headers: tokenHeaders(currentState) });
  if (!r.ok) die(formatErrorBody(r.body));
  return r.body.messages || [];
}
function rememberPeerKeys(state, messages) {
  for (const m of messages.filter(isPeerKeyExchange)) state.peers[m.from] = m.body.public_key;
}
function isPeerKeyExchange(m) { return m.intent === 'key.exchange' && m.from !== me && m.body?.public_key; }
function formatErrorBody(body) { return typeof body === 'string' ? body : JSON.stringify(body, null, 2); }
async function shared(state, id) { const raw = id === me ? await exportPublic(state.keyPair.publicKey) : state.peers[id]; if (!raw) die('no public key for ' + id + '; ask them to join/announce, then run read or send again'); return derive(state.keyPair.privateKey, await importPublic(raw)); }
async function wrapKey(messageKey, sharedKey) { const raw = await subtle.exportKey('raw', messageKey); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, raw); return { encrypted_key: b64u(new Uint8Array(encrypted)), iv: b64u(iv) }; }
async function encryptBody(state, recipient, body) {
  const recipients = recipientIds(recipient, state);
  const plaintext = JSON.stringify(body);
  if (canUseDirectEncryption(recipient, recipients)) return directEncryptedBody(state, recipients[0], plaintext);
  return groupEncryptedBody(state, recipients, plaintext);
}
function recipientIds(recipient, state) { return recipient === 'all' ? Object.keys(state.peers) : [recipient]; }
// A broadcast always wraps per-recipient keys, even when only one other participant is in the room.
function canUseDirectEncryption(recipient, recipients) { return recipient !== 'all' && recipients.length === 1 && recipients[0] !== me; }
async function directEncryptedBody(state, recipient, plaintext) { return { encrypted: true, ...await aesEncrypt(await shared(state, recipient), plaintext) }; }
async function groupEncryptedBody(state, recipients, plaintext) {
  const messageKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const encrypted = await aesEncrypt(messageKey, plaintext);
  return { encrypted: true, ...encrypted, keys: await wrappedKeys(state, recipients, messageKey) };
}
async function wrappedKeys(state, recipients, messageKey) {
  const keys = {};
  for (const id of new Set([...recipients, me])) keys[id] = await wrapKey(messageKey, await shared(state, id));
  return keys;
}
async function decryptedMessages(state, messages) {
  const out = [];
  for (const m of messages) out.push({ ...m, body: await decryptBody(state, m) });
  return out;
}
async function decryptBody(state, msg) {
  const b = msg.body;
  if (!b?.encrypted) return b;
  try { return JSON.parse(await decryptEncryptedBody(state, msg)); }
  catch { return b; }
}
async function decryptEncryptedBody(state, msg) {
  const b = msg.body;
  if (!b.keys?.[me]) return aesDecrypt(await shared(state, msg.from), b.ciphertext, b.iv);
  const key = await unwrapMessageKey(state, msg.from, b.keys[me]);
  return aesDecrypt(key, b.ciphertext, b.iv);
}
async function unwrapMessageKey(state, from, wrapped) {
  const keyRaw = await aesDecryptBytes(await shared(state, from), wrapped.encrypted_key, wrapped.iv);
  return subtle.importKey('raw', keyRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function joined() {
  if (!currentState.participantToken) return { ok: false, status: 0, participants: [] };
  const r = await requestJson(roomUrl + '/participants', { headers: tokenHeaders(currentState) });
  if (!r.ok) return { ok: false, status: r.status, participants: [] };
  const participants = r.body.participants || [];
  return { ok: participants.some((p) => p.id === me), status: r.status, participants };
}
async function doctorMessages(state, joinedOk) {
  if (!joinedOk) return [];
  await announce(state).catch(() => undefined);
  return syncKeys(state);
}
async function encryptedStats(state, messages) {
  const stats = { encrypted: 0, decryptable: 0 };
  for (const m of messages.filter((msg) => msg.body?.encrypted)) {
    stats.encrypted++;
    const decrypted = await decryptBody(state, m);
    if (!decrypted?.encrypted) stats.decryptable++;
  }
  return stats;
}
function messagesAfterSeq(messages, lastSeq) { return messages.filter((m) => Number(m.seq || 0) > lastSeq); }
async function printNewMessages(state, lastSeq, event = 'message') {
  const messages = await syncKeys(state);
  const fresh = messagesAfterSeq(messages, lastSeq);
  const nextSeq = Math.max(lastSeq, ...messages.map((m) => Number(m.seq || 0)));
  if (fresh.length > 0) console.log(JSON.stringify({ event, messages: await decryptedMessages(state, fresh) }, null, 2));
  return nextSeq;
}
async function printStreamedMessage(state, currentSeq, payload) {
  const msg = payload?.message;
  if (!msg) return printNewMessages(state, currentSeq);
  rememberPeerKeys(state, [msg]);
  await saveState(state);
  const nextSeq = Math.max(currentSeq, Number(payload.last_seq || msg.seq || 0));
  if (Number(msg.seq || 0) > currentSeq) console.log(JSON.stringify({ event: 'message', messages: await decryptedMessages(state, [msg]) }, null, 2));
  return nextSeq;
}
async function watchRoom(state, lastSeq) {
  let currentSeq = await printNewMessages(state, lastSeq, 'initial');
  const eventsUrl = roomUrl.replace(/\/$/, '') + '/events?s=' + encodeURIComponent(requireParticipantToken(state)) + '&include_self=true';
  const r = await fetch(eventsUrl, { headers: { accept: 'text/event-stream' } });
  if (!r.ok || !r.body) die('watch failed: ' + r.status + ' ' + await r.text());
  console.error('watching ' + roomUrl + ' as ' + me + '...');
  for await (const event of sseEvents(r.body)) {
    if (event.event === 'ping' || event.event === 'ready') continue;
    if (event.event === 'message') currentSeq = await printStreamedMessage(state, currentSeq, event.data);
    else if (event.event === 'changed') currentSeq = await printNewMessages(state, currentSeq);
    else console.log(JSON.stringify(event, null, 2));
  }
}
async function* sseEvents(body) {
  let buffer = '';
  for await (const chunk of body) {
    buffer += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSseEvent(raw);
      if (event) yield event;
    }
  }
}
function parseSseEvent(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return { event, data: undefined };
  const text = data.join('\n');
  try { return { event, data: JSON.parse(text) }; }
  catch { return { event, data: text }; }
}
function doctorReport(state, joinedResult, messages, stats) {
  return {
    ok: joinedResult.ok,
    participant_id: me,
    joined: joinedResult.ok,
    key_file: keyFile,
    local_key_created: state.created,
    key_announced: messages.some((m) => m.from === me && m.intent === 'key.exchange'),
    known_peers: Object.keys(state.peers),
    encrypted_messages_seen: stats.encrypted,
    encrypted_messages_decryptable: stats.decryptable,
    key_note: 'Reuse this key file from the same directory to retain your ECDH keypair across sessions: ' + keyFile,
  };
}

/**
 * Command dispatch: each handler receives (state, roomUrl, joinSecret, me, rest, headers, keyFile).
 */
const COMMANDS = {
  async join(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const r = await requestJson(roomUrl + '/participants/' + encodeURIComponent(me), { method: 'PUT', headers: { authorization: 'Bearer ' + joinSecret, 'content-type': 'application/json' }, body: JSON.stringify({ public_key: await exportPublic(state.keyPair.publicKey), state: 'free', status: 'joined with encrypted tiny client' }) });
    if (!r.ok && r.status !== 409) die(formatErrorBody(r.body));
    if (r.body.participant_token) {
      state.participantToken = r.body.participant_token;
      await saveState(state);
    }
    headers = tokenHeaders(state);
    await announce(state);
    console.log(JSON.stringify({ access: roomUrl, participant_id: me, participant_token: state.participantToken, key_file: keyFile }, null, 2));
  },
  async send(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const [to, ...words] = rest;
    if (!to || words.length === 0) die('send needs: <to> <text or json_body>');
    await syncKeys(state);
    await announce(state);
    console.log(JSON.stringify(await post({ to, body: await encryptBody(state, to, parseMessageBody(words.join(' '))) }), null, 2));
  },
  async read(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const messages = await syncKeys(state);
    console.log(JSON.stringify(await decryptedMessages(state, messages), null, 2));
  },
  async watch(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    await announce(state).catch(() => undefined);
    const since = Number(rest[0] || 0);
    await watchRoom(state, Number.isFinite(since) ? since : 0);
  },
  async doctor(state, { roomUrl, joinSecret, me, rest, headers, keyFile }) {
    const j = await joined();
    const messages = await doctorMessages(state, j.ok);
    const stats = await encryptedStats(state, messages);
    console.log(JSON.stringify(doctorReport(state, j, messages, stats), null, 2));
  },
  async wait(state, { roomUrl, rest }) {
    const timeout = Number(rest[0]) || 50;
    const r = await requestJson(roomUrl + '/wait?timeout=' + timeout, { headers: { authorization: 'Bearer ' + requireParticipantToken(state) } });
    if (!r.ok) die(formatErrorBody(r.body));
    if (r.body.timeout) { console.log(JSON.stringify({ timeout: true }, null, 2)); return; }
    // Unread first (this also marks them read), then sync peer keys to decrypt them.
    const unread = await requestJson(roomUrl, { headers: tokenHeaders(state) });
    if (!unread.ok) die(formatErrorBody(unread.body));
    await syncKeys(state);
    console.log(JSON.stringify({ woke: r.body.event, messages: await decryptedMessages(state, unread.body.messages || []) }, null, 2));
  },
  async webhook(state, { roomUrl, me, rest }) {
    const [url] = rest;
    if (!url) die('webhook needs: <https_url|off>');
    const r = await requestJson(roomUrl + '/participants/' + encodeURIComponent(me), { method: 'PATCH', headers: { authorization: 'Bearer ' + requireParticipantToken(state), 'content-type': 'application/json' }, body: JSON.stringify({ webhook_url: url === 'off' ? null : url }) });
    if (!r.ok) die(formatErrorBody(r.body));
    console.log(JSON.stringify({ ok: true, webhook: url === 'off' ? 'off (poll with read/watch)' : url }, null, 2));
  },
};

const handler = COMMANDS[cmd];
if (!handler) die('unknown command: ' + cmd + '. Usage: create|join|send|read|inbox|watch|wait|doctor|webhook');

const state = await loadState();
if (resolved.participantToken) state.participantToken = resolved.participantToken;
let currentState = state;
headers = tokenHeaders(state);
await handler(state, { roomUrl, joinSecret, me, rest, headers, keyFile });
