import { describe, expect, it } from "vitest";
import { parseSprintSpec } from "../src/spec";

const specWith = (tasks: string) => `# Sprint\nProse outside the tasks.\n\n## Tasks\n${tasks}\n`;

describe("parseSprintSpec brief field", () => {
  it("keeps an optional one-line brief with its inner spacing verbatim", () => {
    const tasks = parseSprintSpec(specWith([
      "- t1 Read the board",
      "  files: packages/sdk/src/spec.ts",
      "  role: builder",
      "  brief: parseSprintSpec  gains   an optional `brief:` line  ->  board task.<id>",
      "- t2 No brief here",
      "  files: packages/sdk/src/tasks.ts",
    ].join("\n")));
    expect(tasks).toEqual([
      {
        id: "t1", title: "Read the board", files: ["packages/sdk/src/spec.ts"], role: "builder",
        brief: "parseSprintSpec  gains   an optional `brief:` line  ->  board task.<id>",
      },
      { id: "t2", title: "No brief here", files: ["packages/sdk/src/tasks.ts"] },
    ]);
  });

  it("accepts a brief as the first field and trims surrounding whitespace only", () => {
    const [task] = parseSprintSpec(specWith("- t1 A\n  brief:  late joiners read briefs from the board  \n  files: a.ts"));
    expect(task.brief).toBe("late joiners read briefs from the board");
  });

  it("seeds tasks without brief unchanged", () => {
    expect(parseSprintSpec(specWith("- t1 A\n  files: a.ts"))).toEqual([{ id: "t1", title: "A", files: ["a.ts"] }]);
  });

  it("refuses a repeated brief field and an empty brief", () => {
    expect(() => parseSprintSpec(specWith("- t1 A\n  files: a.ts\n  brief: one\n  brief: two"))).toThrow("invalid spec task line");
    expect(() => parseSprintSpec(specWith("- t1 A\n  files: a.ts\n  brief:"))).toThrow("needs brief");
  });

  it.each([
    ["multi-line brief is refused", "- t1 A\n  brief: first line\n  second line\n  files: a.ts"],
    ["empty brief is refused", "- t1 A\n  brief:\n  files: a.ts"],
    ["duplicate brief is refused", "- t1 A\n  brief: one\n  brief: two\n  files: a.ts"],
  ])("refuses invalid brief input (%s)", (_label, tasks) => {
    expect(() => parseSprintSpec(specWith(tasks))).toThrow(/invalid spec task line|needs brief/);
  });
});

describe("parseSprintSpec contract field", () => {
  it("keeps an optional one-line contract with its inner spacing verbatim", () => {
    const tasks = parseSprintSpec(specWith([
      "- t1 Required checks", "  files: packages/sdk/src/spec.ts", "  role: builder",
      "  brief: parse  a contract:  line",
      "  contract: npx  vitest run   packages/sdk/test/spec.test.ts  ->  12 passed",
      "- t2 No contract here", "  files: packages/sdk/src/tasks.ts",
    ].join("\n")));
    expect(tasks).toEqual([
      {
        id: "t1", title: "Required checks", files: ["packages/sdk/src/spec.ts"], role: "builder",
        brief: "parse  a contract:  line",
        contract: "npx  vitest run   packages/sdk/test/spec.test.ts  ->  12 passed",
      },
      { id: "t2", title: "No contract here", files: ["packages/sdk/src/tasks.ts"] },
    ]);
  });

  it("accepts a contract before the other fields and trims surrounding whitespace only", () => {
    const [task] = parseSprintSpec(specWith("- t1 A\n  contract:  pnpm check:contract --peer passed  \n  files: a.ts"));
    expect(task.contract).toBe("pnpm check:contract --peer passed");
  });

  it("seeds tasks without contract unchanged", () => {
    expect(parseSprintSpec(specWith("- t1 A\n  files: a.ts\n  brief: just a brief"))).toEqual([
      { id: "t1", title: "A", files: ["a.ts"], brief: "just a brief" },
    ]);
  });

  it.each([
    ["continuation line after a contract", "- t1 A\n  contract: first line\n  second line\n  files: a.ts"],
    ["empty contract", "- t1 A\n  contract:\n  files: a.ts"],
    ["blank contract", "- t1 A\n  contract:    \n  files: a.ts"],
    ["duplicate contract", "- t1 A\n  contract: one\n  contract: two\n  files: a.ts"],
  ])("refuses an invalid contract (%s)", (_label, tasks) => {
    expect(() => parseSprintSpec(specWith(tasks))).toThrow(/invalid spec task line|needs contract/);
  });
});
