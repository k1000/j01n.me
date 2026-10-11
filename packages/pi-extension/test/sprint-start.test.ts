import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sprint start owner invitation", () => {
  it("assigns one browser opener and retries only the side-effect-free readiness check", () => {
    const script = readFileSync(new URL("../../../scripts/sprint.mjs", import.meta.url), "utf8");
    expect(script).toContain("the start script opens the owner invitation once, so do not run invite-link --open yourself");
    expect(script.match(/\[hostHelper, "invite-link", "--open"\]/g)).toHaveLength(1);
    expect(script.indexOf("if (!inviteReady) fail")).toBeLessThan(script.indexOf('[hostHelper, "invite-link", "--open"]'));
    expect(script).toContain("owner invitation may have opened; check the browser before retrying manually");
  });
});
