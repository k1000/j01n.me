/**
 * Activity keepalive: every state-changing room write must move the same ACTIVE_ROOM_GRACE_MS sliding window,
 * while a silent room still dies and the hard cap stays final.
 *
 * The mutation paths are enumerated here on purpose: messages used to be the only writer that pushed the
 * expiry out. Board, participant, ask, read and system-announcement writes now share RoomStorage.putInvite,
 * which is the single place that applies touchRoomActivity().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_ROOM_GRACE_MS, DEFAULT_EXTEND_MS } from "../src/constants";
import { ROOM_ACTIVITY_HARD_CAP_MS, touchRoomActivity } from "../src/room/storage";
import type { InviteState } from "../src/types";
import {
  bootstrapRoom,
  createMockState,
  encryptedPayload,
  joinParticipant,
  participantAuthHeaders,
  readMessages,
  roomRequest,
  sendMessage,
  type RoomFixture,
} from "./room/helpers";

/** Fixed anchor: the whole suite runs on fake time, so expiry maths is exact. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** Room TTL used by the write matrix: long enough that the grace window does not mask it. */
const TTL_MS = 15 * 60_000;
/** Where the clock sits when a write happens: 6 minutes before the initial expiry. */
const WRITE_AT_MS = 9 * 60_000;

async function statusExpiry(fix: RoomFixture, who = "agent-a"): Promise<number> {
  const res = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, who) });
  expect(res.status).toBe(200);
  return Date.parse((await res.json() as { expires_at: string }).expires_at);
}

function boardPut(fix: RoomFixture, key: string, value: unknown, who = "agent-a"): Promise<Response> {
  return roomRequest(fix, `/board/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { ...participantAuthHeaders(fix, who), "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function boardDelete(fix: RoomFixture, key: string, who = "agent-a"): Promise<Response> {
  await boardPut(fix, key, { title: "temporary", status: "open" }, who);
  return roomRequest(fix, `/board/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: participantAuthHeaders(fix, who),
  });
}

async function askAndAnswer(fix: RoomFixture): Promise<Response> {
  const ask = await roomRequest(fix, "", {
    method: "POST",
    headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
    body: JSON.stringify({
      to: "agent-b",
      kind: "question",
      body: encryptedPayload({ text: "may I edit this file?" }),
    }),
  });
  expect(ask.status).toBe(200);
  const { id } = await ask.json() as { id: string };
  return roomRequest(fix, "", {
    method: "POST",
    headers: { ...participantAuthHeaders(fix, "agent-b"), "content-type": "application/json" },
    body: JSON.stringify({
      to: "agent-a",
      reply_to: id,
      body: encryptedPayload({ text: "yes, go ahead" }),
    }),
  });
}

/** A room seeded at T0 with a host and two workers, the clock moved to WRITE_AT_MS. Idempotent, so cases can reuse it. */
async function roomNearExpiry(): Promise<RoomFixture> {
  vi.setSystemTime(T0);
  const fix = await bootstrapRoom({ expiresInMs: TTL_MS });
  for (const id of ["host", "agent-a", "agent-b"]) {
    const res = await joinParticipant(fix, id);
    expect(res.status).toBe(200);
  }
  // The join writes are activity, but the 15-minute TTL already covers the grace window.
  expect(await statusExpiry(fix)).toBe(T0 + TTL_MS);
  vi.setSystemTime(T0 + WRITE_AT_MS);
  return fix;
}

describe("touchRoomActivity()", () => {
  const invite = (overrides: Partial<InviteState>) => ({ expiresAt: 0, ...overrides }) as InviteState;

  it("raises a near expiry to the grace window and never lowers one further ahead", () => {
    const near = touchRoomActivity(invite({ expiresAt: T0 + 60_000 }), T0);
    expect(near.expiresAt).toBe(T0 + ACTIVE_ROOM_GRACE_MS);

    const ahead = touchRoomActivity(invite({ expiresAt: T0 + 2 * ACTIVE_ROOM_GRACE_MS }), T0);
    expect(ahead.expiresAt).toBe(T0 + 2 * ACTIVE_ROOM_GRACE_MS);
    // The first touch anchors the hard cap, so later activity cannot slide it forward.
    expect(near.activityCapAt).toBe(T0 + ROOM_ACTIVITY_HARD_CAP_MS);
  });

  it("stops the sliding window at the hard cap", () => {
    const capped = touchRoomActivity(invite({ expiresAt: T0, activityCapAt: T0 + 2 * ACTIVE_ROOM_GRACE_MS }), T0 + ACTIVE_ROOM_GRACE_MS);
    expect(capped.expiresAt).toBe(T0 + 2 * ACTIVE_ROOM_GRACE_MS);
    expect(capped.activityCapAt).toBe(T0 + 2 * ACTIVE_ROOM_GRACE_MS);
  });
});

describe("room activity keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creating a room is not activity: the host-chosen TTL is honored", async () => {
    const state = createMockState();
    await bootstrapRoom({ expiresInMs: 60_000 }, state);
    const stored = await state.storage.get<InviteState>("invite");
    expect(stored?.expiresAt).toBe(T0 + 60_000);
    expect(stored?.activityCapAt).toBeUndefined();
  });

  it("routes every state-changing room write through the same activity touch", async () => {
    const paths: Array<{ label: string; run: (fix: RoomFixture) => Promise<Response> }> = [
      { label: "message send", run: (fix) => sendMessage(fix, "agent-a", "all", { text: "still working" }) },
      { label: "ask accept and answer", run: askAndAnswer },
      { label: "board PUT (task claim)", run: (fix) => boardPut(fix, "task.t1", { title: "keepalive", status: "claimed", owner: "agent-a" }) },
      { label: "board PATCH (assign)", run: (fix) => roomRequest(fix, "/board", {
        method: "PATCH",
        headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
        body: JSON.stringify({ "task.t2": { title: "audit", status: "claimed", owner: "agent-b", assigned_by: "host" } }),
      }) },
      { label: "board DELETE", run: (fix) => boardDelete(fix, "task.t3") },
      { label: "board batch DELETE", run: (fix) => roomRequest(fix, "/board/delete", {
        method: "POST",
        headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
        body: JSON.stringify({ keys: ["notes.a"] }),
      }) },
      { label: "participant join", run: (fix) => joinParticipant(fix, "agent-c") },
      { label: "participant status write", run: (fix) => roomRequest(fix, "/participants/agent-a", {
        method: "PATCH",
        headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
        body: JSON.stringify({ state: "busy", status: "running tests" }),
      }) },
      { label: "read receipt (sync)", run: (fix) => readMessages(fix, "agent-a") },
      { label: "host transfer", run: (fix) => roomRequest(fix, "/host", {
        method: "POST",
        headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
        body: JSON.stringify({ to: "agent-a" }),
      }) },
      { label: "webhook create", run: (fix) => roomRequest(fix, "/hooks", {
        method: "POST",
        headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.invalid/j01n" }),
      }) },
    ];

    for (const { label, run } of paths) {
      const fix = await roomNearExpiry();
      const response = await run(fix);
      const detail = `${label} -> ${response.status} ${await response.clone().text()}`;
      expect(response.status, detail).toBeLessThan(400);
      const expiry = await statusExpiry(fix);
      expect(expiry, `${label} keeps ${ACTIVE_ROOM_GRACE_MS / 60_000} more minutes`).toBeGreaterThanOrEqual(T0 + WRITE_AT_MS + ACTIVE_ROOM_GRACE_MS - 1_000);
      expect(expiry, `${label} does not outrun the grace window`).toBeLessThanOrEqual(T0 + WRITE_AT_MS + ACTIVE_ROOM_GRACE_MS + 1_000);
    }
  });

  it("keeps a room whose board was written past the initial expiry but inside the grace window", async () => {
    const fix = await roomNearExpiry();
    const claim = await boardPut(fix, "task.t1", { title: "keepalive", status: "claimed", owner: "agent-a" });
    expect(claim.status).toBe(200);
    const expiresAt = await statusExpiry(fix);
    expect(expiresAt).toBe(T0 + WRITE_AT_MS + ACTIVE_ROOM_GRACE_MS);

    // Past the TTL the room was created with, still alive because the write moved the window.
    vi.setSystemTime(T0 + TTL_MS + 2 * 60_000);
    // The alarm tick (the sweeper's own path) reschedules instead of deleting: the room is not idle.
    await fix.session.alarm();
    const alive = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(alive.status).toBe(200);
    expect((await alive.json() as { message_count?: number }).message_count).toBeDefined();
    // and a read still works
    expect((await readMessages(fix, "agent-a")).status).toBe(200);
  });

  it("sweeps a silent room on its alarm tick once the grace window passes", async () => {
    const fix = await roomNearExpiry();
    await sendMessage(fix, "agent-a", "all", { text: "last word" });
    const expiresAt = await statusExpiry(fix);

    vi.setSystemTime(expiresAt + 1_000);
    await fix.session.alarm();
    expect((await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") })).status).toBe(404);
  });

  it("deletes a silent room once its grace window passes", async () => {
    const fix = await roomNearExpiry();
    await sendMessage(fix, "agent-a", "all", { text: "last word" });
    const expiresAt = await statusExpiry(fix);
    expect(expiresAt).toBe(T0 + WRITE_AT_MS + ACTIVE_ROOM_GRACE_MS);

    vi.setSystemTime(expiresAt + 1_000);
    const gone = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ reason: "room invite expired and the room was deleted", expired: true });
    // Storage was wiped: the room no longer exists at all.
    const missing = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(missing.status).toBe(404);
  });

  it("keeps the hard cap final: endless activity cannot keep a room alive past it", async () => {
    const fix = await roomNearExpiry();
    // One write every 5 minutes for the whole 12 hours: inside the 10 minute grace window, so the room must live.
    for (let elapsed = WRITE_AT_MS; elapsed < ROOM_ACTIVITY_HARD_CAP_MS - 60_000; elapsed += 5 * 60_000) {
      vi.setSystemTime(T0 + elapsed);
      expect((await sendMessage(fix, "agent-a", "all", { text: `ping ${elapsed}` })).status).toBe(200);
      expect(await statusExpiry(fix)).toBeLessThanOrEqual(T0 + ROOM_ACTIVITY_HARD_CAP_MS);
    }

    // The last activity before the cap is clamped to it instead of sliding past it.
    vi.setSystemTime(T0 + ROOM_ACTIVITY_HARD_CAP_MS - 30_000);
    expect((await sendMessage(fix, "agent-a", "all", { text: "one last ping" })).status).toBe(200);
    expect(await statusExpiry(fix)).toBe(T0 + ROOM_ACTIVITY_HARD_CAP_MS);

    vi.setSystemTime(T0 + ROOM_ACTIVITY_HARD_CAP_MS + 1_000);
    const gone = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(gone.status).toBe(410);
    expect((await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") })).status).toBe(404);
  });

  it("reports the expiry that was actually stored when /extend is shorter than the grace window", async () => {
    const fix = await roomNearExpiry();
    // One minute before the initial expiry: a 5 minute extend would land inside the 10 minute grace window.
    vi.setSystemTime(T0 + TTL_MS - 60_000);
    const res = await roomRequest(fix, "/extend", {
      method: "POST",
      headers: participantAuthHeaders(fix, "host"),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { extended_ms: number; expires_at: string };
    expect(body.extended_ms).toBe(DEFAULT_EXTEND_MS);
    // DEFAULT_EXTEND_MS (5 min) lands before the grace floor, so the floor wins and the answer says so.
    expect(Date.parse(body.expires_at)).toBeGreaterThan(T0 + TTL_MS - 60_000 + body.extended_ms);
    expect(Date.parse(body.expires_at)).toBe(T0 + TTL_MS - 60_000 + ACTIVE_ROOM_GRACE_MS);
    expect(await statusExpiry(fix)).toBe(Date.parse(body.expires_at));
  });
});
