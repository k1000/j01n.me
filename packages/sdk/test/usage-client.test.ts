import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { RoomApiError } from "../src/errors";
import { buildMinimalInvite } from "../src/invite";
import { buildRoomClient } from "../src/room-client";
import type { RoomClient } from "../src/room-client";
import { sealForRoom } from "../src/crypto";
import { RESERVATIONS_KEY } from "../src/reservations";
import { runRoomCommand } from "../src/room-commands";
import {
  sealUsage,
  openUsage,
  nextUsage,
  roomUsage,
  usageKey,
  type UsageRow,
  type UsageTotals,
  type UsageDelta,
} from "../src/metrics";
import type { BoardEntry } from "../src/types";

const ROOM = { joinSecret: "room-secret-123456", roomId: "room-1" };

function mockBoard() {
  const board: Record<string, BoardEntry> = {};
  return {
    board,
    async get() {
      return { board: structuredClone(board), board_schema: null };
    },
    async set(key: string, value: unknown, options: { ifVersion?: number } = {}) {
      if ((board[key]?.version ?? 0) !== options.ifVersion) {
        throw new RoomApiError(409, "version conflict", "/board");
      }
      board[key] = { value, version: (board[key]?.version ?? 0) + 1, updated_by: "test", updated_at: new Date().toISOString() };
      return { ok: true as const, key, entry: board[key] };
    },
  };
}

/**
 * Simulates the reportUsage implementation from room-client.ts against a mock board.
 * This mirrors the exact logic: openUsage -> nextUsage -> sealUsage -> setBoardKey with 409 retry.
 */
async function reportUsage(
  participantId: string,
  delta: UsageDelta,
  mock: ReturnType<typeof mockBoard>,
): Promise<UsageRow> {
  const key = usageKey(participantId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const board = (await mock.get()).board;
    const entry = board[key];
    const previous = entry ? await openUsage(entry.value, participantId, ROOM.joinSecret, ROOM.roomId) : null;
    const next = nextUsage(participantId, previous, delta);
    const sealed = await sealUsage(next, ROOM.joinSecret, ROOM.roomId);
    try {
      await mock.set(key, sealed, { ifVersion: entry?.version ?? 0 });
      return { participant: participantId, key, version: (entry?.version ?? 0) + 1, snapshot: next, stale: false };
    } catch (error) {
      if (error instanceof RoomApiError && error.status === 409) continue;
      throw error;
    }
  }
  throw new Error("reportUsage kept failing on version conflicts; try again");
}

/**
 * Simulates the usageReport implementation from room-client.ts against a mock board.
 */
async function usageReport(
  mock: ReturnType<typeof mockBoard>,
  participants: string[],
  nowMs = Date.now(),
): Promise<{ rows: UsageRow[]; totals: UsageTotals; reported: number; stale: number }> {
  const board = (await mock.get()).board;
  return roomUsage(board, {
    joinSecret: ROOM.joinSecret,
    roomId: ROOM.roomId,
    participants,
    nowMs,
  });
}

describe("reportUsage", () => {
  it("writes a sealed snapshot to usage.<participantId> on first report", async () => {
    const mock = mockBoard();
    const result = await reportUsage("worker-2", { active_ms: 60000, input_tokens: 1000, output_tokens: 200, model: "claude-sonnet", provider: "anthropic" }, mock);

    expect(result.participant).toBe("worker-2");
    expect(result.key).toBe("usage.worker-2");
    expect(result.version).toBe(1);
    expect(result.snapshot).toMatchObject({
      participant: "worker-2",
      reports: 1,
      active_ms: 60000,
      input_tokens: 1000,
      output_tokens: 200,
      model: "claude-sonnet",
      provider: "anthropic",
    });
    expect(result.stale).toBe(false);

    // Verify the board value is sealed
    const sealed = mock.board["usage.worker-2"].value;
    expect(typeof sealed).toBe("string");
    expect(sealed).toMatch(/^jsk1:/);

    // Verify we can open it
    const opened = await openUsage(sealed as string, "worker-2", ROOM.joinSecret, ROOM.roomId);
    expect(opened).toMatchObject({ participant: "worker-2", active_ms: 60000, input_tokens: 1000 });
  });

  it("accumulates deltas on top of the previous snapshot", async () => {
    const mock = mockBoard();
    await reportUsage("worker-2", { active_ms: 60000, input_tokens: 1000 }, mock);
    const result = await reportUsage("worker-2", { active_ms: 30000, input_tokens: 500, output_tokens: 100 }, mock);

    expect(result.snapshot).toMatchObject({
      reports: 2,
      active_ms: 90000,
      input_tokens: 1500,
      output_tokens: 100,
    });
  });

  it("retries on 409 version conflicts", async () => {
    const mock = mockBoard();
    let setCalls = 0;
    const origSet = mock.set.bind(mock);
    mock.set = async (key: string, value: unknown, options: { ifVersion?: number } = {}) => {
      setCalls++;
      if (setCalls === 1) throw new RoomApiError(409, "version conflict", "/board");
      return origSet(key, value, options);
    };

    const result = await reportUsage("worker-2", { active_ms: 60000 }, mock);
    expect(setCalls).toBe(2);
    expect(result.snapshot).toMatchObject({ active_ms: 60000, reports: 1 });
  });

  it("rejects invalid participant IDs", async () => {
    const mock = mockBoard();
    await expect(reportUsage("worker/2", { active_ms: 60000 }, mock)).rejects.toThrow(/invalid participant id/);
  });

  it("cost_usd accumulates correctly across reports", async () => {
    const mock = mockBoard();
    await reportUsage("worker-1", { active_ms: 60000, input_tokens: 1000, cost_usd: 0.1 }, mock);
    const result = await reportUsage("worker-1", { active_ms: 30000, input_tokens: 500, cost_usd: 0.05 }, mock);

    expect(result.snapshot).toMatchObject({
      reports: 2,
      active_ms: 90000,
      input_tokens: 1500,
      cost_usd: 0.15,
    });
  });

  it("model and provider carry forward from previous reports", async () => {
    const mock = mockBoard();
    await reportUsage("worker-1", { active_ms: 60000, model: "claude-sonnet", provider: "anthropic" }, mock);
    const result = await reportUsage("worker-1", { active_ms: 30000 }, mock);

    expect(result.snapshot).toMatchObject({
      reports: 2,
      active_ms: 90000,
      model: "claude-sonnet",
      provider: "anthropic",
    });
  });

  it("a new model overrides the previous one", async () => {
    const mock = mockBoard();
    await reportUsage("worker-1", { active_ms: 60000, model: "claude-sonnet", provider: "anthropic" }, mock);
    const result = await reportUsage("worker-1", { active_ms: 30000, model: "gpt-5", provider: "openai" }, mock);

    expect(result.snapshot).toMatchObject({
      reports: 2,
      model: "gpt-5",
      provider: "openai",
    });
  });
});

describe("usageReport", () => {
  it("returns rows and totals for all participants", async () => {
    const mock = mockBoard();
    const sealed = await sealUsage(
      { participant: "worker-1", reports: 2, updated_at: "2026-01-15T12:00:00.000Z", active_ms: 60000, input_tokens: 1000, output_tokens: 500, cost_usd: 0.2, model: "claude-sonnet" },
      ROOM.joinSecret,
      ROOM.roomId,
    );
    mock.board["usage.worker-1"] = { value: sealed, version: 1, updated_by: "worker-1", updated_at: "2026-01-15T12:00:00.000Z" };

    // Use a nowMs that's within 15 minutes of worker-1's snapshot
    const nowMs = Date.parse("2026-01-15T12:10:00.000Z");
    const report = await usageReport(mock, ["worker-1", "worker-2"], nowMs);

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].participant).toBe("worker-1");
    expect(report.rows[0].snapshot).toMatchObject({ active_ms: 60000, input_tokens: 1000 });
    expect(report.rows[1].participant).toBe("worker-2");
    expect(report.rows[1].snapshot).toBeNull();
    expect(report.rows[1].stale).toBe(true);

    expect(report.totals).toMatchObject({
      participants: 1,
      active_ms: 60000,
      input_tokens: 1000,
      output_tokens: 500,
      tokens: 1500,
      cost_usd: 0.2,
    });
    expect(report.reported).toBe(1);
    expect(report.stale).toBe(1);
  });

  it("handles an empty board", async () => {
    const mock = mockBoard();
    const report = await usageReport(mock, []);
    expect(report.rows).toHaveLength(0);
    expect(report.totals).toMatchObject({ participants: 0, active_ms: 0, input_tokens: 0, output_tokens: 0, tokens: 0, cost_usd: 0 });
    expect(report.reported).toBe(0);
    expect(report.stale).toBe(0);
  });

  it("marks stale snapshots correctly", async () => {
    const mock = mockBoard();
    const stale = await sealUsage(
      { participant: "worker-1", reports: 1, updated_at: "2026-01-15T10:00:00.000Z", active_ms: 30000, input_tokens: 500, output_tokens: 100, cost_usd: 0.1 },
      ROOM.joinSecret,
      ROOM.roomId,
    );
    mock.board["usage.worker-1"] = { value: stale, version: 1, updated_by: "worker-1", updated_at: "2026-01-15T10:00:00.000Z" };

    const report = await usageReport(mock, []);
    expect(report.rows[0].stale).toBe(true);
  });

  it("aggregates multiple reporters into the room total", async () => {
    const mock = mockBoard();
    const a = await sealUsage(
      { participant: "a", reports: 1, updated_at: "2026-01-15T12:00:00.000Z", active_ms: 60000, input_tokens: 1000, output_tokens: 500, cost_usd: 0.1 },
      ROOM.joinSecret,
      ROOM.roomId,
    );
    const b = await sealUsage(
      { participant: "b", reports: 3, updated_at: "2026-01-15T12:00:00.000Z", active_ms: 120000, input_tokens: 2000, output_tokens: 1000, cost_usd: 0.2 },
      ROOM.joinSecret,
      ROOM.roomId,
    );
    mock.board["usage.a"] = { value: a, version: 1, updated_by: "a", updated_at: "2026-01-15T12:00:00.000Z" };
    mock.board["usage.b"] = { value: b, version: 3, updated_by: "b", updated_at: "2026-01-15T12:00:00.000Z" };

    const report = await usageReport(mock, ["a", "b"]);

    expect(report.rows).toHaveLength(2);
    expect(report.reported).toBe(2);
    expect(report.totals).toMatchObject({
      participants: 2,
      active_ms: 180000,
      input_tokens: 3000,
      output_tokens: 1500,
      tokens: 4500,
      cost_usd: 0.3,
    });
  });
});

/**
 * The room endpoints a usage report touches: board read, one guarded board write, and the participant list.
 * Requests authenticate either with the room join secret (room-link form) or with a participant token (profile
 * file and env forms); the board value is always sealed with the room key, so every form leaves rows that the
 * other forms can read.
 */
function usageRoom(joinSecret: string, participants = ["worker-1", "worker-2"]) {
  const roomUrl = "https://usage.test/r/usage-room";
  const path = new URL(roomUrl).pathname;
  const tokens = new Map(participants.map((id) => [id, `participant-token-for-${id}`]));
  const board: Record<string, BoardEntry> = {};
  const writes: Array<{ key: string; auth: "join_secret" | "participant_token" }> = [];
  const transportFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers ?? {}).get("authorization") ?? "";
    const tokenHolder = [...tokens].find(([, token]) => auth === `Bearer ${token}`)?.[0];
    if (auth !== `Bearer ${joinSecret}` && !tokenHolder) return Response.json({ error: "forbidden" }, { status: 403 });
    if (url.pathname === `${path}/board` && (init?.method ?? "GET") === "GET") {
      return Response.json({ board: structuredClone(board), board_schema: null, board_acls: {} });
    }
    const keyed = /^\/r\/usage-room\/board\/(.+)$/.exec(url.pathname);
    if (keyed && init?.method === "PUT") {
      const key = decodeURIComponent(keyed[1]);
      if ((board[key]?.version ?? 0) !== Number(url.searchParams.get("if_version"))) {
        return Response.json({ error: "version conflict" }, { status: 409 });
      }
      board[key] = {
        value: JSON.parse(String(init.body)), version: (board[key]?.version ?? 0) + 1,
        updated_by: tokenHolder ?? joinSecret, updated_at: new Date().toISOString(),
      };
      writes.push({ key, auth: tokenHolder ? "participant_token" : "join_secret" });
      return Response.json({ ok: true, key, entry: board[key] });
    }
    if (url.pathname === `${path}/participants`) {
      return Response.json({ participants: participants.map((id) => ({ id, state: "free", joined_at: "2026-01-15T12:00:00.000Z" })) });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
  return { board, roomUrl, token: (id: string) => tokens.get(id) as string, transportFetch, writes };
}

/** A client the way each helper auth form builds one: the seal key plus, when the form has one, the request token. */
async function usageClientFor(room: ReturnType<typeof usageRoom>, participant: string, options: { sealSecret: string; participantToken?: string }) {
  return buildRoomClient(
    {
      ...buildMinimalInvite(room.roomUrl, options.sealSecret),
      transportFetch: room.transportFetch,
      ...(options.participantToken ? { participant_token: options.participantToken } : {}),
    },
    participant,
    0,
  );
}

describe("room-sealed usage across the helper auth forms", () => {
  const JOIN_SECRET = "room-join-secret-for-usage-test";

  it("reports through the profile-file form (token auth, room key seal) and reads it back through a second participant client", async () => {
    const room = usageRoom(JOIN_SECRET);
    const reporter = await usageClientFor(room, "worker-1", { sealSecret: JOIN_SECRET, participantToken: room.token("worker-1") });
    const row = await reporter.reportUsage({ active_ms: 60_000, input_tokens: 1_000, output_tokens: 200, cost_usd: 0.1, model: "claude-sonnet", provider: "anthropic" });

    expect(room.writes).toEqual([{ key: "usage.worker-1", auth: "participant_token" }]);

    const reader = await usageClientFor(room, "worker-2", { sealSecret: JOIN_SECRET, participantToken: room.token("worker-2") });
    const report = await reader.usageReport();
    expect(report.rows.find((entry) => entry.participant === "worker-1")?.snapshot).toEqual(row.snapshot);
    expect(report.reported).toBe(1);
    expect(report.totals).toMatchObject({ participants: 1, active_ms: 60_000, input_tokens: 1_000, output_tokens: 200, tokens: 1_200 });
  });

  it("regression: a row sealed with a participant token instead of the room key stays unreadable to the room", async () => {
    const room = usageRoom(JOIN_SECRET);
    // What `usage <profile.json> <me> report` did from a directory without a key file: the token became the seal key.
    const broken = await usageClientFor(room, "worker-1", { sealSecret: room.token("worker-1"), participantToken: room.token("worker-1") });
    const row = await broken.reportUsage({ active_ms: 60_000 });

    expect(row.version).toBe(1);
    const reader = await usageClientFor(room, "worker-2", { sealSecret: JOIN_SECRET });
    const report = await reader.usageReport();
    expect(report.rows.find((entry) => entry.participant === "worker-1")?.snapshot).toBeNull();
    expect(report.reported).toBe(0);
    expect(await openUsage(room.board["usage.worker-1"].value, "worker-1", JOIN_SECRET, "usage-room")).toBeNull();
  });

  it("keeps accumulating deltas across the room-link and profile-file forms, so both read one equal snapshot", async () => {
    const room = usageRoom(JOIN_SECRET);
    const byLink = await usageClientFor(room, "worker-1", { sealSecret: JOIN_SECRET });
    await byLink.reportUsage({ active_ms: 60_000, input_tokens: 1_000 });
    const byProfile = await usageClientFor(room, "worker-1", { sealSecret: JOIN_SECRET, participantToken: room.token("worker-1") });
    const row = await byProfile.reportUsage({ active_ms: 30_000, input_tokens: 500, output_tokens: 100 });

    const reader = await usageClientFor(room, "worker-2", { sealSecret: JOIN_SECRET, participantToken: room.token("worker-2") });
    expect((await reader.usageReport()).rows.find((entry) => entry.participant === "worker-1")?.snapshot).toEqual(row.snapshot);
    expect(row.snapshot).toMatchObject({ reports: 2, active_ms: 90_000, input_tokens: 1_500, output_tokens: 100 });
  });
});

// ── assign: the host offers an open task to a free worker ───────────────────
// client.assign() plus the `j01n assign <id> <worker> [reason]` verb: one guarded board write, one direct sealed
// task.assigned notice, and refusals that never touch the board. Both transports below are the same fake room:
// one called in-process through transportFetch, one over a real local HTTP server.

const ASSIGN = { roomId: "assign-room", joinSecret: "assign-room-secret-0123456789", checkout: "checkout-1", repo: "https://git.example/j01n.me.git" };
const TASK_FILE = "packages/sdk/src/room-client.ts";
const SHARED_FILE = "packages/sdk/src/room-commands.ts";

const assignTask = (over: Record<string, unknown> = {}) => ({
  title: "Assign verb in SDK and CLI",
  files: [TASK_FILE],
  depends_on: [],
  role: "builder",
  brief: "the host offers this task",
  status: "open",
  ...over,
});

const entry = (value: unknown, version: number): BoardEntry => ({ value, version, updated_by: "hermes-bot", updated_at: "2026-01-15T12:00:00.000Z" });

/** A reservation exactly as the room stores it: holder and checkout in plaintext, paths and reason sealed. */
const sealedReservation = (by: string, paths: string[], checkout: string, reason: string) =>
  sealForRoom({ repo: ASSIGN.repo, paths, reason }, ASSIGN.joinSecret, ASSIGN.roomId).then((sealed) => ({ by, since: "2026-01-15T12:00:00.000Z", checkout, sealed }));

interface FakeParticipant {
  id: string;
  state: "free" | "busy";
  /** The presence line; the room shows "joined" for a participant who is in the room. */
  status: string;
  role?: string;
  checkout?: string;
  public_key?: string;
  left_at?: string;
}

const defaultParticipants = (): FakeParticipant[] => [
  { id: "hermes-bot", role: "host", state: "free", status: "joined", checkout: ASSIGN.checkout },
  { id: "worker-1", role: "builder", state: "free", status: "joined", checkout: ASSIGN.checkout },
  { id: "worker-2", role: "builder", state: "free", status: "joined", checkout: ASSIGN.checkout },
];

function assignRoom(options: { participants?: FakeParticipant[]; board?: Record<string, BoardEntry> } = {}) {
  const board: Record<string, BoardEntry> = { "task.t1": entry(assignTask(), 3), ...options.board };
  const participants: FakeParticipant[] = (options.participants ?? defaultParticipants()).map((p) => ({ ...p }));
  const messages: Array<Record<string, unknown>> = [];
  const writes: Array<{ key: string; ifVersion: number | null; by: string }> = [];
  const fail = { sends: false };
  let seq = 0;

  const handle = (method: string, rawUrl: string, headers: Record<string, string>, body: unknown): { status: number; body: unknown } => {
    if ((headers["authorization"] ?? "") !== `Bearer ${ASSIGN.joinSecret}`) return { status: 403, body: { error: "forbidden" } };
    const me = headers["x-participant-id"] ?? "";
    const url = new URL(rawUrl);
    const tail = url.pathname.split("/").filter(Boolean).slice(2);
    const room = { room_id: ASSIGN.roomId, name: "assign", purpose: "assign", host_id: "hermes-bot", max_participants: 8 };
    if (method === "GET" && tail.join("/") === "participants") return { status: 200, body: { room, participants } };
    if (method === "GET" && tail.join("/") === "status") {
      return { status: 200, body: { room, participants, message_count: messages.length, last_seq: seq, oldest_seq: 1, expires_at: new Date(Date.now() + 600_000).toISOString(), closed: false } };
    }
    if (method === "GET" && tail.join("/") === "board") return { status: 200, body: { board: structuredClone(board), board_schema: null } };
    if (method === "PUT" && tail[0] === "board" && tail.length === 2) {
      const key = decodeURIComponent(tail[1]);
      const current = board[key];
      const wanted = url.searchParams.get("if_version");
      if (wanted !== null && Number(wanted) !== (current?.version ?? 0)) return { status: 409, body: { error: "version conflict", entry: current ?? null } };
      writes.push({ key, ifVersion: wanted === null ? null : Number(wanted), by: me });
      board[key] = { value: body, version: (current?.version ?? 0) + 1, updated_by: me, updated_at: new Date().toISOString() };
      return { status: 200, body: { ok: true, key, entry: board[key] } };
    }
    const posted = body as { to: unknown; body: unknown; intent?: string; kind?: string };
    if (method === "POST" && tail.length === 0) {
      if (fail.sends) return { status: 500, body: { error: "send failed" } };
      if (posted.intent === "key.exchange") {
        const row = participants.find((p) => p.id === me);
        const publicKey = (posted.body as { public_key?: string }).public_key;
        if (row && publicKey) row.public_key = publicKey;
      }
      seq += 1;
      messages.push({ id: `message-${seq}`, seq, from: me, to: posted.to, intent: posted.intent ?? "notify", ...(posted.kind ? { kind: posted.kind } : {}), body: posted.body, created_at: new Date().toISOString() });
      return { status: 200, body: { ok: true, id: `message-${seq}`, seq } };
    }
    if (method === "GET" && tail.length === 0) {
      const visible = messages.filter((m) => m.from !== me && (m.to === "all" || (Array.isArray(m.to) ? m.to.includes(me) : m.to === me)));
      return { status: 200, body: { cursor: seq, messages: visible } };
    }
    return { status: 404, body: { error: "not found" } };
  };

  const transportFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    const result = handle(init?.method ?? "GET", String(input), headers, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
    return Response.json(result.body, { status: result.status });
  }) as typeof fetch;

  const roomUrl = `https://assign.test/r/${ASSIGN.roomId}`;
  // One client per participant per room: its ECDH keypair must outlive the call, or a notice posted for the
  // announced key could not be opened by the same participant reading it back.
  const clients = new Map<string, RoomClient>();
  const client = async (id: string, options: { url?: string } = {}) => {
    const found = clients.get(id);
    if (found) return found;
    const built = await buildRoomClient(
      { ...buildMinimalInvite(options.url ?? roomUrl, ASSIGN.joinSecret), ...(options.url ? {} : { transportFetch }) },
      id,
      0,
    );
    clients.set(id, built);
    return built;
  };
  const noticeFor = async (who: RoomClient) => (await who.read()).find((m) => m.intent === "task.assigned");

  return { board, participants, messages, writes, fail, handle, roomUrl, client, noticeFor };
}

/** Announce the keys a sealed notice needs: the host encrypts for the worker and the worker decrypts as themselves. */
async function syncKeys(...clients: RoomClient[]) {
  await Promise.all(clients.map((client) => client.announceKey()));
}

describe("assign", () => {
  it("claims the task for a free worker and hands them a sealed task.assigned notice", async () => {
    const room = assignRoom();
    const host = await room.client("hermes-bot");
    const worker = await room.client("worker-1");
    await syncKeys(host, worker);

    const task = await host.assign("t1", "worker-1", { reason: "you know the SDK" });

    expect(task).toMatchObject({
      status: "claimed", owner: "worker-1", assigned: "worker-1", assigned_by: "hermes-bot", assigned_reason: "you know the SDK",
    });
    expect(task.assigned_at).toMatch(/T.+Z$/);
    // One guarded write, at the version we read.
    expect(room.writes).toEqual([{ key: "task.t1", ifVersion: 3, by: "hermes-bot" }]);
    expect(room.board["task.t1"].version).toBe(4);
    // The offer keeps the contract it was written with.
    expect(room.board["task.t1"].value).toMatchObject({ title: "Assign verb in SDK and CLI", files: [TASK_FILE], depends_on: [], role: "builder", brief: "the host offers this task", status: "claimed", owner: "worker-1" });

    const sent = room.messages.find((m) => m.intent === "task.assigned") as Record<string, unknown>;
    expect(sent.to).toBe("worker-1");
    expect(sent.from).toBe("hermes-bot");
    expect((sent.body as { encrypted?: boolean }).encrypted).toBe(true);
    expect(JSON.stringify(sent.body)).not.toContain("you know the SDK");

    const notice = await room.noticeFor(worker);
    expect(notice?.decrypt_error).toBeUndefined();
    expect(notice?.to).toBe("worker-1");
    expect(notice!.body as object).toMatchObject({
      task: "t1", task_id: "t1", title: "Assign verb in SDK and CLI", assigned: "worker-1", from: "hermes-bot", reason: "you know the SDK",
    });
    expect(String((notice!.body as { text?: string }).text)).toBe("t1 assigned to you: you know the SDK");
    // A direct notice, not a broadcast: nobody else's inbox carries it.
    expect(await room.noticeFor(await room.client("worker-2"))).toBeUndefined();
  });

  it("assigns through runRoomCommand against a local HTTP server", async () => {
    const room = assignRoom();
    let port = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] ?? "" : String(value);
        const result = room.handle(req.method ?? "GET", `http://127.0.0.1:${port}${req.url ?? "/"}`, headers, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.body));
      });
    });
    try {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/r/${ASSIGN.roomId}`;
      const host = await room.client("hermes-bot", { url });
      const worker = await room.client("worker-1", { url });
      await syncKeys(host, worker);

      const result = await runRoomCommand(host, "assign", ["t1", "worker-1", "idle", "and", "knows", "the", "SDK"]) as { task: Record<string, unknown> };
      expect(result.task).toMatchObject({ status: "claimed", owner: "worker-1", assigned: "worker-1", assigned_by: "hermes-bot", assigned_reason: "idle and knows the SDK" });
      expect(room.board["task.t1"].version).toBe(4);
      const notice = await room.noticeFor(worker);
      expect(notice!.body as object).toMatchObject({ task_id: "t1", assigned: "worker-1", from: "hermes-bot", reason: "idle and knows the SDK" });
      await expect(runRoomCommand(host, "assign", ["t1"])).rejects.toThrow("assign needs: <task id> <participant> [reason]");
      expect(room.writes).toHaveLength(1);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("refuses a task that is not open, a worker who is not free or not joined, and a caller who is not the host", async () => {
    const room = assignRoom({
      participants: [
        { id: "hermes-bot", role: "host", state: "free", status: "joined", checkout: ASSIGN.checkout },
        { id: "worker-1", role: "builder", state: "busy", status: "editing room-client.ts", checkout: ASSIGN.checkout },
        { id: "worker-2", role: "builder", state: "free", status: "joined", checkout: ASSIGN.checkout },
        { id: "worker-9", role: "builder", state: "free", status: "joined", checkout: ASSIGN.checkout, left_at: "2026-01-15T12:00:00.000Z" },
      ],
      board: {
        "task.t1": entry(assignTask(), 3),
        "task.t2": entry(assignTask({ status: "claimed", owner: "worker-2" }), 2),
        "task.t3": entry(assignTask({ status: "done", owner: "worker-2", summary: "routing landed" }), 5),
        "task.t4": entry(assignTask({ status: "blocked", blocked_reason: "waiting on review" }), 1),
        "task.t5": entry(assignTask({ depends_on: ["t6"] }), 1),
        "task.t6": entry(assignTask({ title: "Predecessor", files: [] }), 1),
      },
    });
    const host = await room.client("hermes-bot");
    const builder = await room.client("worker-2");

    await expect(host.assign("t2", "worker-2")).rejects.toThrow("task t2 is claimed by worker-2: assign only takes open tasks");
    await expect(host.assign("t3", "worker-2")).rejects.toThrow("task t3 is done by worker-2: assign only takes open tasks");
    await expect(host.assign("t4", "worker-2")).rejects.toThrow("task t4 is blocked: assign only takes open tasks");
    await expect(host.assign("t5", "worker-2")).rejects.toThrow("task t5 waits for t6");
    await expect(host.assign("nope", "worker-2")).rejects.toThrow("task nope does not exist");
    await expect(host.assign("t1", "worker-1")).rejects.toThrow("worker-1 is busy: assign only offers work to a free participant");
    await expect(host.assign("t1", "worker-9")).rejects.toThrow("worker-9 is not joined in this room: invite them first");
    await expect(builder.assign("t1", "worker-2")).rejects.toThrow("assign is host only: ask hermes-bot to assign t1");
    expect(room.writes).toEqual([]);
    expect(room.messages.filter((m) => m.intent === "task.assigned")).toEqual([]);
  });

  it("refuses task files that a live reservation in the same checkout already covers", async () => {
    const room = assignRoom({
      board: {
        "task.t1": entry(assignTask({ files: [TASK_FILE, SHARED_FILE] }), 1),
        "task.t2": entry(assignTask({ files: [TASK_FILE] }), 1),
        "task.t3": entry(assignTask({ files: ["packages/sdk/src/metrics.ts"] }), 1),
        [RESERVATIONS_KEY]: entry({
          "r-held": await sealedReservation("worker-2", [SHARED_FILE], ASSIGN.checkout, "task t7"),
          // Another worktree in the same room cannot collide with these paths.
          "r-other-checkout": await sealedReservation("worker-8", [TASK_FILE], "checkout-2", "task t8"),
          // The target's own reservation for this very task is the offer they are about to accept.
          "r-own": await sealedReservation("worker-1", ["packages/sdk/src/metrics.ts"], ASSIGN.checkout, "task t3"),
        }, 4),
      },
    });
    const host = await room.client("hermes-bot");
    await syncKeys(host, await room.client("worker-1"));

    await expect(host.assign("t1", "worker-1", { reason: "take this too" })).rejects.toThrow("task t1 files overlap a live reservation: worker-2 (task t7)");
    expect(room.writes).toEqual([]);
    // Files nobody holds, even with a reservation in another checkout covering them, assign fine.
    expect(await host.assign("t2", "worker-1")).toMatchObject({ status: "claimed", owner: "worker-1" });
    // And holding the path for this exact task is not a conflict with yourself.
    expect(await host.assign("t3", "worker-1")).toMatchObject({ status: "claimed", owner: "worker-1", files: ["packages/sdk/src/metrics.ts"] });
    expect(room.writes.map((w) => w.key)).toEqual(["task.t2", "task.t3"]);
  });

  it("puts the task back when the notice cannot be delivered", async () => {
    const room = assignRoom();
    const host = await room.client("hermes-bot");
    await syncKeys(host, await room.client("worker-1"));
    room.fail.sends = true;

    await expect(host.assign("t1", "worker-1", { reason: "nobody will hear this" })).rejects.toThrow(/failed: 500/);
    // Two guarded writes: the claim and its undo, so the board never shows a worker who was never told.
    expect(room.writes.map((w) => `${w.key}@${w.ifVersion}`)).toEqual(["task.t1@3", "task.t1@4"]);
    expect(room.board["task.t1"].value).toEqual(assignTask());
  });
});
