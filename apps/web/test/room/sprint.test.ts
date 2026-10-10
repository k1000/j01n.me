import { describe, expect, it } from "vitest";
import { createRoomDirect } from "../../src/invite";
import { RendezvousSession } from "../../src/rendezvous";
import { applyTemplate } from "../../src/room/templates";
import { createMockState, getRoomJson, joinParticipant, participantAuthHeaders, roomRequest, type RoomFixture } from "./helpers";

async function sprintRoom(tasks: Array<{ id: string; title: string; files: string[]; depends_on?: string[]; worktree?: string }>): Promise<RoomFixture> {
  const session = new RendezvousSession(createMockState(), {} as never);
  const env = { RENDEZVOUS: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (url: string, init: RequestInit) => session.fetch(new Request(url, init)) }),
  } as unknown as DurableObjectNamespace };
  const { roomId, joinSecret } = await createRoomDirect(env, { template: "sprint", host_id: "host", tasks }, "https://j01n.me");
  const fix: RoomFixture = { session, roomId, joinSecret, roomPath: `/r/${roomId}`, participantTokens: {} };
  await joinParticipant(fix, "host");
  await joinParticipant(fix, "agent-a");
  return fix;
}

async function setTask(fix: RoomFixture, id: string, value: Record<string, unknown>): Promise<Response> {
  return roomRequest(fix, `/board/task.${id}`, {
    method: "PUT", headers: { ...participantAuthHeaders(fix, "agent-a"), "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

describe("sprint template", () => {
  const tasks = [
    { id: "T1", title: "Build API", files: ["src/api.ts"], worktree: "/tmp/t1" },
    { id: "T2", title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"] },
  ];

  it("creates one open board key per task and a standard kickoff from the create body", async () => {
    const fix = await sprintRoom(tasks);
    const { board } = await getRoomJson<{ board: Record<string, { value: unknown; version: number }> }>(fix, "/board");
    expect(Object.keys(board).sort()).toEqual(["kickoff", "task.T1", "task.T2"]);
    expect(board["task.T1"].value).toEqual({ title: "Build API", files: ["src/api.ts"], depends_on: [], worktree: "/tmp/t1", status: "open" });
    expect(board["task.T2"].value).toEqual({ title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open" });
    expect(board["task.T2"].version).toBe(1);
    expect(board.kickoff.value).toContain("claim <id>");
    expect(board.kickoff.value).toContain("pnpm check:contract");
  });

  it("announces readable claims, done summaries and newly unblocked tasks", async () => {
    const fix = await sprintRoom(tasks);
    expect((await setTask(fix, "T1", { title: "Build API", files: ["src/api.ts"], depends_on: [], status: "claimed", owner: "agent-a" })).status).toBe(200);
    expect((await setTask(fix, "T1", { title: "Build API", files: ["src/api.ts"], depends_on: [], status: "done", owner: "agent-a", summary: "endpoint shipped" })).status).toBe(200);
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; body: { text: string } }> }>(fix, "/?view=all", "host");
    const notices = messages.filter((message) => message.intent === "board.changed").map((message) => message.body.text);
    expect(notices).toContain("agent-a claimed T1");
    expect(notices).toContain("T1 done: endpoint shipped; T2 is now unblocked");
  });

  it("does not announce a dependent until all dependencies are done", async () => {
    const fix = await sprintRoom([...tasks, { id: "T3", title: "Ship", files: ["src/release.ts"], depends_on: ["T1", "T2"] }]);
    await setTask(fix, "T1", { title: "Build API", files: [], depends_on: [], status: "done", summary: "ready" });
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; body: { text: string } }> }>(fix, "/?view=all", "host");
    expect(messages.filter((message) => message.intent === "board.changed").at(-1)?.body.text).toBe("T1 done: ready; T2 is now unblocked");
  });

  it("announces only the dependent newly unblocked after the final prerequisite", async () => {
    const fix = await sprintRoom([...tasks, { id: "T3", title: "Ship", files: ["src/release.ts"], depends_on: ["T1", "T2"] }]);
    await setTask(fix, "T1", { title: "Build API", files: [], depends_on: [], status: "done", summary: "ready" });
    await setTask(fix, "T2", { title: "Use API", files: [], depends_on: ["T1"], status: "done", summary: "integrated" });
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; body: { text: string } }> }>(fix, "/?view=all", "host");
    expect(messages.filter((message) => message.intent === "board.changed").at(-1)?.body.text).toBe("T2 done: integrated; T3 is now unblocked");
  });

  it("does not call an independently blocked dependent unblocked", async () => {
    const fix = await sprintRoom(tasks);
    await setTask(fix, "T2", { title: "Use API", files: [], depends_on: ["T1"], status: "blocked", blocked_reason: "awaiting approval" });
    await setTask(fix, "T1", { title: "Build API", files: [], depends_on: [], status: "done", summary: "ready" });
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; body: { text: string } }> }>(fix, "/?view=all", "host");
    expect(messages.filter((message) => message.intent === "board.changed").at(-1)?.body.text).toBe("T1 done: ready");
  });

  it("rejects duplicate IDs, unknown dependencies and generated task files", () => {
    expect(() => applyTemplate("sprint", { tasks: [tasks[0], tasks[0]] })).toThrow("invalid sprint task");
    expect(() => applyTemplate("sprint", { tasks: [{ ...tasks[1], depends_on: ["missing"] }] })).toThrow("unknown or self dependency");
    expect(() => applyTemplate("sprint", { tasks: [{ ...tasks[0], files: ["apps/web/src/markdown-assets.ts"] }] })).toThrow("generated files");
  });
});
