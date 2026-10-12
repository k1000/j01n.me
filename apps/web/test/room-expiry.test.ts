/**
 * The ACTIVE_ROOM_GRACE_MS sliding window: state-changing room writes move it, plain GET polls do not.
 *
 * Before this, only a message send pushed the expiry out, so a room could expire mid-work while agents were
 * claiming tasks, writing the board or announcing a profile. Each mutation call site now shares
 * touchRoomActivity() from apps/web/src/room/storage.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_ROOM_GRACE_MS, MAX_INVITE_TTL_MS } from "../src/constants";
import { touchRoomActivity } from "../src/room/storage";
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

/** Fixed anchor: this suite runs on fake time, so the expiry maths is exact. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** Room TTL for these cases: longer than the grace window, so a write is what keeps the room. */
const TTL_MS = 15 * 60_000;
/** Clock position for "about to expire": one minute before the initial expiry. */
const NEAR_MS = TTL_MS - 60_000;

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

/** Clock back to one minute before the window the previous write opened, so the next write has to move it. */
function atTheEdgeAgain(): void {
  vi.setSystemTime(T0 + NEAR_MS + ACTIVE_ROOM_GRACE_MS - 60_000);
}

/** Host + two workers joined at T0, then the clock sits one minute before the initial expiry. */
async function roomAboutToExpire(): Promise<RoomFixture> {
  vi.setSystemTime(T0);
  const fix = await bootstrapRoom({ expiresInMs: TTL_MS });
  for (const id of ["host", "agent-a", "agent-b"]) {
    expect((await joinParticipant(fix, id)).status).toBe(200);
  }
  // The 15 minute TTL already covers the grace window, so the joins had nothing to move.
  expect(await statusExpiry(fix)).toBe(T0 + TTL_MS);
  vi.setSystemTime(T0 + NEAR_MS);
  return fix;
}

describe("touchRoomActivity()", () => {
  it("raises a near expiry to the grace window and never lowers one further ahead", () => {
    expect(touchRoomActivity({ expiresAt: T0 + 60_000 } as InviteState, T0).expiresAt).toBe(T0 + ACTIVE_ROOM_GRACE_MS);
    expect(touchRoomActivity({ expiresAt: T0 + MAX_INVITE_TTL_MS } as InviteState, T0).expiresAt).toBe(T0 + MAX_INVITE_TTL_MS);
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

  it("moves the window on every state-changing room write", async () => {
    const post = (fix: RoomFixture, who: string, body: Record<string, unknown>) => roomRequest(fix, "", {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, who), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const writes: Array<{ label: string; run: (fix: RoomFixture) => Promise<Response> }> = [
      { label: "message send", run: (fix) => sendMessage(fix, "agent-a", "all", { text: "still working" }) },
      {
        label: "ask and answer",
        run: async (fix) => {
          const ask = await post(fix, "agent-a", { to: "agent-b", kind: "question", body: encryptedPayload({ text: "may I edit this?" }) });
          expect(ask.status).toBe(200);
          const { id } = await ask.json() as { id: string };
          atTheEdgeAgain();
          return post(fix, "agent-b", { to: "agent-a", reply_to: id, body: encryptedPayload({ text: "yes" }) });
        },
      },
      { label: "board PUT (task claim)", run: (fix) => boardPut(fix, "task.t1", { title: "keepalive", status: "claimed", owner: "agent-a" }) },
      {
        label: "board PATCH (assign)",
        run: (fix) => roomRequest(fix, "/board", {
          method: "PATCH",
          headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
          body: JSON.stringify({ "task.t2": { title: "audit", status: "claimed", owner: "agent-b", assigned_by: "host" } }),
        }),
      },
      {
        label: "board DELETE",
        run: async (fix) => {
          // Seed the key while the room is fresh, then come back to the edge and delete it.
          expect((await boardPut(fix, "task.t3", { title: "temporary", status: "open" })).status).toBe(200);
          atTheEdgeAgain();
          return roomRequest(fix, "/board/task.t3", { method: "DELETE", headers: participantAuthHeaders(fix, "agent-a") });
        },
      },
      {
        label: "board batch DELETE",
        run: async (fix) => {
          expect((await boardPut(fix, "notes.a", { text: "temporary" })).status).toBe(200);
          atTheEdgeAgain();
          return roomRequest(fix, "/board/delete", {
            method: "POST",
            headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
            body: JSON.stringify({ keys: ["notes.a"] }),
          });
        },
      },
      { label: "participant join", run: (fix) => joinParticipant(fix, "agent-c") },
      {
        label: "participant status write",
        run: (fix) => roomRequest(fix, "/participants/agent-a", {
          method: "PATCH",
          headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
          body: JSON.stringify({ state: "busy", status: "running tests" }),
        }),
      },
      {
        label: "host transfer announcement",
        run: (fix) => roomRequest(fix, "/host", {
          method: "POST",
          headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
          body: JSON.stringify({ to: "agent-a" }),
        }),
      },
      {
        label: "webhook create",
        run: (fix) => roomRequest(fix, "/hooks", {
          method: "POST",
          headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
          body: JSON.stringify({ url: "https://hooks.invalid/j01n" }),
        }),
      },
    ];

    for (const { label, run } of writes) {
      const fix = await roomAboutToExpire();
      const response = await run(fix);
      const body = await response.text();
      expect(response.status, `${label} -> ${response.status} ${body}`).toBeLessThan(400);
      // Every write leaves exactly the grace window from the moment it happened.
      expect(await statusExpiry(fix), `${label} keeps ${ACTIVE_ROOM_GRACE_MS / 60_000} more minutes`)
        .toBe(Date.now() + ACTIVE_ROOM_GRACE_MS);
    }
  });

  it("keeps a room whose board write landed past the initial expiry but inside the grace window", async () => {
    const fix = await roomAboutToExpire();
    expect((await boardPut(fix, "task.t1", { title: "keepalive", status: "claimed", owner: "agent-a" })).status).toBe(200);
    const expiresAt = await statusExpiry(fix);
    expect(expiresAt).toBe(T0 + NEAR_MS + ACTIVE_ROOM_GRACE_MS);

    // Past the TTL the room was created with, still inside the window the claim opened.
    vi.setSystemTime(T0 + TTL_MS + 4 * 60_000);
    await fix.session.alarm();
    const alive = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(alive.status).toBe(200);
    expect((await alive.json() as { message_count: number }).message_count).toBeGreaterThan(0);
  });

  it("leaves plain GET reads alone: polling must not keep a room open", async () => {
    const fix = await roomAboutToExpire();
    for (const path of ["/status", "/board", "/participants", "/asks", "/?view=all"]) {
      const res = await roomRequest(fix, path, { headers: participantAuthHeaders(fix, "agent-a") });
      expect(res.status, path).toBeLessThan(400);
    }
    expect((await readMessages(fix, "agent-a")).status).toBe(200);
    // The read receipt moved, the expiry did not.
    expect(await statusExpiry(fix)).toBe(T0 + TTL_MS);
  });

  it("deletes a silent room once its grace window passes", async () => {
    const fix = await roomAboutToExpire();
    expect((await sendMessage(fix, "agent-a", "all", { text: "last word" })).status).toBe(200);
    const expiresAt = await statusExpiry(fix);
    expect(expiresAt).toBe(T0 + NEAR_MS + ACTIVE_ROOM_GRACE_MS);

    vi.setSystemTime(expiresAt + 1_000);
    const gone = await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") });
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ expired: true });
    expect((await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") })).status).toBe(404);
  });

  it("deletes a silent room on the alarm tick, which the touch does not reschedule", async () => {
    const fix = await roomAboutToExpire();
    expect((await sendMessage(fix, "agent-a", "all", { text: "last word" })).status).toBe(200);
    const expiresAt = await statusExpiry(fix);

    vi.setSystemTime(expiresAt + 1_000);
    await fix.session.alarm();
    expect((await roomRequest(fix, "/status", { headers: participantAuthHeaders(fix, "agent-a") })).status).toBe(404);
  });

  it("creating a room is not activity: the host-chosen TTL is honored", async () => {
    const state = createMockState();
    await bootstrapRoom({ expiresInMs: 60_000 }, state);
    expect((await state.storage.get<InviteState>("invite"))?.expiresAt).toBe(T0 + 60_000);
  });

  it("never lowers an expiry the host already pushed further out with /extend", async () => {
    const fix = await roomAboutToExpire();
    const extended = await roomRequest(fix, "/extend", {
      method: "POST",
      headers: { ...participantAuthHeaders(fix, "host"), "content-type": "application/json" },
      body: JSON.stringify({ extend_ms: MAX_INVITE_TTL_MS }),
    });
    expect(extended.status).toBe(200);
    const expiresAt = Date.parse((await extended.json() as { expires_at: string }).expires_at);
    // The ceiling on /extend is untouched: at most MAX_INVITE_TTL_MS from now.
    expect(expiresAt).toBeLessThanOrEqual(T0 + NEAR_MS + MAX_INVITE_TTL_MS);

    expect((await sendMessage(fix, "agent-a", "all", { text: "keep going" })).status).toBe(200);
    expect(await statusExpiry(fix)).toBe(expiresAt);
  });
});
