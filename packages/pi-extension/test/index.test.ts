import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "../index";

vi.mock("../version", () => ({ getExtensionDiagnostics: () => ({ warnings: ["Installed checkout changed; run /reload."] }) }));

describe("Pi session startup", () => {
  it("warns about a stale or duplicate extension only when the UI is available", () => {
    type Ctx = { hasUI: boolean; ui: { notify: (message: string, level: string) => void }; sessionManager?: { getSessionId(): string } };
    const handlers = new Map<string, Array<(event: unknown, ctx: Ctx) => void>>();
    extension({ on: (name: string, handler: (event: unknown, ctx: Ctx) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
      registerCommand: () => {}, registerTool: () => {} } as unknown as ExtensionAPI);
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
