import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sprint start owner invitation", () => {
  it("uses one state-guarded owner delivery and never opens a browser tab", () => {
    const script = readFileSync(new URL("../../../scripts/sprint.mjs", import.meta.url), "utf8");
    expect(script).not.toContain('"invite-link", "--open"');
    expect(script).toContain('if (!state.delivered && state.invite_to && state.invite_to !== "none")');
    expect(script).toContain('state.delivered = true; acted = true; saveState(state);');
    expect(script).toContain('exec("hermes", ["send", "-t", state.invite_to, "-f", file, "-q"]');
  });
});
