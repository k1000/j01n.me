import { describe, expect, it, vi } from "vitest";
import { blockTask, claimTask, completeTask, listTasks, unblockTask } from "@j01n/sdk/tasks";
import { listReservations, reservePaths } from "@j01n/sdk/reservations";
import { RoomApiError } from "@j01n/sdk/errors";
import { runRoomCommand } from "@j01n/sdk/room-commands";
import { createRoom, type RoomClient } from "@j01n/sdk";

function room() {
  const board: Record<string, { value: unknown; version: number }> = {};
  const client = (participantId: string) => ({
    participantId, invite: { join_secret: "room-secret-123456", room_id: "room-1" },
    async board() { return { board: structuredClone(board), board_schema: null }; },
    async setBoardKey(key: string, value: unknown, options: { ifVersion?: number } = {}) {
      if ((board[key]?.version ?? 0) !== options.ifVersion) throw new RoomApiError(409, "version conflict", "/board");
      board[key] = { value, version: (board[key]?.version ?? 0) + 1 };
      return { ok: true };
    },
  }) as unknown as RoomClient;
  const add = (id: string, value: object) => { board[`task.${id}`] = { value, version: 1 }; };
  return { board, client, add };
}

const task = (files: string[] = []) => ({ title: "Build", files, depends_on: [], status: "open" });

describe("task primitives", () => {
  it("routes shared CLI/Pi task commands through the same SDK operations", async () => {
    const { client, add } = room();
    add("T1", task());
    const a = client("a");
    expect(await runRoomCommand(a, "tasks", [])).toMatchObject({ tasks: [{ id: "T1", unblocked: true }] });
    expect(await runRoomCommand(a, "claim", ["T1"], { repo: "repo" })).toMatchObject({ task: { owner: "a" } });
    await runRoomCommand(a, "block", ["T1", "--reason", "waiting"]);
    expect(await runRoomCommand(a, "unblock", ["T1"])).toMatchObject({ task: { status: "claimed" } });
    expect(await runRoomCommand(a, "done", ["T1", "--summary", "shipped", "--commit", "abc", "--tests", "vitest", "--contract", "pass"], { repo: "repo" }))
      .toMatchObject({ task: { status: "done", evidence: { commits: ["abc"], tests: "vitest", contract: "pass" } } });
  });

  it("forwards sprint task seeds through the SDK create request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access: "https://j01n.me/r/room-1", join_secret: "secret" }), { status: 200 }));
    try {
      const tasks = [{ id: "T1", title: "Build", files: ["src/a.ts"], depends_on: [] }];
      await createRoom("https://j01n.me", { template: "sprint", tasks });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ template: "sprint", tasks });
    } finally { fetchMock.mockRestore(); }
  });

  it("uses the task key version so only one peer can claim an unreserved task", async () => {
    const { client, add, board } = room();
    add("T1", task());
    const results = await Promise.allSettled([claimTask(client("a"), "T1", "repo"), claimTask(client("b"), "T1", "repo")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["a", "b"]).toContain((board["task.T1"].value as { owner: string }).owner);
    expect(board["task.T1"].version).toBe(2);
  });

  it("claims only once, names the owner, and reserves files", async () => {
    const { client, add } = room();
    add("T1", task(["src/a.ts"]));
    const a = client("a"), b = client("b");
    const results = await Promise.allSettled([claimTask(a, "T1", "repo"), claimTask(b, "T1", "repo")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<unknown>).value as { owner: string };
    await expect(claimTask(client(winner.owner === "a" ? "b" : "a"), "T1", "repo")).rejects.toThrow(`claimed by ${winner.owner}`);
    expect((await listReservations(a))[0].by).toBe(winner.owner);
    expect((await listTasks(a))[0].owner).toBe(winner.owner);
  });

  it("records blocked claimants with CAS without claiming or reserving, then clears waiters on claim", async () => {
    const { client, add, board } = room();
    add("T1", task());
    add("T2", { ...task(["src/b.ts"]), depends_on: ["T1"] });
    const a = client("a"), b = client("b"), c = client("c");
    const waiting = await Promise.allSettled([claimTask(b, "T2", "repo"), claimTask(c, "T2", "repo")]);
    expect(waiting.every((result) => result.status === "rejected" && String(result.reason).includes("waits for T1"))).toBe(true);
    await expect(claimTask(b, "T2", "repo")).rejects.toThrow("waits for T1");
    expect(board["task.T2"].value).toMatchObject({ status: "open" });
    expect((board["task.T2"].value as { waiting_for: string[] }).waiting_for.sort()).toEqual(["b", "c"]);
    expect((board["task.T2"].value as { owner?: string }).owner).toBeUndefined();
    expect(board["task.T2"].version).toBe(3);
    expect(await listReservations(b)).toEqual([]);
    await claimTask(a, "T1", "repo");
    await completeTask(a, "T1", "repo", "done", { commits: ["abc"], tests: "vitest" });
    expect(await claimTask(b, "T2", "repo")).toMatchObject({ status: "claimed", owner: "b" });
    expect((board["task.T2"].value as { waiting_for?: string[] }).waiting_for).toBeUndefined();
    expect((await listReservations(b)).map((reservation) => reservation.by)).toEqual(["b"]);
  });

  it("rejects unfinished dependencies, then completes with evidence and releases reservations", async () => {
    const { client, add } = room();
    add("T1", task(["src/a.ts"]));
    add("T2", { ...task(), depends_on: ["T1"] });
    const a = client("a");
    expect((await listTasks(a)).find((t) => t.id === "T2")?.blocked_by).toEqual(["T1"]);
    await expect(claimTask(a, "T2", "repo")).rejects.toThrow("waits for T1");
    await reservePaths(a, "repo", ["src/manual.ts", "src/a.ts"], "manual work");
    await claimTask(a, "T1", "repo");
    await blockTask(a, "T1", "waiting for review");
    expect((await unblockTask(a, "T1")).status).toBe("claimed");
    const done = await completeTask(a, "T1", "repo", "shipped", { commits: ["abc"], tests: "vitest", contract: "pass" });
    expect(done.evidence?.contract).toBe("pass");
    expect((await listReservations(a)).map((r) => r.reason)).toEqual(["manual work"]);
    expect((await listTasks(a)).find((t) => t.id === "T2")?.unblocked).toBe(true);
    expect((await claimTask(a, "T2", "repo")).status).toBe("claimed");
  });
});
