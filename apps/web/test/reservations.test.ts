import { describe, expect, it } from "vitest";
import { listReservations, pathsOverlap, releasePaths, reservationFor, reservePaths } from "@j01n/sdk/reservations";
import { RoomApiError } from "@j01n/sdk/errors";
import type { RoomClient } from "@j01n/sdk";

/** Two clients sharing one versioned board, like a room: setBoardKey honours ifVersion (409 when stale). */
function room() {
  const board: Record<string, { value: unknown; version: number }> = {};
  let raceOnce: (() => void) | undefined;
  const client = (participantId: string) => ({
    participantId,
    invite: { join_secret: "room-secret-123456", room_id: "room-1" },
    async board() { return { board: structuredClone(board), board_schema: null }; },
    async team() { return ["agent-a", "agent-b", "agent-c"].map((id) => ({ id, checkout: "shared" })); },
    async setBoardKey(key: string, value: unknown, options: { ifVersion?: number } = {}) {
      raceOnce?.(); raceOnce = undefined;
      if ((board[key]?.version ?? 0) !== options.ifVersion) throw new RoomApiError(409, "version conflict", "/board");
      board[key] = { value, version: (board[key]?.version ?? 0) + 1 };
      return { ok: true };
    },
  }) as unknown as RoomClient;
  return { board, client, race: (fn: () => void) => { raceOnce = fn; } };
}

describe("file reservations", () => {
  it("overlap means the same path or a directory containing it", () => {
    expect(pathsOverlap("src/api", "src/api/auth.ts")).toBe(true);
    expect(pathsOverlap("./src/api/", "src/api")).toBe(true);
    expect(pathsOverlap("src/api", "src/apis/x.ts")).toBe(false);
  });

  it("reserves sealed paths, refuses overlapping ones from others, and releases", async () => {
    const { board, client } = room();
    const a = client("agent-a");
    const b = client("agent-b");
    await reservePaths(a, "gitlab.com/acme/api", ["src/auth/"], "refactoring auth");
    expect(JSON.stringify(board)).not.toContain("src/auth");

    await expect(reservePaths(b, "gitlab.com/acme/api", ["src/auth/login.ts"])).rejects.toThrow("already reserved by agent-a (refactoring auth)");
    await reservePaths(b, "gitlab.com/acme/web", ["src/auth/login.ts"]); // another repo: no conflict
    expect(reservationFor(await listReservations(b), "agent-b", "gitlab.com/acme/api", "src/auth/x.ts", "shared")?.by).toBe("agent-a");

    await releasePaths(a);
    expect((await listReservations(b)).map((r) => r.by)).toEqual(["agent-b"]);
  });

  it("does not reserve or block across different checkouts", async () => {
    const { board, client } = room();
    const a = client("agent-a");
    const b = { ...client("agent-b"), async team() { return [
      { id: "agent-a", checkout: "worktree-a" }, { id: "agent-b", checkout: "worktree-b" },
    ]; } } as RoomClient;
    expect(await reservePaths(b, "repo", ["src/x.ts"])).toEqual([]);
    expect(board.reservations).toBeUndefined();
    await reservePaths(a, "repo", ["src/x.ts"]);
    expect(reservationFor(await listReservations(b), "agent-b", "repo", "src/x.ts", "worktree-b")).toBeUndefined();
  });

  it("retries when someone else wrote the board in between (no lost reservation)", async () => {
    const { board, client, race } = room();
    const a = client("agent-a");
    race(() => { board.reservations = { value: { other: { by: "agent-c", since: "now", sealed: "jsk1:x.y" } }, version: 1 }; });
    await reservePaths(a, "repo", ["docs/"]);
    expect((await listReservations(a)).map((r) => r.by).sort()).toEqual(["agent-a", "agent-c"]);
  });
});
