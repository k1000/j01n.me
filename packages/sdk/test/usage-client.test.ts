import { describe, expect, it } from "vitest";
import { RoomApiError } from "../src/errors";
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
