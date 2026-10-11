// Sprint from a Markdown spec: `create {"spec": ...}` seeds the tasks, and a peer reads the spec from the room.
// Usage: node scripts/e2e/spec.mjs <base> [helper]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = process.argv[2];
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const env = { ...process.env, BASE_URL: base };
const run = (cwd, args) => JSON.parse(execFileSync("node", [helper, ...args], { cwd, env, encoding: "utf8" }));
const [host, peer] = [mkdtempSync(join(tmpdir(), "spec-host-")), mkdtempSync(join(tmpdir(), "spec-peer-"))];
const spec = "# Demo sprint\n\nGoal: check spec rooms.\n\n## Tasks\n- T1 API\n  files: src/api.ts\n- T2 UI\n  files: src/ui.ts\n  depends: T1\n";
try {
  writeFileSync(join(host, "spec.md"), spec);
  const room = run(host, ["create", base, JSON.stringify({ host_id: "host", spec: "spec.md" })]);
  const joined = run(peer, ["join", room.invite_link, "peer", "--no-workspace"]);
  const tasks = run(peer, ["tasks"]).tasks ?? [];
  const ok = joined.spec === spec && tasks.length === 2 && tasks.find((t) => t.id === "T2")?.depends_on?.includes("T1");
  console.log(ok ? "SPEC FLOW OK" : "SPEC FLOW FAILED " + JSON.stringify({ spec: joined.spec?.slice(0, 40), tasks: tasks.map((t) => [t.id, t.depends_on]) }));
  if (!ok) process.exitCode = 1;
} finally { for (const dir of [host, peer]) rmSync(dir, { recursive: true, force: true }); }
