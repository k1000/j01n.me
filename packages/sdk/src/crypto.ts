// NOTE: The standalone j01n.js client (packages/helper/src/client-script.ts / /client/j01n.js)
// contains an inline copy of these ECDH P-256 + AES-256-GCM crypto primitives because
// it must be pipeable via `curl | node -` with zero npm dependencies.
// Keep the algorithm choices, base64url encoding, and EncryptedBody format in sync.
// See apps/web/test/crypto-primitives.test.ts for conformance tests.

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashJoinSecret(roomId: string, secret: string): Promise<string> {
  const input = new TextEncoder().encode(`${roomId}.${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return base64Url(new Uint8Array(digest));
}

export interface EncryptedBody {
  encrypted: true;
  /** AES-GCM ciphertext (base64url). For direct messages, decrypt with shared key. */
  ciphertext: string;
  /** AES-GCM IV (base64url, 12 bytes). */
  iv: string;
  /** Wrapped message keys per recipient (base64url). Present for broadcast messages. */
  keys?: Record<string, { encrypted_key: string; iv: string }>;
}

export function isEncryptedBody(body: unknown): body is EncryptedBody {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.encrypted === true && typeof record.ciphertext === "string" && typeof record.iv === "string";
}

export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  ) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key) as ArrayBuffer;
  return base64Url(new Uint8Array(raw));
}

export async function importPublicKey(base64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(base64url),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

/** ECDH-derive an AES-256-GCM key. Pass own public key for a self-key usable for self-wrapping broadcast keys. */
export async function deriveSharedKey(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: "ECDH", public: peerPublicKey } as any,
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    iv: base64Url(iv),
  };
}

export async function decryptWithKey(key: CryptoKey, ciphertextB64: string, ivB64: string): Promise<string> {
  const ciphertext = base64UrlToBytes(ciphertextB64);
  const iv = base64UrlToBytes(ivB64);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function generateMessageKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  ) as Promise<CryptoKey>;
}

/**
 * Wrap (encrypt) a message key with a recipient's shared key.
 * Returns { encrypted_key, iv } (both base64url).
 */
export async function wrapKeyForRecipient(messageKey: CryptoKey, sharedKey: CryptoKey): Promise<{ encrypted_key: string; iv: string }> {
  const rawKey = await crypto.subtle.exportKey("raw", messageKey) as ArrayBuffer;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, rawKey);
  return {
    encrypted_key: base64Url(new Uint8Array(encryptedKey)),
    iv: base64Url(iv),
  };
}

/**
 * Unwrap (decrypt) a wrapped message key using a shared key.
 * Returns the AES-256-GCM key used to decrypt the message body.
 */
export async function unwrapKey(encryptedKeyB64: string, ivB64: string, sharedKey: CryptoKey): Promise<CryptoKey> {
  const encryptedKey = base64UrlToBytes(encryptedKeyB64);
  const iv = base64UrlToBytes(ivB64);
  const rawKey = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, encryptedKey);
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

// ── Sealed kickoff: readable by anyone holding the invite (join secret), not by the server ──
// The server stores only a hash of the join secret, so it cannot derive this key.
const KICKOFF_PREFIX = "jsk1:";

async function kickoffKey(joinSecret: string, roomId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(joinSecret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(roomId), info: new TextEncoder().encode("j01n.me kickoff v1") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Seal a kickoff for everyone holding the invite. Send it as a message body with intent "kickoff". */
export async function sealKickoff(plain: unknown, joinSecret: string, roomId: string): Promise<{ encrypted_payload: string }> {
  const { ciphertext, iv } = await encryptWithKey(await kickoffKey(joinSecret, roomId), JSON.stringify(plain));
  return { encrypted_payload: `${KICKOFF_PREFIX}${iv}.${ciphertext}` };
}

export function isSealedKickoff(body: unknown): body is { encrypted_payload: string } {
  return typeof (body as { encrypted_payload?: unknown } | null)?.encrypted_payload === "string"
    && (body as { encrypted_payload: string }).encrypted_payload.startsWith(KICKOFF_PREFIX);
}

/** Open a sealed kickoff with the invite's join secret; throws if the secret or room is wrong. */
export async function openKickoff(body: { encrypted_payload: string }, joinSecret: string, roomId: string): Promise<unknown> {
  const [iv, ciphertext] = body.encrypted_payload.slice(KICKOFF_PREFIX.length).split(".");
  return JSON.parse(await decryptWithKey(await kickoffKey(joinSecret, roomId), ciphertext, iv));
}

/** Where an agent works. Announced sealed with the room key, like the kickoff, so the server never sees it. */
export interface Workspace {
  path?: string;
  repo?: string;
  branch?: string;
}

export async function sealWorkspace(workspace: Workspace, joinSecret: string, roomId: string): Promise<string> {
  return (await sealKickoff(workspace, joinSecret, roomId)).encrypted_payload;
}

export async function openWorkspace(sealed: string, joinSecret: string, roomId: string): Promise<Workspace> {
  return await openKickoff({ encrypted_payload: sealed }, joinSecret, roomId) as Workspace;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "===".slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
