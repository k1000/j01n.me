import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealForRoom } from "@j01n/sdk/crypto";
import { detectWorkspace } from "@j01n/sdk/node";
import type { RoomClient } from "@j01n/sdk";
import type { RoomMessage } from "@j01n/sdk/types";

const ROOM = "https://j01n.me/r/room-1";
const me = { participantId: "pi-agent", invite: { room_id: "room-1" } } as unknown as RoomClient;
const message = (from: string, text: string, extra: Partial<RoomMessage> = {}) =>
  ({ id: `id-${from}`, seq: 1, from, to: "all", intent: "notify", body: { text }, ...extra }) as RoomMessage;

describe("modelPatchFor", () => {
  it("announces a new model once and stays quiet when the room row already matches", async () => {
    const { modelPatchFor } = await import("../live");
    expect(modelPatchFor({ model: "qwen3.8-flash" }, undefined)).toEqual({ model: "qwen3.8-flash" });
    expect(modelPatchFor({ model: "qwen3.8-flash", provider: "token-plan" }, { model: "qwen3.8-flash", provider: "token-plan" })).toBeUndefined();
    expect(modelPatchFor({ model: "qwen3.8-flash", provider: "token-plan" }, { model: "qwen3.8-flash" })).toEqual({ model: "qwen3.8-flash", provider: "token-plan" });
    expect(modelPatchFor({}, undefined)).toBeUndefined();
    expect(modelPatchFor({ model: "x" }, { model: "x" })).toBeUndefined();
  });
});

describe("live identity scoping", () => {
  it("uses only the spawned peer's room identity and refuses ambiguous model announcements", async () => {
    const { liveClientsForProcess, modelAnnounceClients } = await import("../live");
    const host = { participantId: "host", invite: { room_id: "room-1", room_url: ROOM } } as RoomClient;
    const peer = { participantId: "ravi", invite: { room_id: "room-1", room_url: ROOM } } as RoomClient;
    expect(liveClientsForProcess([host, peer], { J01N_PEER_ROOM_ID: "room-1", J01N_PEER_PARTICIPANT_ID: "ravi" })).toEqual([peer]);
    expect(liveClientsForProcess([host, peer], { J01N_PEER_PARTICIPANT_ID: "ravi" })).toEqual([]);
    expect(liveClientsForProcess([host, peer], {})).toEqual([]);
    expect(modelAnnounceClients([host, peer])).toEqual([]);
    expect(modelAnnounceClients([peer])).toEqual([peer]);
  });
});

describe("pi live mode", () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("digests broadcasts without waking, wakes direct messages, and skips own/key messages", async () => {
    const { formatBatch } = await import("../live");
    const batch = formatBatch(me, [
      message("claude-code", "Can you review?", { expects_reply: { due_at: "x" } } as never),
      message("system", "claude-code reserved files (1)"),
      message("pi-agent", "my own"),
      message("claude-code", "", { intent: "key.exchange" }),
    ])!;
    expect(batch.wake).toBe(false);
    expect(batch.text).toBe("j01n room room-1 · 2 new:\n**claude-code** (asks for a reply): Can you review?\n  reply: /j01n send claude-code <text> --reply-to id-claude-code\n· claude-code reserved files (1)");
    for (const kind of ["finding", "decision", "question", "blocker", "handoff"] as const) {
      expect(formatBatch(me, [message("claude-code", "Update", { kind })])!.wake).toBe(false);
      expect(formatBatch(me, [message("claude-code", "Update", { kind, to: "pi-agent" })])!.wake).toBe(true);
    }
    expect(formatBatch(me, [message("claude-code", "review", { kind: "handoff", to: ["other", "pi-agent"] })])!.wake).toBe(true);
    expect(formatBatch(me, [message("claude-code", "Found it", { kind: "finding" })])!.text).toContain("[finding]");
    expect(formatBatch(me, [message("system", "agent-b joined")])!.wake).toBe(false);
    // Untargeted unblocked (no assigned field) does NOT wake
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked", task_id: "T2" } })])!.wake).toBe(false);
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "other", body: { text: "T2 is now unblocked", task_id: "T2" } })])!.wake).toBe(false);
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked" } })])!.wake).toBe(false);
    // task.unblocked with assigned == self wakes
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked", task_id: "T2", assigned: "pi-agent", blocked_by: ["T1"], summary: "done", commit: "abc1234567890" } })])!.wake).toBe(true);
    // task.unblocked with assigned != self does NOT wake
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked", task_id: "T2", assigned: "other" } })])!.wake).toBe(false);
    // task.assigned direct to self wakes
    expect(formatBatch(me, [message("system", "T3 assigned", { intent: "task.assigned", to: "pi-agent", body: { task: { id: "T3", title: "CLI assign hint" } } })])!.wake).toBe(true);
    // task.assigned to other does NOT wake
    expect(formatBatch(me, [message("system", "T3 assigned", { intent: "task.assigned", to: "other", body: { task: { id: "T3", title: "CLI assign hint" } } })])!.wake).toBe(false);
    expect(formatBatch(me, [message("pi-agent", "own")])).toBeNull();
  });

  it("formats task.assigned and task.unblocked digest lines with ready command", async () => {
    const { formatBatch } = await import("../live");
    // task.assigned digest line
    const assigned = formatBatch(me, [message("system", "T3 assigned", { intent: "task.assigned", to: "pi-agent", body: { task: { id: "t3", title: "CLI assign hint" } } })])!;
    expect(assigned.text).toContain("Task t3 assigned to you: CLI assign hint");
    expect(assigned.text).toContain("ready: j01n claim t3");
    // task.unblocked with assigned == self digest line
    const unblocked = formatBatch(me, [message("system", "T2 unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 unblocked", task_id: "t2", assigned: "pi-agent", blocked_by: ["t1"], summary: "assign verb", commit: "abc1234567890" } })])!;
    expect(unblocked.text).toContain("Task t2 unblocked and assigned to you");
    expect(unblocked.text).toContain("predecessor: t1 — assign verb (commit abc1234)");
    expect(unblocked.text).toContain("ready: j01n claim t2");
    // task.unblocked without summary/commit still shows ready command
    const unblockedMinimal = formatBatch(me, [message("system", "T2 unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 unblocked", task_id: "t2", assigned: "pi-agent" } })])!;
    expect(unblockedMinimal.text).toContain("Task t2 unblocked and assigned to you");
    expect(unblockedMinimal.text).toContain("ready: j01n claim t2");
    expect(unblockedMinimal.text).not.toContain("predecessor:");
  });

  it("turns tool calls into a short activity", async () => {
    const { activityOf } = await import("../live");
    expect(activityOf("edit", { path: "/repo/src/a.ts" }, "/repo")).toBe("editing src/a.ts");
    expect(activityOf("bash", { command: "pnpm vitest run" }, "/repo")).toBe("running tests");
    expect(activityOf("bash", { command: "git commit -m x" }, "/repo")).toBe("committing");
    expect(activityOf("read", { path: "x" }, "/repo")).toBe("exploring the code");
  });

  it("blocks editing a path another participant reserved, naming the holder and how to reach them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "j01n-live-"));
    process.chdir(dir);
    const sealed = await sealForRoom({ repo: process.cwd(), paths: ["src/auth"], reason: "refactoring auth" }, "secret", "room-1");
    const checkout = detectWorkspace("secret", "room-1").checkout;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (String(url).endsWith("/board")) return Response.json({ board: { reservations: { value: { r1: { by: "claude-code", since: "now", checkout, sealed } }, version: 1 } }, board_schema: null });
      if (String(url).includes("/wait")) { await new Promise((r) => setTimeout(r, 20)); return Response.json({ timeout: true, cursor: 0 }); }
      return Response.json({ ok: true, cursor: 0, messages: [], participants: ["pi-agent", "claude-code"].map((id) => ({ id, checkout })), participant: {} });
    });
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent", "--no-workspace"]);

    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    const pi = { on: (name: string, fn: never) => { handlers[name] = fn; }, sendMessage: vi.fn() };
    const { registerLive } = await import("../live");
    const live = registerLive(pi as never);
    await live.refresh();
    const ctx = { ui: { notify: vi.fn() } };

    const blocked = await handlers.tool_call({ toolName: "edit", input: { path: join(process.cwd(), "src/auth/login.ts") } }, ctx) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("src/auth/login.ts is reserved by claude-code (refactoring auth)");
    expect(blocked.reason).toContain("/j01n send claude-code");
    expect(await handlers.tool_call({ toolName: "edit", input: { path: "docs/readme.md" } }, ctx)).toBeUndefined();

    live.setEnabled(false);
    await handlers.session_shutdown({}, ctx);
  });
});
