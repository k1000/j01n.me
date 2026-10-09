// NOTE: The standalone j01n.js client (packages/helper/src/client-script.ts) has
// an equivalent inline implementation of encryptForSen/decryptMessageBody.
// Keep the EncryptedBody format, key derivation, and wrapping scheme in sync.
// See apps/web/test/crypto-primitives.test.ts for conformance tests.

import {
  decryptWithKey,
  deriveSharedKey,
  encryptWithKey,
  exportPublicKey,
  generateECDHKeyPair,
  generateMessageKey,
  importPublicKey,
  isEncryptedBody,
  unwrapKey,
  wrapKeyForRecipient,
} from "./crypto";
import type { EncryptedBody } from "./crypto";
import type { Recipient, RoomMessage } from "./types";

export interface SdkCryptoSession {
  announceKeyBody(): Promise<{ public_key: string }>;
  processPeerKeys(peers: Array<{ id: string; public_key: string }>): Promise<void>;
  processKeyExchange(messages: RoomMessage[]): Promise<void>;
  encryptForSend(plainBody: unknown, to: Recipient): Promise<EncryptedBody>;
  decryptMessageBody(msg: RoomMessage): Promise<unknown>;
  /** Export the ECDH keypair as JWK for persistence (survives Worker isolate recycles). */
  exportKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }>;
}

export async function createSdkCryptoSession(
  participantId: string,
  privateJwk?: JsonWebKey,
  publicJwk?: JsonWebKey,
): Promise<SdkCryptoSession> {
  const keyPair = privateJwk && publicJwk
    ? {
        privateKey: await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]) as CryptoKey,
        publicKey: await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []) as CryptoKey,
      }
    : await generateECDHKeyPair();
  const selfKey = await deriveSharedKey(keyPair.privateKey, keyPair.publicKey);
  const peerKeys = new Map<string, CryptoKey>();
  const sharedKeys = new Map<string, CryptoKey>();

  async function ensureSharedKey(peerId: string): Promise<CryptoKey | undefined> {
    if (sharedKeys.has(peerId)) return sharedKeys.get(peerId)!;
    const peerPub = peerKeys.get(peerId);
    if (!peerPub) return undefined;
    const derived = await deriveSharedKey(keyPair.privateKey, peerPub);
    sharedKeys.set(peerId, derived);
    return derived;
  }

  function recipientIdsFor(to: Recipient): string[] {
    if (to === "all") return [...peerKeys.keys()].filter((id) => id !== participantId);
    const ids = Array.isArray(to) ? to : [to];
    return [...new Set(ids)];
  }

  async function requireSharedKey(peerId: string): Promise<CryptoKey> {
    const sharedKey = await ensureSharedKey(peerId);
    if (!sharedKey) throw new Error(`No public key from ${peerId}. Wait for them to announceKey() and sync by reading.`);
    return sharedKey;
  }

  async function encryptDirectBody(plaintext: string, recipientId: string): Promise<EncryptedBody> {
    const { ciphertext, iv } = await encryptWithKey(await requireSharedKey(recipientId), plaintext);
    return { encrypted: true, ciphertext, iv };
  }

  async function wrapMessageKey(messageKey: CryptoKey, recipientId: string): Promise<{ encrypted_key: string; iv: string }> {
    return wrapKeyForRecipient(messageKey, recipientId === participantId ? selfKey : await requireSharedKey(recipientId));
  }

  async function encryptWrappedBody(plaintext: string, recipientIds: string[]): Promise<EncryptedBody> {
    const messageKey = await generateMessageKey();
    const { ciphertext, iv } = await encryptWithKey(messageKey, plaintext);
    const keys: Record<string, { encrypted_key: string; iv: string }> = {};
    for (const recipientId of recipientIds) keys[recipientId] = await wrapMessageKey(messageKey, recipientId);
    if (!keys[participantId]) keys[participantId] = await wrapMessageKey(messageKey, participantId);
    return { encrypted: true, ciphertext, iv, keys };
  }

  async function exportKeyPair() {
    return {
      privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey) as JsonWebKey,
      publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey) as JsonWebKey,
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
        const body = msg.body as { public_key?: string };
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
        // A direct message uses the key shared by sender and recipient, so for your own DM that is the recipient's.
        const peerId = msg.from !== participantId ? msg.from : Array.isArray(msg.to) ? msg.to[0] : msg.to;
        const sharedKey = peerId === participantId ? selfKey : await ensureSharedKey(peerId);
        if (!sharedKey) return body;
        return JSON.parse(await decryptWithKey(sharedKey, ciphertext, iv));
      }

      return body;
    },
  };
}
