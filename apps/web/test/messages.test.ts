/**
 * Unit tests for room/messages.ts pure functions.
 *
 * Tests the decomposed guard functions indirectly through createSentMessage,
 * and directly tests exported pure helpers: isReadableMessage, visibleTo,
 * parseReadOptions, buildReadResponse.
 */
import { describe, it, expect } from "vitest";
import { isReadableMessage, visibleTo } from "../src/room/messages";
import type { InviteState, RoomMessage } from "../src/types";

// ── Helpers ───────────────────────────────────────────────────

/** Build a minimal invite for testing pure functions that need InviteState. */
function makeInvite(overrides: Partial<InviteState> = {}): InviteState {
  return {
    roomId: "test-room",
    secretHash: "abc",
    expiresAt: Date.now() + 60000,
    phase: "ready",
    hostId: "host",
    roomName: "test",
    purpose: "test",
    maxParticipants: 16,
    nextSeq: 0,
    participants: {},
    messages: [],
    board: {},
    ...overrides,
  };
}

function makeMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "msg-1",
    seq: 1,
    from: "alice",
    to: "all",
    reply_to: null,
    intent: "notify",
    priority: "normal",
    body: { text: "hello" },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── visibleTo tests ──────────────────────────────────────────

describe("visibleTo", () => {
  it("returns true for 'all' broadcast", () => {
    const msg = makeMessage({ to: "all" });
    expect(visibleTo(msg, "alice")).toBe(true);
    expect(visibleTo(msg, "bob")).toBe(true);
    expect(visibleTo(msg, "charlie")).toBe(true);
  });

  it("returns true for direct message to the participant", () => {
    const msg = makeMessage({ from: "carol", to: "bob" });
    expect(visibleTo(msg, "bob")).toBe(true);
    expect(visibleTo(msg, "alice")).toBe(false);
  });

  it("returns true for the sender of a direct message", () => {
    expect(visibleTo(makeMessage({ from: "alice", to: "bob" }), "alice")).toBe(true);
  });

  it("returns true when participant is in multi-recipient list", () => {
    const msg = makeMessage({ to: ["alice", "bob"] });
    expect(visibleTo(msg, "alice")).toBe(true);
    expect(visibleTo(msg, "bob")).toBe(true);
    expect(visibleTo(msg, "charlie")).toBe(false);
  });

  it("returns false for direct message to another participant", () => {
    const msg = makeMessage({ to: "charlie" });
    expect(visibleTo(msg, "bob")).toBe(false);
  });
});

// ── isReadableMessage tests ──────────────────────────────────

describe("isReadableMessage", () => {
  const options = { after: 0, includeSelf: false, mode: "recent" as const };

  it("returns true for a new message broadcast to all", () => {
    const msg = makeMessage({ seq: 5, from: "bob", to: "all" });
    expect(isReadableMessage(msg, "alice", options)).toBe(true);
  });

  it("returns false when message seq is not past cursor", () => {
    const msg = makeMessage({ seq: 1, from: "bob", to: "all" });
    expect(isReadableMessage(msg, "alice", { ...options, after: 5 })).toBe(false);
  });

  it("excludes own messages when includeSelf is false", () => {
    const msg = makeMessage({ seq: 3, from: "alice", to: "all" });
    expect(isReadableMessage(msg, "alice", options)).toBe(false);
  });

  it("includes own messages when includeSelf is true", () => {
    const msg = makeMessage({ seq: 3, from: "alice", to: "all" });
    expect(isReadableMessage(msg, "alice", { ...options, includeSelf: true })).toBe(true);
  });

  it("returns false when message is direct to another participant", () => {
    const msg = makeMessage({ seq: 3, from: "charlie", to: "bob" });
    expect(isReadableMessage(msg, "alice", options)).toBe(false);
  });

  it("respects the after cursor with higher seq messages", () => {
    const msg = makeMessage({ seq: 10, from: "bob", to: "all" });
    expect(isReadableMessage(msg, "alice", { ...options, after: 5 })).toBe(true);
    expect(isReadableMessage(msg, "alice", { ...options, after: 10 })).toBe(false);
    expect(isReadableMessage(msg, "alice", { ...options, after: 12 })).toBe(false);
  });
});

// ── createSentMessage tests ──────────────────────────────────

describe("createSentMessage", () => {
  // Dynamic import to get around module-level side effects
  it("rejects message body exceeding MAX_BODY_BYTES", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite();
    const largeBody = { data: "x".repeat(20_000) };
    const result = createSentMessage(
      { body: largeBody },
      "alice",
      invite,
    );
    // Large body returns a Response
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(413);
    const resBody = await response.json() as Record<string, unknown>;
    expect(resBody.error as string).toContain("too large");
  });

  it("accepts a key.exchange message without encryption checks", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite({
      participants: {
        alice: {
          id: "alice", joined_at: "", last_seen_at: "", last_read_seq: 0,
          state: "free", status: "", status_updated_at: "",
        },
      },
    });
    const result = createSentMessage(
      { body: { public_key: "abc" }, intent: "key.exchange", to: "all" },
      "alice",
      invite,
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.message.intent).toBe("key.exchange");
    expect(result.message.from).toBe("alice");
  });

  it("rejects message with unencrypted body when no key.exchange intent", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite({
      participants: {
        alice: {
          id: "alice", joined_at: "", last_seen_at: "", last_read_seq: 0,
          state: "free", status: "", status_updated_at: "",
        },
      },
    });
    // Plain body without encryption and without key.exchange intent
    const result = createSentMessage(
      { body: { text: "hello" }, to: "all", intent: "notify" },
      "alice",
      invite,
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    const resBody = await response.json() as Record<string, unknown>;
    expect(resBody.error as string).toContain("encrypted");
  });

  it("does not require an unjoined human host key for all-recipient encrypted messages", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite({
      hostId: "human",
      participants: {
        alice: {
          id: "alice", joined_at: "", last_seen_at: "", last_read_seq: 0,
          state: "free", status: "", status_updated_at: "",
        },
      },
      messages: [makeMessage({ from: "alice", intent: "key.exchange", body: { public_key: "alice-key" } })],
    });
    const result = createSentMessage(
      { body: { encrypted: true, ciphertext: "abc", iv: "def", keys: { alice: { encrypted_key: "ghi", iv: "jkl" } } }, to: "all", intent: "notify" },
      "alice",
      invite,
    );
    expect(result).not.toBeInstanceOf(Response);
  });

  it("accepts an opaque encrypted_payload body without SDK encryption checks", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite({
      participants: {
        alice: {
          id: "alice", joined_at: "", last_seen_at: "", last_read_seq: 0,
          state: "free", status: "", status_updated_at: "",
        },
      },
    });
    const result = createSentMessage(
      { body: { encrypted_payload: "j01n1:abc:def:ghi:jkl" }, to: "all", intent: "notify" },
      "alice",
      invite,
    );
    // Opaque encrypted_payload bodies bypass all key announcement checks
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.message.intent).toBe("notify");
    expect(result.message.from).toBe("alice");
    expect(result.message.body).toEqual({ encrypted_payload: "j01n1:abc:def:ghi:jkl" });
  });

  it("rejects message with invalid recipient", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite();
    const result = createSentMessage(
      { body: { text: "hi" }, to: "nonexistent", intent: "key.exchange" },
      "alice",
      invite,
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    // key.exchange bypasses encryption but recipient check happens before
    expect(response.status).toBe(404);
  });

  it("assigns incrementing seq numbers", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    const invite = makeInvite({ nextSeq: 5 });
    const result = createSentMessage(
      { body: { public_key: "abc" }, intent: "key.exchange", to: "all" },
      "alice",
      invite,
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.seq).toBe(6);
    expect(result.message.seq).toBe(6);
  });

  it("trims messages to MAX_MESSAGES", async () => {
    const { createSentMessage } = await import("../src/room/messages");
    // Fill the invite with MAX_MESSAGES messages
    const existingMessages: RoomMessage[] = Array.from({ length: 200 }, (_, i) => makeMessage({
      id: `old-${i}`, seq: i + 1, from: "host", to: "all",
    }));
    const invite = makeInvite({
      nextSeq: 200,
      messages: existingMessages,
      participants: {
        alice: {
          id: "alice", joined_at: "", last_seen_at: "", last_read_seq: 0,
          state: "free", status: "", status_updated_at: "",
        },
      },
    });
    const result = createSentMessage(
      { body: { public_key: "abc" }, intent: "key.exchange", to: "all" },
      "alice",
      invite,
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    // Should keep only the last 200 messages (including the new one)
    expect(result.messages.length).toBe(200);
    // The oldest seq should be 2 (seq 1 was dropped)
    expect(result.messages[0].seq).toBe(2);
    // The newest seq should be 201
    expect(result.messages[result.messages.length - 1].seq).toBe(201);
  });
});
