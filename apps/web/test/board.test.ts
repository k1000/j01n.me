import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BOARD_VALUE_BYTES } from "../src/constants";
import { createRoomDirect } from "../src/invite";
import { RendezvousSession } from "../src/rendezvous";
import { applyTemplate } from "../src/room/templates";
import { parseSprintSpec } from "@j01n/sdk/spec";
import {
  bootstrapRoom,
  createMockState,
  encryptedPayload,
  getRoomJson,
  joinParticipant,
  participantAuthHeaders,
  roomRequest,
  type RoomFixture,
} from "./room/helpers";

type ParsedTask = ReturnType<typeof parseSprintSpec>[number];

/** Create a sprint room through the real create path, like a host would from a parsed spec. */
async function sprintRoom(tasks: ParsedTask[]): Promise<RoomFixture> {
  const session = new RendezvousSession(createMockState(), {} as never);
  const env = { RENDEZVOUS: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (url: string, init: RequestInit) => session.fetch(new Request(url, init)) }),
  } as unknown as DurableObjectNamespace };
  const { roomId, joinSecret } = await createRoomDirect(env, { template: "sprint", host_id: "host", tasks }, "https://j01n.me");
  return { session, roomId, joinSecret, roomPath: `/r/${roomId}`, participantTokens: {} };
}

const taskValues = async (fix: RoomFixture, as: string) =>
  (await getRoomJson<{ board: Record<string, { value: unknown }> }>(fix, "/board", as)).board;

/** Readable board notices the server posted, oldest first. */
const notices = async (fix: RoomFixture, as: string) =>
  (await getRoomJson<{ messages: Array<{ intent: string; body: { text?: string } }> }>(fix, "/?view=all", as))
    .messages.filter((message) => message.intent === "board.changed").map((message) => message.body.text ?? "");

describe("board", () => {
  let fix: RoomFixture;

  beforeEach(async () => {
    fix = await bootstrapRoom();
    await joinParticipant(fix, "agent-a");
  });

  it("starts with an empty board", async () => {
    const body = await getRoomJson<{ board: Record<string, unknown> }>(fix, "/board");
    expect(body.board).toEqual({});
  });

  it("sets and reads an encrypted board key", async () => {
    const encrypted = encryptedPayload({ "task-1": { title: "test", state: "todo" } });
    const setRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encrypted),
    }));
    const setBody = await setRes.json() as { key: string };
    expect(setBody.key).toBe("tasks");
    const body = await getRoomJson<{ key: string; entry: { value: Record<string, unknown>; updated_by: string } }>(fix, "/board/tasks");
    expect(body.entry.value).toEqual(encrypted);
    expect(body.entry.updated_by).toBe("agent-a");
  });

  it("keeps the legacy /boar board-key alias", async () => {
    const encrypted = encryptedPayload({ "task-1": { title: "legacy", state: "todo" } });
    const setRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/boar/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encrypted),
    }));
    expect(setRes.status).toBe(200);
    const body = await getRoomJson<{ key: string; entry: { value: Record<string, unknown> } }>(fix, "/boar/tasks");
    expect(body.entry.value).toEqual(encrypted);
  });

  it("accepts plain JSON board values", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ "task-1": { title: "test" } }),
    }));
    expect(res.status).toBe(200);
    const body = await getRoomJson<{ entry: { value: unknown } }>(fix, "/board/tasks");
    expect(body.entry.value).toEqual({ "task-1": { title: "test" } });
  });

  it("patches multiple encrypted board keys", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      method: "PATCH",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify({ kanban: encryptedPayload({ todo: [], done: [] }), decisions: encryptedPayload({ api: "REST" }) }),
    }));
    expect(res.status).toBe(200);
    const boardRes = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: participantAuthHeaders(fix, "agent-a"),
    }));
    const boardBody = (await boardRes.json()) as { board: Record<string, unknown> };
    expect(Object.keys(boardBody.board).sort()).toEqual(["decisions", "kanban"]);
  });

  it("deletes a board key", async () => {
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encryptedPayload({ "task-1": { title: "test" } })),
    }));
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "DELETE",
      headers: { ...participantAuthHeaders(fix, "agent-a") },
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`, {
      headers: participantAuthHeaders(fix, "agent-a"),
    }));
    const body = (await res.json()) as { board: Record<string, unknown> };
    expect(body.board.tasks).toBeUndefined();
  });

  it("validates encrypted board envelopes against a schema", async () => {
    const schemaFix = await bootstrapRoom({
      boardSchema: {
        type: "object",
        properties: { tasks: { type: "object" } },
        additionalProperties: false,
      },
    });
    await joinParticipant(schemaFix, "agent-a");

    // Valid write
    const ok = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(schemaFix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encryptedPayload({ "task-1": {} })),
    }));
    expect(ok.status).toBe(200);

    // Invalid key (not allowed by schema)
    const bad = await schemaFix.session.fetch(new Request(`https://room${schemaFix.roomPath}/board/unknown_key`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(schemaFix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encryptedPayload({ x: 1 })),
    }));
    expect(bad.status).toBe(422);
  });

  it("rejects encrypted board value over size limit", async () => {
    const bigValue = encryptedPayload({ text: "x".repeat(MAX_BOARD_VALUE_BYTES + 1) });
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/big`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(bigValue),
    }));
    expect(res.status).toBe(413);
  });

  it("requires auth for board access", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board`));
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown board key", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/missing`, {
      headers: participantAuthHeaders(fix, "agent-a"),
    }));
    expect(res.status).toBe(404);
  });

  it("rejects board writes from non-joined participants before encryption validation", async () => {
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { authorization: `Bearer ${fix.joinSecret}`, "x-participant-id": "ghost", "content-type": "application/json" },
      body: JSON.stringify({ "task-1": {} }),
    }));
    expect(res.status).toBe(403);
  });

  it("wraps an encrypted initial board provided at room creation", async () => {
    const encrypted = encryptedPayload({ api: "REST" });
    const seeded = await bootstrapRoom({
      hostId: "host",
      initialBoard: { decisions: encrypted },
    });
    await joinParticipant(seeded, "host");
    const body = await getRoomJson<{ board: Record<string, { value: unknown; updated_by: string }> }>(seeded, "/board", "host");
    expect(body.board.decisions.value).toEqual(encrypted);
    expect(body.board.decisions.updated_by).toBe("host");
  });

  it("accepts plain JSON initial board values", async () => {
    const room = await bootstrapRoom({ hostId: "host", initialBoard: { decisions: { api: "REST" } } });
    await joinParticipant(room, "host");
    const body = await getRoomJson<{ board: Record<string, { value: unknown }> }>(room, "/board", "host");
    expect(body.board.decisions.value).toEqual({ api: "REST" });
  });

  it("includes encrypted board state in host export", async () => {
    await joinParticipant(fix, "host");
    const encrypted = encryptedPayload({ "task-1": { title: "exported" } });
    await fix.session.fetch(new Request(`https://room${fix.roomPath}/board/tasks`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
      body: JSON.stringify(encrypted),
    }));
    const res = await fix.session.fetch(new Request(`https://room${fix.roomPath}/export`, {
      headers: { ...participantAuthHeaders(fix, "host") },
    }));
    const body = (await res.json()) as { board: Record<string, { value: unknown }> };
    expect(body.board.tasks.value).toEqual(encrypted);
  });

  describe("versioned writes", () => {
    const put = (key: string, value: unknown, ifVersion?: number) =>
      roomRequest(fix, `/board/${key}${ifVersion === undefined ? "" : `?if_version=${ifVersion}`}`, {
        method: "PUT",
        headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
        body: JSON.stringify(value),
      });

    it("counts versions up from 1", async () => {
      const first = await (await put("tasks", { a: 1 })).json() as { entry: { version: number } };
      const second = await (await put("tasks", { a: 2 })).json() as { entry: { version: number } };
      expect([first.entry.version, second.entry.version]).toEqual([1, 2]);
    });

    it("rejects a write based on a stale version and returns the current value", async () => {
      await put("tasks", { a: 1 });
      await put("tasks", { a: 2 }, 1);
      const stale = await put("tasks", { a: "lost update" }, 1);

      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ key: "tasks", expected_version: 1, current_version: 2, current: { value: { a: 2 } } });
      const board = await getRoomJson<{ board: Record<string, { value: unknown }> }>(fix, "/board", "agent-a");
      expect(board.board.tasks.value).toEqual({ a: 2 });
    });

    it("PATCH with if_versions writes nothing when any listed key changed, and lists every conflict", async () => {
      await put("tasks", { a: 1 });
      await put("tasks", { a: 2 });
      await put("notes", "n1");
      const patch = (ifVersions: Record<string, number>) => roomRequest(fix, `/board?if_versions=${encodeURIComponent(JSON.stringify(ifVersions))}`, {
        method: "PATCH",
        headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" },
        body: JSON.stringify({ tasks: { a: 3 }, notes: "n2", fresh: true }),
      });

      const stale = await patch({ tasks: 1, notes: 1, fresh: 0 });
      expect(stale.status).toBe(409);
      expect((await stale.json() as { conflicts: Array<{ key: string }> }).conflicts.map((c) => c.key)).toEqual(["tasks"]);
      const unchanged = await getRoomJson<{ board: Record<string, { value: unknown }> }>(fix, "/board", "agent-a");
      expect([unchanged.board.tasks.value, unchanged.board.notes.value, unchanged.board.fresh]).toEqual([{ a: 2 }, "n1", undefined]);

      expect((await patch({ tasks: 2, notes: 1, fresh: 0 })).status).toBe(200);
    });

    it("if_version=0 creates only when the key does not exist; deletes check versions too", async () => {
      expect((await put("claim", { owner: "agent-a" }, 0)).status).toBe(200);
      expect((await put("claim", { owner: "someone-else" }, 0)).status).toBe(409);
      const del = (v: number) => roomRequest(fix, `/board/claim?if_version=${v}`, { method: "DELETE", headers: participantAuthHeaders(fix, "agent-a") });
      expect((await del(5)).status).toBe(409);
      expect((await del(1)).status).toBe(200);
    });
  });

});

describe("sprint spec briefs on the board", () => {
  const spec = [
    "# Sprint goal",
    "",
    "## Tasks",
    "- t1 Seed briefs",
    "  files: packages/sdk/src/spec.ts",
    "  role: builder",
    "  brief: late joiners read  briefs from the board, never from chat",
    "- t2 No brief",
    "  files: packages/sdk/src/tasks.ts",
  ].join("\n");
  const BRIEF = "late joiners read  briefs from the board, never from chat";

  it("keeps a one-line brief with its inner spacing while parsing the spec", () => {
    expect(parseSprintSpec(spec)).toEqual([
      { id: "t1", title: "Seed briefs", files: ["packages/sdk/src/spec.ts"], role: "builder", brief: BRIEF },
      { id: "t2", title: "No brief", files: ["packages/sdk/src/tasks.ts"] },
    ]);
  });

  it("seeds the brief into the task board value and leaves tasks without brief unchanged", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "host");
    const board = await taskValues(fix, "host");
    expect(board["task.t1"].value).toEqual({
      title: "Seed briefs", files: ["packages/sdk/src/spec.ts"], depends_on: [], role: "builder", brief: BRIEF, status: "open",
    });
    expect(board["task.t2"].value).toEqual({ title: "No brief", files: ["packages/sdk/src/tasks.ts"], depends_on: [], status: "open" });
  });

  it("shows briefs to a participant that joins after the room was created", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "late-agent");
    const board = await taskValues(fix, "late-agent");
    expect((board["task.t1"].value as { brief?: string }).brief).toBe(BRIEF);
    expect("brief" in (board["task.t2"].value as Record<string, unknown>)).toBe(false);
  });

  it("refuses a multi-line or blank brief before the room exists", () => {
    const task = (brief: string): ParsedTask => ({ id: "t1", title: "A", files: ["a.ts"], brief });
    expect(() => applyTemplate("sprint", { tasks: [task("one\ntwo")] })).toThrow("invalid sprint task");
    expect(() => applyTemplate("sprint", { tasks: [task("   ")] })).toThrow("invalid sprint task");
  });
});

describe("sprint spec contract on the board", () => {
  const CONTRACT = "node scripts/check-contract.mjs --peer   ->   Contract check passed";
  const spec = [
    "# Sprint goal",
    "",
    "## Tasks",
    "- t1 Required checks",
    "  files: packages/sdk/src/spec.ts",
    "  role: builder",
    "  brief: contract is a first-class spec field",
    `  contract: ${CONTRACT}`,
    "- t2 No contract",
    "  files: packages/sdk/src/tasks.ts",
  ].join("\n");

  it("seeds the contract into the task board value and leaves tasks without one unchanged", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "host");
    const board = await taskValues(fix, "host");
    expect(board["task.t1"].value).toEqual({
      title: "Required checks", files: ["packages/sdk/src/spec.ts"], depends_on: [], role: "builder",
      brief: "contract is a first-class spec field", contract: CONTRACT, status: "open",
    });
    expect(board["task.t2"].value).toEqual({ title: "No contract", files: ["packages/sdk/src/tasks.ts"], depends_on: [], status: "open" });
  });

  it("lets a participant that joins after creation read the required checks from the board", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "late-agent");
    const board = await taskValues(fix, "late-agent");
    expect((board["task.t1"].value as { contract?: string }).contract).toBe(CONTRACT);
    expect("contract" in (board["task.t2"].value as Record<string, unknown>)).toBe(false);
  });

  /** Claim exactly like the SDK does: write the seeded value back with status and owner. */
  async function claim(fix: RoomFixture, id: string, as: string): Promise<number> {
    const seeded = (await taskValues(fix, as))[`task.${id}`] as { value: Record<string, unknown> };
    const res = await roomRequest(fix, `/board/task.${id}`, {
      method: "PUT",
      headers: { ...participantAuthHeaders(fix, as), "content-type": "application/json" },
      body: JSON.stringify({ ...seeded.value, status: "claimed", owner: as }),
    });
    return res.status;
  }

  it("echoes the contract text in the claim notice and keeps it on the board value", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "worker-1");
    expect(await claim(fix, "t1", "worker-1")).toBe(200);
    const [notice] = (await notices(fix, "worker-1")).filter((text) => text.includes("claimed t1"));
    expect(notice).toContain("worker-1 claimed t1");
    expect(notice).toContain(CONTRACT);
    expect((await taskValues(fix, "worker-1"))["task.t1"].value).toMatchObject({ status: "claimed", owner: "worker-1", contract: CONTRACT });
  });

  it("keeps the claim notice unchanged for a task without a contract", async () => {
    const fix = await sprintRoom(parseSprintSpec(spec));
    await joinParticipant(fix, "worker-2");
    expect(await claim(fix, "t2", "worker-2")).toBe(200);
    expect((await notices(fix, "worker-2")).filter((text) => text.includes("claimed"))).toEqual(["worker-2 claimed t2"]);
  });

  it("refuses a multi-line or blank contract before the room exists", () => {
    const task = (contract: string): ParsedTask => ({ id: "t1", title: "A", files: ["a.ts"], contract });
    expect(() => applyTemplate("sprint", { tasks: [task("one\ntwo")] })).toThrow("invalid sprint task");
    expect(() => applyTemplate("sprint", { tasks: [task("   ")] })).toThrow("invalid sprint task");
  });
});
