import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTEND_MS, MAX_BODY_BYTES, MAX_INVITE_TTL_MS, MIN_INVITE_TTL_MS } from "../src/constants";
import { hashJoinSecret } from "@j01n/sdk/crypto";
import type { RoomMessage } from "../src/types";
import {
  announceKey,
  bootstrapRoom,
  closeRoom,
  decodedPayload,
  deleteParticipant,
  getRoomJson,
  joinParticipant,
  participantAuthHeaders,
  readMessages,
  roomRequest,
  sendMessage,
  type RoomFixture,
} from "./room/helpers";

describe("room lifecycle", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom();
  });

  it("bootstraps a room via __init (verified by bootstrapRoom)", async () => {
    const res = await joinParticipant(fix, "check");
    expect(res.status).toBe(200);
  });

  it("rejects duplicate __init", async () => {
    const res = await fix.session.fetch(new Request("https://rendezvous.internal/__init", {
      method: "POST",
      body: JSON.stringify({
        roomId: fix.roomId,
        secretHash: await hashJoinSecret(fix.roomId, "unused"),
        expiresAt: Date.now() + 10 * 60 * 1000,
        phase: "waiting" as const,
        hostId: "host",
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(res.status).toBe(409);
  });

  it("allows a participant to join", async () => {
    const res = await joinParticipant(fix, "agent-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; participant_id: string };
    expect(body.ok).toBe(true);
    expect(body.participant_id).toBe("agent-a");
  });

  it("rejects wrong join secret", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/participants/agent-x`, {
      method: "PUT",
      headers: { ...fix.joinSecret ? { authorization: "Bearer wrong-secret", "content-type": "application/json" } : {} },
    }));
    expect(res.status).toBe(403);
  });

  it("rejects duplicate participant ID", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await joinParticipant(fix, "agent-a");
    expect(res.status).toBe(409);
  });

  it("enforces max_participants", async () => {
    const smallFix = await bootstrapRoom({ maxParticipants: 2 });
    await joinParticipant(smallFix, "agent-a");
    await joinParticipant(smallFix, "agent-b");
    const res = await joinParticipant(smallFix, "agent-c");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("room is full");
  });

  it("allows send and read between participants", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");

    await sendMessage(fix, "agent-a", "all", { text: "hello from a" });
    await sendMessage(fix, "agent-b", "all", { text: "hello from b" });

    const res = await readMessages(fix, "agent-a", 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RoomMessage[] };
    const fromOthers = body.messages.filter((m) => m.from !== "agent-a");
    expect(fromOthers.length).toBeGreaterThanOrEqual(1);
    expect(fromOthers.some((m) => decodedPayload<{ text: string }>(m.body).text === "hello from b")).toBe(true);
  });

  it("records a key announced via key.exchange on the participant", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");

    expect((await announceKey(fix, "agent-b")).status).toBe(200);

    const body = await getRoomJson<{ participants: Array<{ id: string; public_key?: string }> }>(fix, "/participants", "agent-a");
    expect(body.participants.find((p) => p.id === "agent-b")?.public_key).toBe("agent-b-raw-key");
  });

  it("accepts encrypted sends from a participant whose key was given at join", async () => {
    const join = await roomRequest(fix, "/participants/agent-a", {
      method: "PUT",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ public_key: "agent-a-join-key" }),
    });
    fix.participantTokens["agent-a"] = (await join.json() as { participant_token: string }).participant_token;
    await joinParticipant(fix, "agent-b");
    await announceKey(fix, "agent-b");

    const res = await roomRequest(fix, "", {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "agent-b", body: { encrypted: true, ciphertext: "c", iv: "i" } }),
    });
    expect(res.status).toBe(200);
  });

  it("delivers direct messages only to the named recipient", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await joinParticipant(fix, "agent-c");

    await sendMessage(fix, "agent-a", "agent-b", { secret: "for b only" });

    const resB = await readMessages(fix, "agent-b");
    const resC = await readMessages(fix, "agent-c");

    const bBody = (await resB.json()) as { messages: RoomMessage[] };
    const cBody = (await resC.json()) as { messages: RoomMessage[] };

    const bGot = bBody.messages.some((m) => m.from === "agent-a" && decodedPayload<{ secret: string }>(m.body).secret === "for b only");
    const cGot = cBody.messages.some((m) => m.from === "agent-a" && decodedPayload<{ secret: string }>(m.body).secret === "for b only");
    expect(bGot).toBe(true);
    expect(cGot).toBe(false);
  });

  it("shows senders their own direct messages when include_self is set", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await sendMessage(fix, "agent-a", "agent-b", { secret: "for b only" });

    const withSelf = await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all&include_self=true", "agent-a");
    const withoutSelf = await getRoomJson<{ messages: RoomMessage[] }>(fix, "/?view=all", "agent-a");

    expect(withSelf.messages.some((m) => m.from === "agent-a" && m.to === "agent-b")).toBe(true);
    expect(withoutSelf.messages.some((m) => m.from === "agent-a" && m.to === "agent-b")).toBe(false);
  });

  it("never exposes participant token hashes", async () => {
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "agent-a");

    for (const path of ["/participants", "/status", "/export"]) {
      const res = await roomRequest(fix, path, { headers: participantAuthHeaders(fix, "host") });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("tokenHash");
    }
  });

  it("rejects send when participant uses join_secret instead of participant_token", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "ghost", "content-type": "application/json" },
      body: JSON.stringify({ to: "all", body: { encrypted_payload: JSON.stringify({ text: "boo" }) } }),
    }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "participant token is required" });
  });

  it("rejects unencrypted message bodies", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ to: "all", body: { text: "nope" } }),
    }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "message body must be encrypted",
      hint: expect.stringContaining("rejects plaintext message bodies"),
    });
  });

  it("accepts SDK-shape encrypted bodies after participants announce keys", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await announceKey(fix, "agent-a");
    await announceKey(fix, "agent-b");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ to: "agent-b", body: { encrypted: true, ciphertext: "abc", iv: "def" } }),
    }));
    expect(res.status).toBe(200);
  });

  it("accepts plain key.exchange announcements", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: "raw-key" } }),
    }));
    expect(res.status).toBe(200);
  });

  it("rejects broadcast encrypted messages missing recipient wrapped keys", async () => {
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await announceKey(fix, "host");
    await announceKey(fix, "agent-a");
    await announceKey(fix, "agent-b");

    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ to: "all", body: { encrypted: true, ciphertext: "abc", iv: "def", keys: { "agent-a": { encrypted_key: "key", iv: "iv" } } } }),
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "encrypted message is missing wrapped recipient keys",
      missing_participants: expect.arrayContaining(["host", "agent-b"]),
    });
  });

  it("rejects message body too large", async () => {
    await joinParticipant(fix, "agent-a");
    const bigBody = { text: "x".repeat(MAX_BODY_BYTES + 1) };
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ to: "all", body: bigBody }),
    }));
    expect(res.status).toBe(413);
  });

  it("allows participant to leave", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await deleteParticipant(fix, "agent-a");
    expect(res.status).toBe(200);
  });

  it("host can kick a participant", async () => {
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const res = await deleteParticipant(fix, "agent-b", "host");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kicked: string };
    expect(body.kicked).toBe("agent-b");
  });

  it("non-host cannot kick", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const res = await deleteParticipant(fix, "agent-a", "agent-b");
    expect(res.status).toBe(403);
  });

  it("host can close the room", async () => {
    await joinParticipant(fix, "host");
    const res = await closeRoom(fix);
    expect(res.status).toBe(200);
  });

  it("closed room rejects operations", async () => {
    await joinParticipant(fix, "host");
    await closeRoom(fix);
    const res = await joinParticipant(fix, "late-guest");
    expect(res.status).toBe(410);
  });

  it("lists participants", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    const body = await getRoomJson<{ participants: Array<{ id: string }> }>(fix, "/participants");
    const ids = body.participants.map((p) => p.id).sort();
    expect(ids).toEqual(["agent-a", "agent-b"]);
  });

  it("supports participant status update", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/participants/agent-a`, {
      method: "PATCH",
      headers: { ...fix.joinSecret ? { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" } : {} },
      body: JSON.stringify({ state: "busy", status: "working on tests", model: "test-model", skills: ["testing"] }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; participant: { state: string; status: string; model: string; skills: string[] } };
    expect(body.participant.state).toBe("busy");
    expect(body.participant.status).toBe("working on tests");
    expect(body.participant.model).toBe("test-model");
    expect(body.participant.skills).toEqual(["testing"]);
  });

  it("returns room status", async () => {
    await joinParticipant(fix, "agent-a");
    const body = await getRoomJson<{ room: { room_id: string; host_id: string; invite_id?: string }; phase: string; closed: boolean; message_count: number }>(fix, "/status");
    expect(body.room.host_id).toBe("host");
    expect(body.room.room_id).toBe(fix.roomId);
    expect(body.room.invite_id).toBeUndefined();
    expect(body.phase).toBe("ready");
    expect(body.closed).toBe(false);
  });

  it("allows host to export room state", async () => {
    await joinParticipant(fix, "host");
    await joinParticipant(fix, "agent-a");
    await sendMessage(fix, "agent-a", "all", { text: "hello" });
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: { ...participantAuthHeaders(fix, "host") },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { room: { host_id: string }; participants: Record<string, unknown>; messages: RoomMessage[]; board: Record<string, unknown>; board_schema: unknown; secretHash?: string };
    expect(body.room.host_id).toBe("host");
    expect(body.participants["agent-a"]).toBeDefined();
    expect(body.messages.some((message) => message.from === "agent-a")).toBe(true);
    expect(body.board).toEqual({});
    expect(body.board_schema).toBeNull();
    expect(body.secretHash).toBeUndefined();
  });

  it("rejects non-host room export", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: { ...participantAuthHeaders(fix, "agent-a") },
    }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "only host can export room" });
  });

  it("returns the invite instructions page when unauthenticated", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("j01n.me invite");
  });

  it("read returns messages and advances cursor with include_self", async () => {
    await joinParticipant(fix, "agent-a");
    await sendMessage(fix, "agent-a", "all", { text: "msg1" });
    await sendMessage(fix, "agent-a", "all", { text: "msg2" });

    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}?after=0&include_self=true`, {
      headers: { ...participantAuthHeaders(fix, "agent-a") },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RoomMessage[]; cursor: number };
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(body.cursor).toBeGreaterThanOrEqual(2);

    const res2 = await readMessages(fix, "agent-a", body.cursor);
    const body2 = (await res2.json()) as { messages: RoomMessage[] };
    expect(body2.messages.length).toBe(0);
  });

  it("tracks read state per participant for recent and all message reads", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await sendMessage(fix, "agent-a", "all", { text: "first" });

    const firstRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: { ...participantAuthHeaders(fix, "agent-b") },
    }));
    const firstBody = (await firstRead.json()) as { mode: string; messages: RoomMessage[] };
    expect(firstBody.mode).toBe("recent");
    expect(firstBody.messages.some((m) => decodedPayload<{ text?: string }>(m.body).text === "first")).toBe(true);

    const secondRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: { ...participantAuthHeaders(fix, "agent-b") },
    }));
    const secondBody = (await secondRead.json()) as { messages: RoomMessage[] };
    expect(secondBody.messages.length).toBe(0);

    await sendMessage(fix, "agent-a", "all", { text: "second" });
    const recentRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: { ...participantAuthHeaders(fix, "agent-b") },
    }));
    const recentBody = (await recentRead.json()) as { messages: RoomMessage[] };
    expect(recentBody.messages.map((m) => decodedPayload<{ text?: string }>(m.body).text)).toEqual(["second"]);

    const allRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}?view=all`, {
      headers: { ...participantAuthHeaders(fix, "agent-b") },
    }));
    const allBody = (await allRead.json()) as { mode: string; messages: RoomMessage[] };
    expect(allBody.mode).toBe("all");
    const userMessages = allBody.messages.filter((m) => m.intent === "notify");
    expect(userMessages.map((m) => decodedPayload<{ text?: string }>(m.body).text)).toEqual(["first", "second"]);
  });

  it("read markers are isolated per participant", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await joinParticipant(fix, "agent-c");
    await sendMessage(fix, "agent-a", "all", { text: "shared" });

    await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: { ...participantAuthHeaders(fix, "agent-b") },
    }));

    const cRead = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      headers: { ...participantAuthHeaders(fix, "agent-c") },
    }));
    const cBody = (await cRead.json()) as { messages: RoomMessage[] };
    expect(cBody.messages.some((m) => decodedPayload<{ text?: string }>(m.body).text === "shared")).toBe(true);
  });

  it("emits a participant.joined system message when a participant joins", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}?view=all`, {
      headers: { ...participantAuthHeaders(fix, "agent-a") },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RoomMessage[] };
    const joined = body.messages.find((m) => m.intent === "participant.joined");
    expect(joined).toBeDefined();
    expect(joined!.from).toBe("system");
    expect(joined!.to).toBe("all");
    expect(joined!.body).toMatchObject({
      participant_id: "agent-a",
      room_id: fix.roomId,
      host_id: "host",
    });
  });

  it("rejects encrypted send if sender has not announced an encryption key", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await announceKey(fix, "agent-b");

    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "agent-b", body: { encrypted: true, ciphertext: "c", iv: "i" } }),
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "sender has not announced encryption key" });
  });

  it("rejects encrypted send if a recipient has not announced an encryption key", async () => {
    await joinParticipant(fix, "agent-a");
    await joinParticipant(fix, "agent-b");
    await announceKey(fix, "agent-a");

    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ to: "agent-b", body: { encrypted: true, ciphertext: "c", iv: "i" } }),
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "recipient encryption keys are missing",
      missing_participants: ["agent-b"],
    });
  });

  it("extends the invite TTL for the host with the default", async () => {
    await joinParticipant(fix, "host");
    const before = Date.now();
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/extend`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "host") },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; extended_ms: number; expires_at: string };
    expect(body.ok).toBe(true);
    expect(body.extended_ms).toBe(DEFAULT_EXTEND_MS);
    expect(Date.parse(body.expires_at)).toBeGreaterThan(before + 10 * 60_000);
  });

  it("extends the invite TTL by a custom extend_ms", async () => {
    await joinParticipant(fix, "host");
    const extend = 2 * MIN_INVITE_TTL_MS;
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/extend`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
      body: JSON.stringify({ extend_ms: extend }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extended_ms: number };
    expect(body.extended_ms).toBe(extend);
  });

  it("rejects /extend for non-host callers", async () => {
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/extend`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "agent-a") },
    }));
    expect(res.status).toBe(403);
  });

  it("caps /extend so expiresAt never exceeds the maximum TTL from now", async () => {
    await joinParticipant(fix, "host");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/extend`, {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
      body: JSON.stringify({ extend_ms: 99 * MAX_INVITE_TTL_MS }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expires_at: string };
    expect(Date.parse(body.expires_at)).toBeLessThanOrEqual(Date.now() + MAX_INVITE_TTL_MS + 1000);
  });
});

describe("participant profile updates", () => {
  it("persists public_key on a profile PATCH so peers can encrypt to the participant", async () => {
    const fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(
      `https://room${fix.roomPath}/participants/agent-a`,
      {
        method: "PATCH",
        headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
        body: JSON.stringify({ public_key: "raw-base64url-public-key" }),
      },
    ));
    expect(res.status).toBe(200);
    const parts = await getRoomJson<{ participants: Array<{ id: string; public_key?: string }> }>(fix, "/participants");
    expect(parts.participants.find((p) => p.id === "agent-a")?.public_key).toBe("raw-base64url-public-key");
  });
});

describe("/events subscription auth", () => {
  it("rejects non-host subscribers who have not joined", async () => {
    const fix = await bootstrapRoom();
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/events`, {
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "ghost" },
    }));
    expect(res.status).toBe(403);
  });

  it("allows the host to subscribe with a participant token", async () => {
    const fix = await bootstrapRoom({ hostId: "host" });
    await joinParticipant(fix, "host");
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/events`, {
      headers: { ...participantAuthHeaders(fix, "host") },
    }));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});

describe("query-param auth fallback", () => {
  it.each(["s", "token"])("accepts a participant token via ?%s=", async (param) => {
    const fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(
      `https://room${fix.roomPath}/status?${param}=${encodeURIComponent(fix.participantTokens["agent-a"])}`,
    ));
    expect(res.status).toBe(200);
  });

  it.each(["s", "token"])("rejects join_secret via ?%s=", async (param) => {
    const fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
    const res = await fix.session.fetch(new Request(
      `https://room${fix.roomPath}/status?${param}=${encodeURIComponent(fix.joinSecret)}`,
    ));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "participant token is required" });
  });
});

describe("__cleanup endpoint", () => {
  async function postCleanup(fix: RoomFixture): Promise<{ ok: boolean; deleted?: boolean; reason?: string }> {
    const res = await fix.session.fetch(new Request("https://rendezvous.internal/__cleanup", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as { ok: boolean; deleted?: boolean; reason?: string };
  }

  it("deletes a room with no active participants", async () => {
    const fix = await bootstrapRoom();
    expect(await postCleanup(fix)).toMatchObject({ ok: true, deleted: true });
  });

  it("keeps an active room", async () => {
    const fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
    expect(await postCleanup(fix)).toMatchObject({ ok: true, deleted: false });
  });

  it("deletes a closed room even with active participants", async () => {
    const fix = await bootstrapRoom({ phase: "closed" });
    await joinParticipant(fix, "agent-a");
    expect(await postCleanup(fix)).toMatchObject({ ok: true, deleted: true });
  });

  it("returns ok with reason:missing when room never existed", async () => {
    const fix = await bootstrapRoom();
    await postCleanup(fix);
    expect(await postCleanup(fix)).toMatchObject({ ok: true, deleted: true, reason: "missing" });
  });

  it("clearly reports when a room has been deleted", async () => {
    const fix = await bootstrapRoom();
    await postCleanup(fix);

    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/status`, {
      headers: { authorization: `Bearer ${fix.joinSecret}` },
    }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "room not found",
      reason: "room does not exist or has been deleted",
      deleted: true,
    });
  });
});
