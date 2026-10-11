// Message kinds: a finding to all and a question to one agent, read back with their kind.
// Usage: node scripts/e2e/kinds.mjs <base> [helper]
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = process.argv[2];
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const env = { ...process.env, BASE_URL: base };
const run = (cwd, args) => JSON.parse(execFileSync("node", [helper, ...args], { cwd, env, encoding: "utf8" }));
const [a, b] = [mkdtempSync(join(tmpdir(), "kinds-")), mkdtempSync(join(tmpdir(), "kinds-"))];
const room = run(a, ["create", base, JSON.stringify({ host_id: "ines" })]);
run(a, ["join", room.invite_link, "ines", "--no-workspace"]);
run(b, ["join", room.invite_link, "kofi", "--no-workspace"]);
run(b, ["read"]);
run(a, ["send", "all", "the", "build", "needs", "bun", "--kind", "finding"]);
run(a, ["send", "kofi", "can", "you", "review?", "--kind", "question"]);
const got = run(b, ["read"]).filter((m) => m.from === "ines");
const finding = got.find((m) => m.kind === "finding"), question = got.find((m) => m.kind === "question");
const ok = !!(finding && question && question.expects_reply);
console.log(ok ? "KINDS FLOW OK" : "KINDS FLOW FAILED " + JSON.stringify(got.map((m) => [m.kind, !!m.expects_reply])));
if (!ok) process.exitCode = 1;
