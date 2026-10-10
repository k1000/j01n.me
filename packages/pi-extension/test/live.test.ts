import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealForRoom } from "@j01n/sdk/crypto";
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

describe("pi live mode", () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("injects one batch: participants wake the agent with a reply command, system notices do not, own and key messages are skipped", async () => {
    const { formatBatch } = await import("../live");
    const batch = formatBatch(me, [
      message("claude-code", "Can you review?", { expects_reply: { due_at: "x" } } as never),
      message("system", "claude-code reserved files (1)"),
      message("pi-agent", "my own"),
      message("claude-code", "", { intent: "key.exchange" }),
    ])!;
    expect(batch.wake).toBe(true);
    expect(batch.text).toBe("j01n room room-1 · 2 new:\n**claude-code** (asks for a reply): Can you review?\n  reply: /j01n send claude-code <text> --reply-to id-claude-code\n· claude-code reserved files (1)");
    expect(formatBatch(me, [message("system", "agent-b joined")])!.wake).toBe(false);
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked", task_id: "T2" } })])!.wake).toBe(true);
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "other", body: { text: "T2 is now unblocked", task_id: "T2" } })])!.wake).toBe(false);
    expect(formatBatch(me, [message("system", "T2 is now unblocked", { intent: "task.unblocked", to: "pi-agent", body: { text: "T2 is now unblocked" } })])!.wake).toBe(false);
    expect(formatBatch(me, [message("pi-agent", "own")])).toBeNull();
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
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (String(url).endsWith("/board")) return Response.json({ board: { reservations: { value: { r1: { by: "claude-code", since: "now", sealed } }, version: 1 } }, board_schema: null });
      if (String(url).includes("/wait")) { await new Promise((r) => setTimeout(r, 20)); return Response.json({ timeout: true, cursor: 0 }); }
      return Response.json({ ok: true, cursor: 0, messages: [], participants: [], participant: {} });
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
