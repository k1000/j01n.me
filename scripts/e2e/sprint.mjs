// Sprint flow with the CLI helper: T2 depends on T1; B's claim waits; A's done wakes B.
// Usage: node scripts/e2e/sprint.mjs <base> [helper]
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = process.argv[2];
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const env = { ...process.env, BASE_URL: base };
const dir = () => { const d = mkdtempSync(join(tmpdir(), "sprint-")); execFileSync("git", ["init", "-q"], { cwd: d }); execFileSync("git", ["remote", "add", "origin", "https://example.com/acme/sprint.git"], { cwd: d }); return d; };
const run = (cwd, args) => JSON.parse(execFileSync("node", [helper, ...args], { cwd, env, encoding: "utf8" }));
const fails = (cwd, args) => { try { run(cwd, args); return ""; } catch (e) { return String(e.stderr || e.message); } };
const results = []; const check = (label, ok, detail = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " (" + detail + ")" : ""}`); };
const [h, a, b] = [dir(), dir(), dir()];
const room = run(h, ["create", base, JSON.stringify({ host_id: "host", template: "sprint", tasks: [
  { id: "T1", title: "API", files: ["src/api.ts"], depends_on: [] },
  { id: "T2", title: "UI", files: ["src/ui.ts"], depends_on: ["T1"] },
] })]);
run(h, ["join", room.invite_link, "host", "--no-workspace"]);
run(a, ["join", room.invite_link, "agent-a", "--no-workspace"]);
run(b, ["join", room.invite_link, "agent-b", "--no-workspace"]);
const listed = run(a, ["tasks"]).tasks ?? [];
check("sprint template seeds task.T1 and task.T2 (open)", listed.length === 2 && listed.every((t) => t.status === "open"), JSON.stringify(listed.map((t) => [t.id, t.status])));
run(a, ["claim", "T1"]);
check("a second claim on T1 is refused, naming the owner", fails(b, ["claim", "T1"]).includes("agent-a"));
check("claim in a separate checkout reserves nothing (reservations only within a shared checkout)", (run(b, ["reservations"]).reservations ?? []).length === 0);
check("claiming T2 before T1 is done is refused", /T1/.test(fails(b, ["claim", "T2"])));
run(b, ["read"]);
const waiting = new Promise((done) => { const c = spawn("node", [helper, "wait", "30"], { cwd: b, env }); let out = ""; c.stdout.on("data", (d) => out += d); c.on("close", () => done(out)); });
await new Promise((r) => setTimeout(r, 1500));
run(a, ["done", "T1", "--summary", "API ready", "--commit", "abc123", "--tests", "unit ok"]);
const woke = JSON.parse(await waiting);
check("done T1 wakes B with an unblock notice", JSON.stringify(woke).includes("T2"), JSON.stringify(woke.messages?.map((m) => m.body?.text)).slice(0, 160));
check("done releases T1's reservations", !(run(b, ["reservations"]).reservations ?? []).some((r) => r.by === "agent-a"));
const t2 = run(b, ["claim", "T2"]);
check("B can claim T2 now", JSON.stringify(t2).includes("agent-b"));
const t1 = (run(h, ["tasks"]).tasks ?? []).find((t) => t.id === "T1");
check("T1 carries summary and evidence", t1?.status === "done" && t1?.summary === "API ready" && t1?.evidence?.commits?.includes("abc123"));
console.log(results.every(Boolean) ? "SPRINT FLOW OK" : "SPRINT FLOW FAILED");
if (!results.every(Boolean)) process.exitCode = 1;
