import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_RATES, USAGE_KEY_PREFIX, USAGE_STALE_AFTER_MS, applyUsageDelta, coerceUsageSnapshot, emptyUsage, estimateCost,
  formatActiveTime, formatCost, formatTokens, formatUsage, formatUsageRow, isUsageKey, nextUsage, openUsage, parseUsageDelta,
  parseUsageSnapshot, participantFromUsageKey, ratesForModel, roomUsage, sealUsage, usageCost, usageDeltaBetween, usageKey, usageRows, usageTotals,
  type UsageSnapshot,
} from "../src/metrics";
import { sealForRoom } from "../src/crypto";
import type { BoardEntry } from "../src/types";

const ROOM = { joinSecret: "room-secret-123456", roomId: "room-1" };
const NOW = Date.parse("2026-01-15T12:00:00.000Z");

const snapshot = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  participant: "worker-1", reports: 1, updated_at: "2026-01-15T12:00:00.000Z",
  active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, ...over,
});

const entry = (value: unknown, version = 1): BoardEntry => ({ value, updated_by: "worker-1", updated_at: "2026-01-15T12:00:00.000Z", version });

describe("usage board keys", () => {
  it("builds one key per participant and reads it back", () => {
    expect(usageKey("worker-1")).toBe(`${USAGE_KEY_PREFIX}worker-1`);
    expect(isUsageKey("usage.worker-1")).toBe(true);
    expect(participantFromUsageKey("usage.worker-1")).toBe("worker-1");
  });

  it("rejects ids that are not a single safe path segment", () => {
    for (const bad of ["", "up/../x", "a b", "a/b", "a.b", "worker-1".repeat(20)]) {
      expect(() => usageKey(bad)).toThrow(/invalid participant id/);
    }
    expect(isUsageKey("usage.")).toBe(false);
    expect(isUsageKey("usage.a/b")).toBe(false);
    expect(participantFromUsageKey("task.t1")).toBeUndefined();
  });
});

describe("usage deltas", () => {
  it("accepts a full delta, trims text and normalizes the timestamp", () => {
    expect(parseUsageDelta({ active_ms: 60000, input_tokens: 100, output_tokens: 20, cost_usd: 0.5, model: "  claude-sonnet  ", provider: "anthropic", at: "2026-01-15T12:00:00Z" }))
      .toEqual({ active_ms: 60000, input_tokens: 100, output_tokens: 20, cost_usd: 0.5, model: "claude-sonnet", provider: "anthropic", at: "2026-01-15T12:00:00.000Z" });
    expect(parseUsageDelta({ input_tokens: 7 })).toEqual({ input_tokens: 7 });
    expect(parseUsageDelta({ model: "gpt-5" })).toEqual({ model: "gpt-5" });
  });

  it("rejects anything that could silently report zero or bogus usage", () => {
    expect(() => parseUsageDelta(null)).toThrow(/must be an object/);
    expect(() => parseUsageDelta("7")).toThrow(/must be an object/);
    expect(() => parseUsageDelta({})).toThrow(/at least one of/);
    expect(() => parseUsageDelta({ activeMs: 1000 })).toThrow(/unknown usage delta field/);
    expect(() => parseUsageDelta({ active_ms: -1 })).toThrow(/active_ms must be a whole number/);
    expect(() => parseUsageDelta({ active_ms: 1.5 })).toThrow(/whole number/);
    expect(() => parseUsageDelta({ input_tokens: Number.NaN })).toThrow(/input_tokens/);
    expect(() => parseUsageDelta({ input_tokens: "1000" })).toThrow(/input_tokens/);
    expect(() => parseUsageDelta({ cost_usd: Infinity })).toThrow(/cost_usd/);
    expect(() => parseUsageDelta({ active_ms: 25 * 60 * 60 * 1000 })).toThrow(/active_ms must be <=/);
    expect(() => parseUsageDelta({ input_tokens: 2_000_000_000 })).toThrow(/input_tokens must be <=/);
    expect(() => parseUsageDelta({ model: "   " })).toThrow(/model must be a non-empty string/);
    expect(() => parseUsageDelta({ at: "not a date" })).toThrow(/must be an ISO timestamp/);
  });
});

describe("usage snapshots", () => {
  it("starts empty", () => {
    expect(emptyUsage("worker-1", "2026-01-15T12:00:00Z")).toEqual(snapshot({ reports: 0 }));
  });

  it("adds self-reported deltas to the previous snapshot", () => {
    const first = applyUsageDelta("worker-1", null, { active_ms: 60000, input_tokens: 1000, output_tokens: 200, model: "claude-sonnet", provider: "anthropic", at: "2026-01-15T11:00:00Z" });
    expect(first).toEqual({
      participant: "worker-1", reports: 1, updated_at: "2026-01-15T11:00:00.000Z",
      active_ms: 60000, input_tokens: 1000, output_tokens: 200, cost_usd: 0, model: "claude-sonnet", provider: "anthropic",
    });
    const second = applyUsageDelta("worker-1", first, { active_ms: 30000, input_tokens: 500, cost_usd: 0.25, at: "2026-01-15T11:30:00Z" });
    expect(second).toMatchObject({ reports: 2, updated_at: "2026-01-15T11:30:00.000Z", active_ms: 90000, input_tokens: 1500, output_tokens: 200, cost_usd: 0.25, model: "claude-sonnet" });
    expect(applyUsageDelta("worker-1", second, { model: "gpt-5" })).toMatchObject({ reports: 3, active_ms: 90000, model: "gpt-5", provider: "anthropic" });
    expect(first).toMatchObject({ active_ms: 60000 }); // previous snapshots are never mutated
  });

  it("ignores a previous snapshot that belongs to somebody else", () => {
    const other = snapshot({ participant: "worker-2", active_ms: 999, reports: 4 });
    expect(applyUsageDelta("worker-1", other, { active_ms: 1000 })).toEqual({ participant: "worker-1", reports: 1, updated_at: expect.any(String), active_ms: 1000, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  });

  it("defaults the report time to now", () => {
    const before = Date.now();
    const applied = applyUsageDelta("worker-1", null, { active_ms: 1000 });
    expect(Date.parse(applied.updated_at)).toBeGreaterThanOrEqual(before);
  });

  it("treats a corrupt previous board value as no history", () => {
    expect(nextUsage("worker-1", { participant: "worker-1", active_ms: -5, reports: 1 }, { input_tokens: 10 }).input_tokens).toBe(10);
    expect(nextUsage("worker-1", "not-a-snapshot", { input_tokens: 10 }).reports).toBe(1);
    expect(nextUsage("worker-1", snapshot({ active_ms: 5000, reports: 2 }), { active_ms: 1000 })).toMatchObject({ active_ms: 6000, reports: 3 });
  });

  it("validates stored snapshots and tolerates bad ones when reading", () => {
    expect(parseUsageSnapshot({ participant: "worker-2", reports: 3, updated_at: "2026-01-15T12:00:00Z", active_ms: 60000, input_tokens: 1, output_tokens: 2, cost_usd: 0.1 })).toMatchObject({ participant: "worker-2", reports: 3 });
    expect(parseUsageSnapshot({ reports: 0, active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }, "worker-3")).toMatchObject({ participant: "worker-3" });
    expect(() => parseUsageSnapshot({ participant: "worker-1" })).toThrow(/usage reports must be a whole number/);
    expect(() => parseUsageSnapshot({ reports: 1, total_tokens: 5 })).toThrow(/unknown usage snapshot field/);
    expect(Date.parse(parseUsageSnapshot({ participant: "worker-1", reports: 1 }).updated_at)).not.toBeNaN(); // a stored snapshot without a time still counts
    expect(() => parseUsageSnapshot({ participant: "worker-1", reports: 1, updated_at: "yesterday" })).toThrow(/updated_at must be an ISO timestamp/);
    expect(() => parseUsageSnapshot(null)).toThrow(/must be an object/);
    expect(coerceUsageSnapshot({ participant: "worker-1", reports: -1 })).toBeNull();
    expect(coerceUsageSnapshot(undefined)).toBeNull();
    expect(coerceUsageSnapshot({ reports: 1, active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 })).toBeNull(); // no participant
  });
});

describe("usage deltas between snapshots", () => {
  it("turns absolute counters into a non-negative delta", () => {
    const previous = snapshot({ active_ms: 5000, input_tokens: 100, output_tokens: 50, cost_usd: 0.2, updated_at: "2026-01-15T11:00:00Z" });
    expect(usageDeltaBetween(previous, snapshot({ active_ms: 8000, input_tokens: 130, output_tokens: 40, cost_usd: 0.1, model: "qwen3", updated_at: "2026-01-15T11:05:00Z" })))
      .toEqual({ active_ms: 3000, input_tokens: 30, output_tokens: 0, cost_usd: 0, model: "qwen3", at: "2026-01-15T11:05:00.000Z" });
    expect(usageDeltaBetween(null, snapshot({ active_ms: 1000, input_tokens: 20 }))).toMatchObject({ active_ms: 1000, input_tokens: 20, output_tokens: 0 });
  });

  it("round-trips: a delta applied to the previous snapshot reaches the new totals", () => {
    const previous = snapshot({ active_ms: 5000, input_tokens: 100, output_tokens: 50 });
    const current = snapshot({ active_ms: 8000, input_tokens: 130, output_tokens: 60, reports: 2 });
    expect(applyUsageDelta("worker-1", previous, usageDeltaBetween(previous, current))).toMatchObject({ active_ms: 8000, input_tokens: 130, output_tokens: 60 });
  });
});

describe("room totals", () => {
  it("sums snapshots and counts reporters", () => {
    expect(usageTotals([])).toEqual({ participants: 0, active_ms: 0, input_tokens: 0, output_tokens: 0, tokens: 0, cost_usd: 0 });
    const totals = usageTotals([
      snapshot({ participant: "a", active_ms: 60000, input_tokens: 1000, output_tokens: 500, cost_usd: 0.1 }),
      snapshot({ participant: "b", active_ms: 120000, input_tokens: 2000, output_tokens: 1000, cost_usd: 0.2 }),
    ]);
    expect(totals).toEqual({ participants: 2, active_ms: 180000, input_tokens: 3000, output_tokens: 1500, tokens: 4500, cost_usd: 0.3 });
  });

  it("keeps tiny costs usable by rounding the sum", () => {
    expect(usageTotals([snapshot({ cost_usd: 0.0000004 }), snapshot({ cost_usd: 0.0000004 })]).cost_usd).toBe(0.000001);
  });
});

describe("cost estimation", () => {
  it("matches the longest rate-table key inside a model name", () => {
    expect(ratesForModel("claude-sonnet-4-20250514")).toEqual({ input_usd_per_mtok: 3, output_usd_per_mtok: 15 });
    expect(ratesForModel("Claude-Haiku")).toEqual({ input_usd_per_mtok: 0.8, output_usd_per_mtok: 4 });
    expect(ratesForModel("gpt-5-mini")).toEqual({ input_usd_per_mtok: 1.25, output_usd_per_mtok: 10 });
    expect(ratesForModel(undefined)).toEqual(DEFAULT_TOKEN_RATES);
    expect(ratesForModel("unknown-model")).toEqual(DEFAULT_TOKEN_RATES);
    expect(ratesForModel("qwen3", { qwen3: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 } })).toEqual({ input_usd_per_mtok: 1, output_usd_per_mtok: 2 });
  });

  it("prices tokens per million", () => {
    expect(estimateCost({ input_tokens: 1_000_000, output_tokens: 500_000 }, { input_usd_per_mtok: 3, output_usd_per_mtok: 15 })).toBe(10.5);
    expect(estimateCost({ input_tokens: 0, output_tokens: 0 }, DEFAULT_TOKEN_RATES)).toBe(0);
    expect(estimateCost({ input_tokens: 1234, output_tokens: 567 }, DEFAULT_TOKEN_RATES)).toBe(0.003502);
  });

  it("prefers a reported cost over an estimate", () => {
    expect(usageCost(snapshot({ input_tokens: 1_000_000, output_tokens: 0, model: "claude-sonnet", cost_usd: 99 }))).toBe(99);
    expect(usageCost(snapshot({ input_tokens: 1_000_000, output_tokens: 0, model: "claude-sonnet" }))).toBe(3);
    expect(usageCost(snapshot({ input_tokens: 1_000_000, model: "mystery" }))).toBe(DEFAULT_TOKEN_RATES.input_usd_per_mtok);
  });
});

describe("room seals", () => {
  it("seals a snapshot so the server never sees numbers", async () => {
    const sealed = await sealUsage(snapshot({ active_ms: 3_600_000, input_tokens: 123456, output_tokens: 654321, cost_usd: 1.23, model: "claude-sonnet" }), ROOM.joinSecret, ROOM.roomId);
    expect(sealed.startsWith("jsk1:")).toBe(true);
    expect(sealed).not.toMatch(/active_ms|input_tokens|output_tokens|cost_usd|claude|123456|654321/);
    expect(await openUsage(sealed, "worker-1", ROOM.joinSecret, ROOM.roomId)).toMatchObject({ participant: "worker-1", active_ms: 3_600_000, input_tokens: 123456, model: "claude-sonnet" });
  });

  it("opens only with this room's secret and only valid snapshots", async () => {
    const sealed = await sealUsage(snapshot(), ROOM.joinSecret, ROOM.roomId);
    expect(await openUsage(sealed, "worker-1", "other-secret-000000", ROOM.roomId)).toBeNull();
    expect(await openUsage(sealed, "worker-1", ROOM.joinSecret, "other-room")).toBeNull();
    expect(await openUsage("jsk1:not.base64", "worker-1", ROOM.joinSecret, ROOM.roomId)).toBeNull();
    expect(await openUsage(await sealForRoom({ total_tokens: 5 }, ROOM.joinSecret, ROOM.roomId), "worker-1", ROOM.joinSecret, ROOM.roomId)).toBeNull();
    expect(await openUsage(undefined, "worker-1", ROOM.joinSecret, ROOM.roomId)).toBeNull();
    expect(await openUsage("plain text", "worker-1", ROOM.joinSecret, ROOM.roomId)).toBeNull();
  });

  it("fills the participant from the key when the snapshot omits it", async () => {
    const sealed = await sealForRoom({ reports: 2, updated_at: "2026-01-15T12:00:00Z", active_ms: 1000, input_tokens: 10, output_tokens: 5, cost_usd: 0 }, ROOM.joinSecret, ROOM.roomId);
    expect(await openUsage(sealed, "worker-9", ROOM.joinSecret, ROOM.roomId)).toMatchObject({ participant: "worker-9", reports: 2, active_ms: 1000 });
  });
});

describe("reading usage off the board", () => {
  async function board() {
    const a = await sealUsage(snapshot({ participant: "a", reports: 2, active_ms: 60000, input_tokens: 1000, output_tokens: 500, cost_usd: 0.2, model: "claude-sonnet" }), ROOM.joinSecret, ROOM.roomId);
    const fresh = await sealUsage(snapshot({ participant: "b", reports: 1, active_ms: 30000, input_tokens: 200, output_tokens: 100, updated_at: "2026-01-15T11:59:00.000Z" }), ROOM.joinSecret, ROOM.roomId);
    const stale = await sealUsage(snapshot({ participant: "c", reports: 5, active_ms: 10000, updated_at: "2026-01-15T10:00:00.000Z" }), ROOM.joinSecret, ROOM.roomId);
    return {
      board: {
        "usage.a": entry(a, 7),
        "usage.b": entry(fresh),
        "usage.c": entry(stale),
        "usage.d": entry("jsk1:garbage", 2),
        "usage.e": entry(42),
        "kickoff": entry("not usage"),
        "task.t1": entry({ title: "Metrics core in SDK" }),
      } as Record<string, BoardEntry>,
    };
  }

  it("lists one row per usage key and skips keys that are not usage", async () => {
    const { board: b } = await board();
    const rows = await usageRows(b, { ...ROOM, nowMs: NOW });
    expect(rows.map((row) => row.participant)).toEqual(["a", "b", "c", "d", "e"]);
    expect(rows.find((row) => row.participant === "a")).toMatchObject({ key: "usage.a", version: 7, stale: false });
    expect(rows.find((row) => row.participant === "a")?.snapshot).toMatchObject({ active_ms: 60000, model: "claude-sonnet" });
    expect(rows.find((row) => row.participant === "d")).toMatchObject({ snapshot: null, stale: true, version: 2 });
    expect(rows.find((row) => row.participant === "e")).toMatchObject({ snapshot: null });
  });

  it("adds rows for participants who never reported and marks them stale", async () => {
    const rows = await usageRows(await board().then((x) => x.board), { ...ROOM, participants: ["a", "host", "usage.hack"], nowMs: NOW });
    const host = rows.find((row) => row.participant === "host");
    expect(host).toMatchObject({ key: "usage.host", version: 0, snapshot: null, stale: true });
    expect(rows.some((row) => row.participant === "usage.hack" || row.participant.includes("."))).toBe(false);
  });

  it("trusts the board key over a snapshot that claims another participant", async () => {
    const mislabeled = await sealUsage(snapshot({ participant: "b", active_ms: 1000 }), ROOM.joinSecret, ROOM.roomId);
    const rows = await usageRows({ "usage.a": entry(mislabeled) }, { ...ROOM, nowMs: NOW });
    expect(rows[0]).toMatchObject({ participant: "a", snapshot: { participant: "a", active_ms: 1000 } });
    expect((await roomUsage({ "usage.a": entry(mislabeled) }, { ...ROOM, nowMs: NOW })).totals.participants).toBe(1);
  });

  it("uses the staleness window and default", async () => {
    const { board: b } = await board();
    const rows = await usageRows(b, { ...ROOM, nowMs: NOW });
    expect(rows.find((row) => row.participant === "c")?.stale).toBe(true); // 2h old > 15m default
    const generous = await usageRows(b, { ...ROOM, nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 });
    expect(generous.find((row) => row.participant === "c")?.stale).toBe(false);
    expect(USAGE_STALE_AFTER_MS).toBe(15 * 60 * 1000);
    expect((await usageRows(b, { ...ROOM, nowMs: Date.parse("2026-01-15T12:20:00Z") }))).toEqual(expect.arrayContaining([expect.objectContaining({ participant: "b", stale: true })]));
  });

  it("totals the room and counts what is missing", async () => {
    const { board: b } = await board();
    const summary = await roomUsage(b, { ...ROOM, participants: ["a", "b", "c", "d", "e", "host"], nowMs: NOW });
    expect(summary.reported).toBe(3);
    expect(summary.stale).toBe(4); // c is old, and d/e/host never reported
    expect(summary.totals).toEqual({ participants: 3, active_ms: 100000, input_tokens: 1200, output_tokens: 600, tokens: 1800, cost_usd: 0.2 });
  });
});

describe("formatting", () => {
  it("keeps active time compact", () => {
    expect(formatActiveTime(0)).toBe("0s");
    expect(formatActiveTime(-5)).toBe("0s");
    expect(formatActiveTime(45_000)).toBe("45s");
    expect(formatActiveTime(90_000)).toBe("1m 30s");
    expect(formatActiveTime(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m");
    expect(formatActiveTime(3 * 24 * 3_600_000 + 4 * 3_600_000)).toBe("3d 04h");
    expect(formatActiveTime(Number.NaN)).toBe("0s");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(873)).toBe("873");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
    expect(formatTokens(2_500_000_000)).toBe("2.5B");
  });

  it("prints costs without false precision", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(-1)).toBe("$0");
    expect(formatCost(0.42)).toBe("$0.42");
    expect(formatCost(0.0005)).toBe("$0.0005");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(1234.6)).toBe("$1235");
  });

  it("formats one line per participant and for totals", () => {
    expect(formatUsage(snapshot({ active_ms: 7_500_000, input_tokens: 12_300, output_tokens: 4_500, cost_usd: 0.42 })))
      .toBe("2h 05m active · 12.3k in / 4.5k out · $0.42");
    expect(formatUsage({ active_ms: 60_000, input_tokens: 10, output_tokens: 5, cost_usd: 0 }, "worker-1"))
      .toBe("worker-1: 1m 00s active · 10 in / 5 out · $0");
  });

  it("formats a board row, estimating a missing cost and flagging stale reporters", async () => {
    const sealed = await sealUsage(snapshot({ participant: "a", active_ms: 60_000, input_tokens: 1_000_000, output_tokens: 10, model: "claude-sonnet" }), ROOM.joinSecret, ROOM.roomId);
    const rows = await usageRows({ "usage.a": entry(sealed), "usage.b": entry("jsk1:nope") }, { ...ROOM, nowMs: NOW });
    expect(formatUsageRow(rows[0], { table: { "claude-sonnet": { input_usd_per_mtok: 3, output_usd_per_mtok: 15 } } }))
      .toBe("a: 1m 00s active · 1M in / 10 out · $3.00 · claude-sonnet");
    expect(formatUsageRow(rows[1])).toBe("b: no usage reported");
    const stale = await usageRows({ "usage.a": entry(await sealUsage(snapshot({ participant: "a", updated_at: "2026-01-15T09:00:00Z" }), ROOM.joinSecret, ROOM.roomId)) }, { ...ROOM, nowMs: NOW });
    expect(formatUsageRow(stale[0])).toContain("· stale");
  });
});
