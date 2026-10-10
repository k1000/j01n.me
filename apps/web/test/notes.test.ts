import { describe, expect, it, vi } from "vitest";
import { RoomApiError } from "@j01n/sdk/errors";
import { addDecision, addNote } from "@j01n/sdk/notes";
import { roomSummary, runRoomCommand } from "@j01n/sdk/room-commands";
import type { RoomClient } from "@j01n/sdk";

function fixture() {
  const board: Record<string, { value: unknown; version: number }> = {};
  const read = vi.fn();
  const client = (participantId: string) => ({
    participantId,
    invite: { join_secret: "test-secret", room_id: "test-room" },
    cursor: 7,
    read,
    async board() { return { board: structuredClone(board), board_schema: null }; },
    async setBoardKey(key: string, value: unknown, options: { ifVersion?: number } = {}) {
      if ((board[key]?.version ?? 0) !== options.ifVersion) throw new RoomApiError(409, "version conflict", "/board");
      board[key] = { value, version: (board[key]?.version ?? 0) + 1 };
      return { ok: true };
    },
    async team() { return [{ id: participantId, checkout_status: "own checkout", last_seen_at: "2026-01-01" }]; },
  }) as unknown as RoomClient;
  return { board, read, client };
}

describe("durable room notes and summary", () => {
  it("retries conflicting appends rather than overwriting another author", async () => {
    const { board, client } = fixture();
    const [first, second] = await Promise.all([
      addNote(client("maya"), "Use pnpm", ["howto"], ["package.json"]),
      addNote(client("ravi"), "Watch the lockfile", ["gotcha"]),
    ]);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect((board.notes.value as Array<{ by: string }>).map((note) => note.by).sort()).toEqual(["maya", "ravi"]);
    expect(board.notes.version).toBe(2);
    await addDecision(client("maya"), "Keep peer mode", "Generated files belong to the integrator");
    expect(board.decisions.value).toMatchObject([{ by: "maya", decision: "Keep peer mode", why: "Generated files belong to the integrator" }]);
  });

  it("summary shows tasks, report, notes, decisions and team without reading messages", async () => {
    const { board, read, client } = fixture();
    board["task.T1"] = { version: 1, value: { title: "Review", files: [], status: "open", depends_on: ["T0"] } };
    board["task.T0"] = { version: 1, value: { title: "Build", files: [], status: "done", depends_on: [] } };
    board.report = { version: 1, value: { T0: { ready: true, reason: "Tests pass" } } };
    board.notes = { version: 1, value: [{ text: "Use pnpm" }] };
    board.decisions = { version: 1, value: [{ decision: "Ship" }] };
    const me = client("maya");
    const result = await roomSummary(me);
    expect(result).toMatchObject({ tasks: [{ id: "T1" }, { id: "T0" }], report: { T0: { ready: true } }, notes: [{ text: "Use pnpm" }], decisions: [{ decision: "Ship" }], participants: [{ id: "maya" }] });
    expect(read).not.toHaveBeenCalled();
    expect(me.cursor).toBe(7);
  });

  it("forwards message kind and filters wait results without dropping unrelated kinds silently", async () => {
    const { client } = fixture();
    const send = vi.fn().mockResolvedValue({ ok: true });
    const wait = vi.fn().mockResolvedValue({ event: "message" });
    const read = vi.fn().mockResolvedValue([
      { id: "a", from: "ravi", kind: "finding" }, { id: "b", from: "ravi", kind: "blocker" },
    ]);
    const me = { ...client("maya"), send, wait, read } as RoomClient;
    await runRoomCommand(me, "send", ["ravi", "Need help", "--kind", "blocker"]);
    expect(send).toHaveBeenCalledWith("ravi", { text: "Need help" }, expect.objectContaining({ kind: "blocker", expectsReply: true }));
    expect(await runRoomCommand(me, "wait", ["--kind", "blocker"]))
      .toMatchObject({ messages: [{ id: "b" }] });
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ kind: ["blocker"] }));
    // A filtered wait consumes every unread message through read(); callers should not expect "finding" on a later read.
    expect(read).toHaveBeenCalledTimes(1);
    await expect(runRoomCommand(me, "send", ["ravi", "Oops", "--kind", "invalid"])).rejects.toThrow("--kind");
  });

  it("validates note and decision flags through shared CLI/Pi command dispatch", async () => {
    const { client } = fixture();
    const me = client("maya");
    expect(await runRoomCommand(me, "note", ["Avoid generated edits", "--tag", "gotcha", "--files", "a.ts,b.ts"]))
      .toMatchObject({ notes: [{ by: "maya", tags: ["gotcha"], files: ["a.ts", "b.ts"] }] });
    expect(await runRoomCommand(me, "decide", ["Use CAS", "--why", "Concurrent writers matter"]))
      .toMatchObject({ decisions: [{ decision: "Use CAS", why: "Concurrent writers matter" }] });
    await expect(runRoomCommand(me, "note", ["oops", "--tag", "invalid"])).rejects.toThrow("--tag");
    await expect(runRoomCommand(me, "decide", ["No rationale"])).rejects.toThrow("--why");
  });
});
