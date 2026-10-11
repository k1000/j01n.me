import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomClient } from "@j01n/sdk";
import { applyUsageDelta, estimateCost, ratesForModel } from "@j01n/sdk/metrics";
import type { UsageDelta } from "@j01n/sdk/metrics";
import {
  USAGE_REPORT_INTERVAL_MS,
  USAGE_TIMER_MAX_FAILURES,
  deltaFromUsage,
  loadLastReport,
  readSessionUsage,
  reportSessionUsage,
  sessionSlug,
  startUsageTimer,
  stopUsageTimer,
  usageMarkerPath,
} from "../usage";

const ROOM = "https://j01n.me/r/usage-1";
const SECRET = "room-secret-never-reported";

/** One assistant turn exactly as Pi writes it: cumulative counters plus an ISO record timestamp. */
function turn(timestamp: string, usage: Record<string, unknown>, model = "qwen3-coder-480b", provider = "qwen"): string {
  return JSON.stringify({
    type: "message",
    id: `m-${timestamp}`,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "did a thing" }],
      provider,
      model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
    },
  });
}

/** Four turns: prompt side 6020 (1520 + 2000 + 2000 + 500), completion side 525, 100s of wall clock. */
const FOUR_TURNS = [
  turn("2026-10-11T10:00:00.000Z", { input: 1000, output: 100, cacheRead: 500, cacheWrite: 20, reasoning: 50, totalTokens: 1670 }),
  '{"type":"message","id":"broken" a half-written line, because Pi may still be appending',
  JSON.stringify({ type: "message", timestamp: "2026-10-11T10:00:10.000Z", message: { role: "user", content: "go" } }),
  turn("2026-10-11T10:00:30.000Z", { input: 2000, output: 200, totalTokens: 2200 }),
  turn("2026-10-11T10:01:00.000Z", { input: 1000, output: 100, cacheRead: 1000, reasoning: 25, totalTokens: 2125 }),
  turn("2026-10-11T10:01:40.000Z", { input: 500, output: 50, totalTokens: 550 }),
];

const cost = (usd: number) => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });

/** A client that never claimed anything: its heartbeat slot must stay empty. */
function otherRoomClient(): RoomClient {
  return { participantId: "worker-9", invite: { room_url: "https://j01n.me/r/other-room", room_id: "other-room", join_secret: SECRET } } as unknown as RoomClient;
}

let clientsCreated = 0;

/** A stand-in for RoomClient that accumulates deltas like the real reportUsage does. */
function mockClient(joinSecret = SECRET) {
  const me = `worker-${(clientsCreated += 1)}`;
  const room = `${ROOM}-${clientsCreated}`; // a distinct room+participant per client: the marker cache is per worker
  const reported: UsageDelta[] = [];
  let snapshot: ReturnType<typeof applyUsageDelta> | null = null;
  const client = {
    participantId: me,
    invite: { room_url: room, room_id: `usage-${clientsCreated}`, join_secret: joinSecret },
    board: vi.fn(async () => ({ board: {} })),
    reportUsage: vi.fn(async (delta: UsageDelta) => {
      reported.push(delta);
      snapshot = applyUsageDelta(me, snapshot, delta);
      return { participant: me, key: `usage.${me}`, version: reported.length, snapshot, stale: false };
    }),
  } as unknown as RoomClient & { reportUsage: ReturnType<typeof vi.fn> };
  return { client, reported };
}

describe("pi-extension usage self-reporting", () => {
  const originalCwd = process.cwd();
  let root = "";
  let sessions = "";
  let state = "";
  let worktree = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "j01n-usage-"));
    sessions = join(root, "sessions");
    state = join(root, "state");
    worktree = join(root, "work");
    mkdirSync(join(sessions, sessionSlug(worktree)), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    process.chdir(worktree); // the checkout a stray dotfile must never land in
    vi.stubEnv("J01N_PI_SESSIONS_DIR", sessions);
    vi.stubEnv("J01N_USAGE_DIR", state);
    // A harness that announces its model would make join PATCH a profile; keep this test independent of it.
    for (const name of ["PI_MODEL", "PI_PROVIDER", "J01N_MODEL", "J01N_PROVIDER"]) vi.stubEnv(name, "");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  function writeSession(name: string, lines: string[], mtimeSeconds = 1_800_000_000): string {
    const file = join(sessions, sessionSlug(worktree), name);
    writeFileSync(file, `${lines.join("\n")}\n`);
    utimesSync(file, mtimeSeconds, mtimeSeconds);
    return file;
  }

  const read = () => readSessionUsage({ cwd: worktree });

  it("maps a checkout to the pi session directory name", () => {
    expect(sessionSlug("/mnt/sdb/wt/j01n-tool4")).toBe("--mnt-sdb-wt-j01n-tool4--");
    expect(sessionSlug("/mnt/sdb/wt/j01n-tool4/")).toBe(sessionSlug("/mnt/sdb/wt/j01n-tool4"));
  });

  it("totals input, cache and output+reasoning from the newest log and measures active time", () => {
    writeSession("2026-10-11T09-00-00-000Z_old.jsonl", [turn("2026-10-11T09:00:00.000Z", { input: 999_999, totalTokens: 999_999 })], 1_799_000_000);
    writeSession("2026-10-11T10-01-00-000Z_new.jsonl", FOUR_TURNS);

    const usage = read();
    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(6020); // only the newest log counts; cache reads and writes are prompt side
    expect(usage!.outputTokens).toBe(525);  // output + reasoning
    expect(usage!.cacheReadTokens).toBe(1500);
    expect(usage!.cacheWriteTokens).toBe(20);
    expect(usage!.totalTokens).toBe(6545);
    expect(usage!.turns).toBe(4);            // the broken and the user lines carry no usage
    expect(usage!.activeMs).toBe(100_000);   // first to last assistant timestamp
    expect(usage!.model).toBe("qwen3-coder-480b");
    expect(usage!.provider).toBe("qwen");
    expect(usage!.file).toBe("2026-10-11T10-01-00-000Z_new.jsonl"); // named, never pathed
  });

  it("estimates cost from list rates when the session log costs nothing", () => {
    writeSession("session.jsonl", FOUR_TURNS);
    const usage = read()!;
    const rates = ratesForModel("qwen3-coder-480b");
    expect(rates).toEqual({ input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 });
    expect(usage.loggedCostUsd).toBe(0);
    expect(usage.costEstimated).toBe(true);
    const expected = estimateCost({ input_tokens: 6020, output_tokens: 525 }, rates);
    expect(usage.estimatedCostUsd).toBeCloseTo(expected, 10);
    expect(deltaFromUsage("worker-4", null, usage).cost_usd).toBeCloseTo(expected, 10);
  });

  it("reports the invoice the harness logged instead of the estimate", () => {
    writeSession("paid.jsonl", [
      turn("2026-10-11T10:00:00.000Z", { input: 1000, output: 100, totalTokens: 1100, ...cost(0.01) }),
      turn("2026-10-11T10:00:30.000Z", { input: 1000, output: 100, totalTokens: 1100, ...cost(0.02) }),
    ]);
    const usage = read()!;
    expect(usage.loggedCostUsd).toBeCloseTo(0.03, 10);
    expect(usage.costEstimated).toBe(false);
    expect(deltaFromUsage("worker-4", null, usage).cost_usd).toBeCloseTo(0.03, 10);
  });

  it("reports the whole session first, then only the delta, and remembers it outside the checkout", async () => {
    const file = writeSession("session.jsonl", FOUR_TURNS);
    const { client, reported } = mockClient();

    const first = await reportSessionUsage(client, { cwd: worktree });
    expect(first.reported).toBe(true);
    expect(reported[0]).toMatchObject({ active_ms: 100_000, input_tokens: 6020, output_tokens: 525, model: "qwen3-coder-480b", provider: "qwen" });

    // Nothing happened since: no write, so the board row keeps its version.
    const same = await reportSessionUsage(client, { cwd: worktree });
    expect(same.reported).toBe(false);
    expect(reported).toHaveLength(1);

    writeFileSync(file, `${turn("2026-10-11T10:02:00.000Z", { input: 1000, output: 100, totalTokens: 1100 })}\n`, { flag: "a" });
    const second = await reportSessionUsage(client, { cwd: worktree });
    expect(second.reported).toBe(true);
    expect(reported[1]).toMatchObject({ active_ms: 20_000, input_tokens: 1000, output_tokens: 100 });
    expect(reported[1].cost_usd).toBeCloseTo(estimateCost({ input_tokens: 1000, output_tokens: 100 }, ratesForModel("qwen3-coder-480b")), 10);
    expect(loadLastReport(client)).toMatchObject({ input_tokens: 7020, output_tokens: 625, reports: 2 });

    expect(readdirSync(worktree)).toEqual([]); // the marker is a dotfile outside the repository
    expect(usageMarkerPath(client).startsWith(state)).toBe(true);
    expect(readFileSync(usageMarkerPath(client), "utf8")).toContain("7020");
  });

  it("counts a fresh session log from zero instead of subtracting the rotated one", async () => {
    const { client, reported } = mockClient();
    writeSession("2026-10-11T10-01-00-000Z_a.jsonl", FOUR_TURNS, 1_800_000_000);
    expect((await reportSessionUsage(client, { cwd: worktree })).reported).toBe(true);

    // Pi restarted: the newest log is a different file and its counters start again from zero.
    writeSession("2026-10-11T11-00-00-000Z_b.jsonl", [turn("2026-10-11T11:00:00.000Z", { input: 40, output: 4, totalTokens: 44 })], 1_800_000_600);
    const outcome = await reportSessionUsage(client, { cwd: worktree });
    expect(outcome.reported).toBe(true);
    expect(reported[1]).toMatchObject({ input_tokens: 40, output_tokens: 4, active_ms: 0 });
    expect(loadLastReport(client, "2026-10-11T11-00-00-000Z_b.jsonl")).toMatchObject({ input_tokens: 40 });
    expect(loadLastReport(client, "2026-10-11T10-01-00-000Z_a.jsonl")).toBeNull();
  });

  it("quietly no-ops with no session log and never leaks a path, a file name or the room secret", async () => {
    const { client, reported } = mockClient();
    const missing = await reportSessionUsage(client, { cwd: join(root, "nowhere") });
    expect(missing.reported).toBe(false);
    expect(missing.note).toMatch(/no Pi session log/);
    expect(reported).toHaveLength(0);

    writeSession("session.jsonl", FOUR_TURNS);
    const outcome = await reportSessionUsage(client, { cwd: worktree });
    expect(outcome.reported).toBe(true);
    expect(outcome.note).toMatch(/^usage: .*active · .* in \/ .* out · .*\(rate estimate\)$/);
    for (const leak of [root, worktree, sessions, ".jsonl", SECRET, "home"]) expect(outcome.note).not.toContain(leak);
  });

  it("refuses to seal a report from a resume-only session", async () => {
    writeSession("session.jsonl", FOUR_TURNS);
    const { client, reported } = mockClient("resume-only");
    const outcome = await reportSessionUsage(client, { cwd: worktree });
    expect(outcome.reported).toBe(false);
    expect(outcome.note).toMatch(/room key/);
    expect(reported).toHaveLength(0);
  });

  it("ticks every ~2 minutes while the task is claimed and stops when it is not", async () => {
    vi.useFakeTimers();
    const file = writeSession("session.jsonl", FOUR_TURNS);
    const { client, reported } = mockClient();
    const options = { cwd: worktree, intervalMs: USAGE_REPORT_INTERVAL_MS, stillClaimed: async () => claimed };
    let claimed = true;

    expect(startUsageTimer(client, options)).toBe(true);
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS - 1);
    expect(reported).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reported).toHaveLength(1); // a claim reports what happened so far instead of waiting for done

    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS);
    expect(reported).toHaveLength(1); // idle minutes are not invented

    writeFileSync(file, `${turn("2026-10-11T10:05:00.000Z", { input: 300, output: 30, totalTokens: 330 })}\n`, { flag: "a" });
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS);
    expect(reported).toHaveLength(2);
    expect(reported[1]).toMatchObject({ input_tokens: 300, output_tokens: 30 });

    claimed = false; // blocked, done or handed over: the heartbeat retires itself
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS);
    expect(reported).toHaveLength(2);
    expect(stopUsageTimer(client)).toBe(false);
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS * 2);
    expect(reported).toHaveLength(2);

    claimed = true;
    expect(startUsageTimer(client, options)).toBe(true);
    expect(stopUsageTimer(client)).toBe(true);
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS * 3);
    expect(reported).toHaveLength(2);
  });

  it("gives up the heartbeat after three failed reports instead of retrying forever", async () => {
    vi.useFakeTimers();
    writeSession("session.jsonl", FOUR_TURNS);
    const { client } = mockClient();
    client.reportUsage = vi.fn(async () => { throw new Error("room is closed"); }) as never;

    startUsageTimer(client, { cwd: worktree, intervalMs: USAGE_REPORT_INTERVAL_MS });
    for (let tick = 0; tick < USAGE_TIMER_MAX_FAILURES; tick++) await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS);
    expect(client.reportUsage).toHaveBeenCalledTimes(USAGE_TIMER_MAX_FAILURES);
    await vi.advanceTimersByTimeAsync(USAGE_REPORT_INTERVAL_MS * 3);
    expect(client.reportUsage).toHaveBeenCalledTimes(USAGE_TIMER_MAX_FAILURES);
    expect(stopUsageTimer(client)).toBe(false);
  });

  it("starts the heartbeat on claim and folds the final delta into the done answer", async () => {
    writeSession("session.jsonl", FOUR_TURNS);
    // A fresh module instance for the commands graph: after resetModules it is the one commands.ts uses.
    const usage = await import("../usage");
    const { runj01n } = await import("../commands");

    const board: Record<string, { value: unknown; version: number }> = {
      "task.t9": { value: { title: "wiring", files: [], depends_on: [], status: "open" }, version: 1 },
    };
    const puts: Array<{ key: string; value: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const target = String(url);
      if (method === "PUT" && target.includes("/board/")) {
        const key = decodeURIComponent(target.split("/board/")[1].split("?")[0]);
        const value = JSON.parse(String(init!.body)) as unknown;
        puts.push({ key, value });
        board[key] = { value, version: (board[key]?.version ?? 0) + 1 };
        return Response.json({ ok: true, key, entry: board[key] });
      }
      if (target.endsWith("/board")) return Response.json({ board, board_schema: null });
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-9" });
      return Response.json({ ok: true, seq: 1, cursor: 0, messages: [], participants: [], team: [], participant: {}, room: { host_id: "worker-9" } });
    });

    await runj01n(["join", ROOM, SECRET, "worker-9", "--no-workspace"]);

    const claimed = JSON.parse(await runj01n(["claim", "t9"]));
    expect(claimed.task).toMatchObject({ status: "claimed", owner: "worker-9" });
    expect(usage.usageTimerActive()).toBe(true);
    expect(usage.usageTimerActive(otherRoomClient())).toBe(false); // another room keeps no heartbeat

    const done = JSON.parse(await runj01n(["done", "t9", "--summary", "wired it", "--commit", "abc1234", "--tests", "vitest run: 8 passed"]));
    expect(done.task.status).toBe("done");
    expect(done.usage).toMatch(/^usage: .*active · .* in \/ .* out/);
    expect(done.usage).not.toContain(worktree);
    expect(usage.usageTimerActive()).toBe(false); // done stops the timer

    const row = puts.find((put) => put.key === "usage.worker-9");
    expect(row, "usage lands under the participant's own board key").toBeTruthy();
    expect(String(row!.value)).toMatch(/^jsk1:/); // sealed for the room, never plaintext
    expect(JSON.stringify(puts)).not.toContain(SECRET);
    expect(JSON.stringify(puts)).not.toContain(".jsonl");
    expect(existsSync(join(worktree, "usage"))).toBe(false);
  });
});
