import { describe, expect, it } from "vitest";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import { inviteLink, parseInviteLink } from "@j01n/sdk/invite";
import { isSealedKickoff, openKickoff, sealKickoff } from "@j01n/sdk/crypto";
import type { RoomMessage } from "../src/types";

async function exchangeKeys(...sessions: Array<{ id: string; session: Awaited<ReturnType<typeof createSdkCryptoSession>> }>): Promise<void> {
  const announcements = await Promise.all(
    sessions.map(async ({ id, session }) => ({ id, body: await session.announceKeyBody() })),
  );
  for (const recipient of sessions) {
    const messages = announcements
      .filter((a) => a.id !== recipient.id)
      .map((a) => keyExchangeMessage(a.id, a.body));
    await recipient.session.processKeyExchange(messages);
  }
}

function keyExchangeMessage(from: string, body: { public_key: string }): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq: 0,
    from,
    to: "all",
    reply_to: null,
    intent: "key.exchange",
    priority: "normal",
    body,
    created_at: new Date().toISOString(),
  };
}

function encryptedMessage(from: string, to: RoomMessage["to"], body: unknown): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    from,
    to,
    reply_to: null,
    intent: "notify",
    priority: "normal",
    body,
    created_at: new Date().toISOString(),
  };
}

describe("SDK crypto session", () => {
  it("direct messages encrypt and decrypt round-trip between two peers", async () => {
    const alice = { id: "alice", session: await createSdkCryptoSession("alice") };
    const bob = { id: "bob", session: await createSdkCryptoSession("bob") };
    await exchangeKeys(alice, bob);

    const ciphertext = await alice.session.encryptForSend({ text: "for bob" }, "bob");
    const decrypted = await bob.session.decryptMessageBody(encryptedMessage("alice", "bob", ciphertext));

    expect(decrypted).toEqual({ text: "for bob" });
  });

  it("the sender can decrypt its own direct message", async () => {
    const alice = { id: "alice", session: await createSdkCryptoSession("alice") };
    const bob = { id: "bob", session: await createSdkCryptoSession("bob") };
    await exchangeKeys(alice, bob);

    const ciphertext = await alice.session.encryptForSend({ text: "for bob" }, "bob");

    expect(await alice.session.decryptMessageBody(encryptedMessage("alice", "bob", ciphertext))).toEqual({ text: "for bob" });
  });

  it("broadcast messages are decryptable by all participants and the sender itself", async () => {
    const alice = { id: "alice", session: await createSdkCryptoSession("alice") };
    const bob = { id: "bob", session: await createSdkCryptoSession("bob") };
    const carol = { id: "carol", session: await createSdkCryptoSession("carol") };
    await exchangeKeys(alice, bob, carol);

    const ciphertext = await alice.session.encryptForSend({ text: "everyone" }, "all");
    const msg = encryptedMessage("alice", "all", ciphertext);

    expect(await bob.session.decryptMessageBody(msg)).toEqual({ text: "everyone" });
    expect(await carol.session.decryptMessageBody(msg)).toEqual({ text: "everyone" });
    expect(await alice.session.decryptMessageBody(msg)).toEqual({ text: "everyone" });
  });

  it("plain (unencrypted) bodies pass through decryptMessageBody untouched", async () => {
    const alice = await createSdkCryptoSession("alice");
    const plain = { text: "hello" };
    expect(await alice.decryptMessageBody(encryptedMessage("bob", "all", plain))).toBe(plain);
  });

  it("rejects encryptForSend when recipient public key is unknown", async () => {
    const alice = await createSdkCryptoSession("alice");
    await expect(alice.encryptForSend({ text: "x" }, "ghost")).rejects.toThrow(/No public key/);
  });

  it("processKeyExchange ignores own and non-key.exchange messages", async () => {
    const alice = await createSdkCryptoSession("alice");
    const bob = await createSdkCryptoSession("bob");
    const bobAnnounce = await bob.announceKeyBody();
    await alice.processKeyExchange([
      keyExchangeMessage("alice", await alice.announceKeyBody()),
      { ...keyExchangeMessage("bob", bobAnnounce), intent: "notify" },
    ]);
    await expect(alice.encryptForSend({ text: "x" }, "bob")).rejects.toThrow(/No public key/);
  });
});

describe("room link", () => {
  it("round-trips a room URL and join secret", () => {
    const link = inviteLink("https://j01n.me/r/abc123", "s3cr-et_x");
    expect(link).toBe("https://j01n.me/room/abc123#s3cr-et_x");
    expect(parseInviteLink(link)).toEqual({ access: "https://j01n.me/r/abc123", join_secret: "s3cr-et_x" });
    expect(parseInviteLink('{"access":"https://j01n.me/r/abc123"}')).toBeUndefined();
  });
});

describe("sealed kickoff", () => {
  it("opens with the room's join secret and nothing else", async () => {
    const sealed = await sealKickoff({ goal: "ship" }, "join-secret", "room-1");
    expect(isSealedKickoff(sealed)).toBe(true);
    expect(sealed.encrypted_payload).not.toContain("ship");
    expect(await openKickoff(sealed, "join-secret", "room-1")).toEqual({ goal: "ship" });
    await expect(openKickoff(sealed, "wrong-secret", "room-1")).rejects.toThrow();
    await expect(openKickoff(sealed, "join-secret", "other-room")).rejects.toThrow();
  });
});
