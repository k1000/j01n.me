import { describe, expect, it } from "vitest";
import { createRoomDirect } from "../../src/invite";
import { RendezvousSession } from "../../src/rendezvous";
import { applyTemplate } from "../../src/room/templates";
import { createMockState, getRoomJson, joinParticipant, participantAuthHeaders, roomRequest, type RoomFixture } from "./helpers";

async function sprintRoom(tasks: Array<{ id: string; title: string; files: string[]; depends_on?: string[]; worktree?: string; role?: string; brief?: string; contract?: string; needs?: string[] }>): Promise<RoomFixture> {
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
    { id: "T1", title: "Build API", files: ["src/api.ts"], worktree: "/tmp/t1", role: "builder" },
    { id: "T2", title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"] },
  ];

  it("creates one open board key per task and a standard kickoff from the create body", async () => {
    const fix = await sprintRoom(tasks);
    const { board } = await getRoomJson<{ board: Record<string, { value: unknown; version: number }> }>(fix, "/board");
    expect(Object.keys(board).sort()).toEqual(["kickoff", "task.T1", "task.T2"]);
    expect(board["task.T1"].value).toEqual({ title: "Build API", files: ["src/api.ts"], depends_on: [], worktree: "/tmp/t1", role: "builder", status: "open" });
    expect(board["task.T2"].value).toEqual({ title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open" });
    expect(board["task.T2"].version).toBe(1);
    const kickoff = board.kickoff.value as { rules: string[]; etiquette: string[] };
    expect(kickoff.rules.join(" ")).toContain("claim <id>");
    expect(kickoff.rules.join(" ")).toContain("pnpm check:contract");
    for (const role of ["Builder", "Verifier", "Auditor", "Tester"]) expect(kickoff.rules.join(" ")).toContain(`${role}:`);
    expect(kickoff.etiquette).toHaveLength(8);
    expect(kickoff.etiquette).toContainEqual(expect.stringContaining("@Name:role (e.g. @Leo:builder), or simply @Name"));
    expect(kickoff.etiquette).toContainEqual(expect.stringContaining("repo-root-relative paths, optionally with a line number (e.g. packages/sdk/src/node.ts:12)"));
    expect(kickoff.etiquette.join(" ")).toContain("--kind question");
    expect(kickoff.etiquette.join(" ")).toContain("--reply-to");
    expect(kickoff.etiquette.join(" ")).toContain("board key notes");
  });

  it("does not let an explicit board override generated task status", () => {
    const tpl = applyTemplate("sprint", { tasks, board: { "task.T1": { status: "done" }, notes: { ready: true } } });
    const seeded = tpl.board["task.T1"] as { encrypted_payload: string };
    expect(JSON.parse(atob(seeded.encrypted_payload.slice(3)))).toEqual({ title: "Build API", files: ["src/api.ts"], depends_on: [], worktree: "/tmp/t1", role: "builder", status: "open" });
    expect(tpl.board.notes).toEqual({ ready: true });
  });

  it("announces readable claims, done summaries and newly unblocked tasks", async () => {
    const fix = await sprintRoom(tasks);
    expect((await setTask(fix, "T1", { title: "Build API", files: ["src/api.ts"], depends_on: [], status: "claimed", owner: "agent-a" })).status).toBe(200);
    expect((await setTask(fix, "T1", { title: "Build API", files: ["src/api.ts"], depends_on: [], status: "done", owner: "agent-a", summary: "endpoint shipped" })).status).toBe(200);
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; body: { text: string } }> }>(fix, "/?view=all", "host");
    const notices = messages.filter((message) => message.intent === "board.changed").map((message) => message.body.text);
    expect(notices).toContain("agent-a claimed T1");
    expect(notices).toContain("T1 done: endpoint shipped; T2 is now unblocked");
    expect(messages.some((message) => message.intent === "task.unblocked")).toBe(false);
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

  it("sends a direct unblocked system notice only to a joined dependent owner", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "agent-b");
    await setTask(fix, "T2", { title: "Use API", files: [], depends_on: ["T1"], status: "claimed", owner: "agent-a", waiting_for: ["agent-a", "agent-a"] });
    await setTask(fix, "T1", { title: "Build API", files: [], depends_on: [], status: "done", summary: "ready" });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: { task_id: string } }> }>(fix, "/?view=all", id)).messages;
    expect((await read("agent-a")).filter((message) => message.intent === "task.unblocked")).toEqual([
      expect.objectContaining({ to: "agent-a", body: { text: "T2 is now unblocked by T1: ready", task_id: "T2", blocked_by: ["T1"], summary: "ready", commit: "" } }),
    ]);
    expect((await read("host")).some((message) => message.intent === "task.unblocked")).toBe(false);
    expect((await read("agent-b")).some((message) => message.intent === "task.unblocked")).toBe(false);
  });

  it("wakes registered waiters on an open dependent task after its prerequisite finishes", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "agent-b");
    // A rejected claim records interest without claiming or reserving the still-blocked task.
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open", waiting_for: ["agent-a", "agent-b"] });
    await setTask(fix, "T1", { title: "Build API", files: [], depends_on: [], status: "done", summary: "ready" });
    for (const id of ["agent-a", "agent-b"]) {
      const { messages } = await getRoomJson<{ messages: Array<{ intent: string; to: string; body: { task_id: string } }> }>(fix, "/?view=all", id);
      expect(messages.filter((message) => message.intent === "task.unblocked")).toEqual([
        expect.objectContaining({ to: id, body: { text: "T2 is now unblocked by T1: ready", task_id: "T2", blocked_by: ["T1"], summary: "ready", commit: "" } }),
      ]);
    }
    const { board } = await getRoomJson<{ board: Record<string, { value: { status: string; waiting_for: string[] } }> }>(fix, "/board", "host");
    expect(board["task.T2"].value).toMatchObject({ status: "open", waiting_for: ["agent-a", "agent-b"] });
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

  it("includes predecessor id, summary and commit in the unblocked notice body", async () => {
    const fix = await sprintRoom(tasks);
    await setTask(fix, "T2", { title: "Use API", files: [], depends_on: ["T1"], status: "claimed", owner: "agent-a" });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "agent-a",
      summary: "endpoint shipped",
      evidence: { commits: ["8569dda1234567890abcdef"], tests: "vitest passed", contract: "passed" },
    });
    const { messages } = await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", "agent-a");
    const unblocked = messages.filter((m) => m.intent === "task.unblocked");
    expect(unblocked).toHaveLength(1);
    const body = unblocked[0].body;
    expect(body.task_id).toBe("T2");
    expect(body.blocked_by).toEqual(["T1"]);
    expect(body.summary).toBe("endpoint shipped");
    expect(body.commit).toBe("8569dda1234567890abcdef");
    expect(typeof body.text).toBe("string");
    expect((body.text as string)).toContain("T1");
    expect((body.text as string)).toContain("endpoint shipped");
    expect((body.text as string)).toContain("8569dda");
  });

  it("routes a role-tagged dependent to the first free matching participant when its prerequisite finishes", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "builder-a", { role: "builder" });
    await joinParticipant(fix, "verifier-a", { role: "verifier" });
    // Set T2 with a role so routing kicks in.
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open", role: "builder" });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "host",
      summary: "api ready", evidence: { commits: ["abc1234567890"] },
    });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", id)).messages;
    // The builder should receive a targeted task.unblocked with assigned field.
    const builderMessages = (await read("builder-a")).filter((m) => m.intent === "task.unblocked");
    expect(builderMessages).toHaveLength(1);
    expect(builderMessages[0].body).toMatchObject({ task_id: "T2", assigned: "builder-a", summary: "api ready", commit: "abc1234567890" });
    // The verifier should NOT receive an unblocked notice (role mismatch).
    const verifierMessages = (await read("verifier-a")).filter((m) => m.intent === "task.unblocked");
    expect(verifierMessages).toHaveLength(0);
    // A board.changed with routing text should be present.
    const allMessages = (await read("host")).filter((m) => m.intent === "task.routed");
    expect(allMessages).toHaveLength(1);
    expect(allMessages[0].body.text).toContain("T2 routed to builder-a (role: builder)");
  });

  it("leaves the notice bare when the only matching participant is busy", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "builder-a", { role: "builder" });
    // Mark builder-a as busy after joining (join always sets state=free).
    await roomRequest(fix, `/participants/builder-a`, {
      method: "PATCH",
      headers: { ...participantAuthHeaders(fix, "builder-a"), "content-type": "application/json" },
      body: JSON.stringify({ state: "busy" }),
    });
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "claimed", owner: "builder-a", role: "builder" });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "host",
      summary: "api ready", evidence: { commits: ["def4567890123"] },
    });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", id)).messages;
    // The busy builder is the owner, so they receive the bare unblocked notice (no assigned field).
    const builderMessages = (await read("builder-a")).filter((m) => m.intent === "task.unblocked");
    expect(builderMessages).toHaveLength(1);
    expect(builderMessages[0].body.assigned).toBeUndefined();
    // No routing announcement since no free builder matched.
    const routedMessages = (await read("host")).filter((m) => m.intent === "task.routed");
    expect(routedMessages).toHaveLength(0);
  });

  it("leaves the notice bare when no participant matches the required role", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "verifier-a", { role: "verifier" });
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open", role: "builder" });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "host",
      summary: "api ready", evidence: { commits: ["aaa1111111111"] },
    });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", id)).messages;
    // No builder joined: no targeted notice, no routing announcement.
    const routedMessages = (await read("host")).filter((m) => m.intent === "task.routed");
    expect(routedMessages).toHaveLength(0);
    const unblockedMessages = (await read("verifier-a")).filter((m) => m.intent === "task.unblocked");
    expect(unblockedMessages).toHaveLength(0);
  });

  it("seeds needs into the task board value and round-trips them", async () => {
    const tasksWithNeeds = [
      { id: "T1", title: "Build API", files: ["src/api.ts"], role: "builder", needs: ["code", "shell"] },
      { id: "T2", title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], role: "builder", needs: ["code"] },
    ];
    const fix = await sprintRoom(tasksWithNeeds);
    const { board } = await getRoomJson<{ board: Record<string, { value: { needs?: string[] } }> }>(fix, "/board");
    expect(board["task.T1"].value.needs).toEqual(["code", "shell"]);
    expect(board["task.T2"].value.needs).toEqual(["code"]);
  });

  it("routes to a capable participant and posts unrouted text when none qualifies", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "builder-a", { role: "builder", capabilities: ["code", "shell"] });
    await joinParticipant(fix, "builder-b", { role: "builder", capabilities: ["code"] });
    // Mark builder-b as busy after joining.
    await roomRequest(fix, `/participants/builder-b`, {
      method: "PATCH",
      headers: { ...participantAuthHeaders(fix, "builder-b"), "content-type": "application/json" },
      body: JSON.stringify({ state: "busy" }),
    });
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open", role: "builder", needs: ["shell"] });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "host",
      summary: "api ready", evidence: { commits: ["bbb2222222222"] },
    });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", id)).messages;
    // builder-a has shell, so they get the targeted notice.
    const builderAMessages = (await read("builder-a")).filter((m) => m.intent === "task.unblocked");
    expect(builderAMessages).toHaveLength(1);
    expect(builderAMessages[0].body).toMatchObject({ task_id: "T2", assigned: "builder-a" });
    // builder-b lacks shell, so no notice.
    const builderBMessages = (await read("builder-b")).filter((m) => m.intent === "task.unblocked");
    expect(builderBMessages).toHaveLength(0);
    // Routing announcement includes needs.
    const routedMessages = (await read("host")).filter((m) => m.intent === "task.routed");
    expect(routedMessages).toHaveLength(1);
    expect(routedMessages[0].body.text).toContain("T2 routed to builder-a (role: builder, needs: shell)");
  });

  it("posts unrouted notice text when no free capable holder exists", async () => {
    const fix = await sprintRoom(tasks);
    await joinParticipant(fix, "builder-a", { role: "builder", capabilities: ["code"] });
    // Mark builder-a as busy after joining.
    await roomRequest(fix, `/participants/builder-a`, {
      method: "PATCH",
      headers: { ...participantAuthHeaders(fix, "builder-a"), "content-type": "application/json" },
      body: JSON.stringify({ state: "busy" }),
    });
    await setTask(fix, "T2", { title: "Use API", files: ["src/ui.ts"], depends_on: ["T1"], status: "open", role: "builder", needs: ["shell"] });
    await setTask(fix, "T1", {
      title: "Build API", files: [], depends_on: [], status: "done", owner: "host",
      summary: "api ready", evidence: { commits: ["ccc3333333333"] },
    });
    const read = async (id: string) => (await getRoomJson<{ messages: Array<{ intent: string; to: string; body: Record<string, unknown> }> }>(fix, "/?view=all", id)).messages;
    // No free capable builder: unrouted notice text.
    const unroutedMessages = (await read("host")).filter((m) => m.intent === "task.unrouted");
    expect(unroutedMessages).toHaveLength(1);
    expect(unroutedMessages[0].body.text).toBe("T2 unrouted: needs shell, no free capable holder");
    // No targeted unblocked notice.
    const builderAMessages = (await read("builder-a")).filter((m) => m.intent === "task.unblocked");
    expect(builderAMessages).toHaveLength(0);
  });
});
