import { isEncryptedBody } from "@j01n/sdk/crypto";
import { json, type GuardResult } from "../format";
import type { InviteState, Recipient } from "../types";
import { isOpaqueEncryptedBody } from "./encryption-shape";
import { activeParticipants } from "./participants";

function isAllowedPlainProtocolMessage(body: Record<string, unknown>): boolean {
  return body.intent === "key.exchange";
}

function validateBodyIsEncrypted(body: Record<string, unknown>): GuardResult {
  if (isAllowedPlainProtocolMessage(body)) return undefined;
  if (isOpaqueEncryptedBody(body.body)) return undefined;
  if (!isEncryptedBody(body.body)) {
    return json({
      error: "message body must be encrypted",
      help: {
        cli: "curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js && node .j01n/j01n.js send participant.j01n.json all '{\\\"text\\\":\\\"hello\\\"}'",
        crypto_sh: "curl -fsSL https://j01n.me/client/crypto.sh | bash -s enc '<passphrase>' '{\\\"text\\\":\\\"hello\\\"}'",
        mcp: "Use the hosted MCP endpoint at https://j01n.me/mcp — it handles encryption automatically.",
        sdk: "npm install @j01n/sdk",
      },
      hint: "The server rejects plaintext message bodies. Encrypt client-side with the CLI helper, SDK, crypto scripts, or use the MCP endpoint which handles encryption automatically.",
    }, 400);
  }
  return undefined;
}

function validateSenderKeyAnnounced(participantId: string, invite: InviteState): GuardResult {
  const announced = announcedKeyParticipants(invite);
  if (!announced.has(participantId)) {
    return json({
      error: "sender has not announced encryption key",
      hint: "Join with the encrypted client or send intent=key.exchange before sending encrypted messages.",
    }, 409);
  }
  return undefined;
}

function validateRecipientKeysAnnounced(to: Recipient, invite: InviteState): GuardResult {
  const recipients = recipientIdsFor(to, invite);
  const announced = announcedKeyParticipants(invite);
  const missingKeys = recipients.filter((id) => !announced.has(id));
  if (missingKeys.length > 0) {
    return json({
      error: "recipient encryption keys are missing",
      missing_participants: missingKeys,
      hint: "Every recipient, including the host for broadcast rooms, must join/announce its ECDH key before encrypted messages can be sent to it.",
    }, 409);
  }
  return undefined;
}

function validateWrappedKeysPresent(body: Record<string, unknown>, to: Recipient, participantId: string, invite: InviteState): GuardResult {
  if (!(to === "all" || Array.isArray(to))) return undefined;

  const recipients = recipientIdsFor(to, invite);
  const requiredWrappedKeys = [...new Set([...recipients, participantId])];
  const wrappedKeys: Record<string, unknown> = ((body.body as Record<string, unknown>)?.keys ?? {}) as Record<string, unknown>;
  const missingWrappedKeys = requiredWrappedKeys.filter((id) => !wrappedKeys[id]);

  if (missingWrappedKeys.length > 0) {
    return json({
      error: "encrypted message is missing wrapped recipient keys",
      missing_participants: missingWrappedKeys,
      hint: "Rea/sync first so the client sees each participant's key.exchange message, then send again.",
    }, 409);
  }
  return undefined;
}

export function validateEncryptedProtocol(body: Record<string, unknown>, participantId: string, to: Recipient, invite: InviteState): GuardResult {
  let err: GuardResult;

  err = validateBodyIsEncrypted(body);
  if (err) return err;

  // key.exchange and opaque pre-encrypted bodies bypass key/wrapped-key checks
  // (key.exchange is how senders announce their key; opaque bodies are decrypted client-side).
  if (isAllowedPlainProtocolMessage(body)) return undefined;
  if (isOpaqueEncryptedBody(body.body)) return undefined;

  err = validateSenderKeyAnnounced(participantId, invite);
  if (err) return err;

  err = validateRecipientKeysAnnounced(to, invite);
  if (err) return err;

  err = validateWrappedKeysPresent(body, to, participantId, invite);
  if (err) return err;

  return undefined;
}

function announcedKeyParticipants(invite: InviteState): Set<string> {
  // Keys sent at join (or recorded from key.exchange) live on the participant; messages may have been evicted.
  return new Set([
    ...activeParticipants(invite.participants).filter((p) => p.public_key).map((p) => p.id),
    ...invite.messages
      .filter((message) => message.intent === "key.exchange" && typeof (message.body as { public_key?: unknown })?.public_key === "string")
      .map((message) => message.from),
  ]);
}

function recipientIdsFor(to: Recipient, invite: InviteState): string[] {
  if (to === "all") return [...new Set(activeParticipants(invite.participants).map((p) => p.id))];
  return Array.isArray(to) ? [...new Set(to)] : [to];
}
