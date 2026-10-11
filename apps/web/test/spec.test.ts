import { describe, expect, it } from "vitest";
import { parseSprintSpec } from "@j01n/sdk/spec";

describe("sprint Markdown specs", () => {
  it("extracts tasks only from ## Tasks, preserving roles, dependencies and worktrees", () => {
    const spec = `# Sprint\nGoal outside the tasks.\n\n## Tasks\n- T11 Implement CLI\n  files: packages/helper/src/cli.ts, apps/web/src/cli.md\n  role: builder\n  worktree: w8/t11\n- T12 Verify it\n  files: apps/web/test/spec.test.ts\n  depends: T11\n\n## Review\n- T99 Not a task\n`;
    expect(parseSprintSpec(spec)).toEqual([
      { id: "T11", title: "Implement CLI", files: ["packages/helper/src/cli.ts", "apps/web/src/cli.md"], role: "builder", worktree: "w8/t11" },
      { id: "T12", title: "Verify it", files: ["apps/web/test/spec.test.ts"], depends_on: ["T11"] },
    ]);
  });

  it.each([
    ["# Sprint", "## Tasks"],
    ["## Tasks\n- T1 A\n  files: a.ts\n## Other\n## Tasks\n- T2 B\n  files: b.ts", "exactly one"],
    ["## Tasks\n- T1 A", "valid files"],
    ["## Tasks\n- T1 A\n  files: a.ts\n- T1 B\n  files: b.ts", "duplicate"],
    ["## Tasks\n- T1 A\n  files: a.ts\n  depends: T9", "dependency"],
    ["## Tasks\n- T1 A\n  files: packages/helper/src/client-script.ts", "generated files"],
    ["## Tasks\n- T1 A\n  files: a.ts\n  unsupported: x", "invalid spec task line"],
  ])("refuses invalid input before creating a room (%s)", (spec, reason) => {
    expect(() => parseSprintSpec(spec)).toThrow(reason);
  });
});
