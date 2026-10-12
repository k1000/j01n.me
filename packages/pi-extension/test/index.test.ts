import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../index";

vi.mock("../version", () => ({ getExtensionDiagnostics: () => ({ warnings: ["Installed checkout changed; run /reload."] }) }));

describe("Pi session startup", () => {
  it("serves help from the j01n tool without a joined room", async () => {
    let execute: ((id: string, params: { args: string[] }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>) | undefined;
    extension({ on: () => {}, registerCommand: () => {}, registerTool: (tool: { name: string; execute: typeof execute }) => {
      if (tool.name === "j01n") execute = tool.execute;
    } } as unknown as ExtensionAPI);
    expect(execute).toBeDefined();
    const result = await execute!("call", { args: ["help"] });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("Commands:");
    expect(result.content[0].text).toContain("/j01n help");
  });

  it("warns about a stale or duplicate extension only when the UI is available", () => {
    type Ctx = { hasUI: boolean; ui: { notify: (message: string, level: string) => void }; sessionManager?: { getSessionId(): string } };
    const handlers = new Map<string, Array<(event: unknown, ctx: Ctx) => void>>();
    const tools: string[] = [];
    extension({ on: (name: string, handler: (event: unknown, ctx: Ctx) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
      registerCommand: () => {}, registerTool: (tool: { name: string }) => { tools.push(tool.name); } } as unknown as ExtensionAPI);
    expect(tools).toContain("invite_integrator");
    // index() registers the diagnostics handler first, before live/peer-spawn handlers.
    const start = handlers.get("session_start")?.[0];
    expect(start).toBeDefined();

    const notify = vi.fn();
    start?.({}, { hasUI: false, ui: { notify } });
    expect(notify).not.toHaveBeenCalled();
    start?.({}, { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledWith("j01n: Installed checkout changed; run /reload.", "error");
  });
});
