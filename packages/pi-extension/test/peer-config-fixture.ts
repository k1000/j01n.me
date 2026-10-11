import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writePeerConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "peer-spawn.json");
  writeFileSync(path, JSON.stringify({
    defaultRole: "builder",
    defaultHarness: "pi",
    roles: {
      builder: {
        pi: { skills: ["builtin:builder"], tools: ["read", "bash", "edit", "write", "j01n"] },
        claude: { skills: ["builtin:builder"], tools: ["Read", "Bash", "Edit", "Write"] },
      },
      reviewer: {
        pi: { model: "user/pi-review-model", skills: ["builtin:reviewer"], tools: ["read", "bash", "j01n"] },
        claude: { model: "user-claude-review-model", skills: ["builtin:reviewer"], tools: ["Read", "Bash"] },
      },
      planner: { pi: { model: "user/pi-plan-model", skills: ["builtin:planner"], tools: ["read", "bash", "j01n"] } },
    },
    ...overrides,
  }, null, 2));
  return path;
}
