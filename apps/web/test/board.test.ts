import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BOARD_VALUE_BYTES } from "../src/constants";
import {
  bootstrapRoom,
  encryptedPayload,
  getRoomJson,
  joinParticipant,
  participantAuthHeaders,
  roomRequest,
  type RoomFixture,
} from "./room/helpers";

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

    it("if_version=0 creates only when the key does not exist; deletes check versions too", async () => {
      expect((await put("claim", { owner: "agent-a" }, 0)).status).toBe(200);
      expect((await put("claim", { owner: "someone-else" }, 0)).status).toBe(409);
      const del = (v: number) => roomRequest(fix, `/board/claim?if_version=${v}`, { method: "DELETE", headers: participantAuthHeaders(fix, "agent-a") });
      expect((await del(5)).status).toBe(409);
      expect((await del(1)).status).toBe(200);
    });
  });

});
