#!/usr/bin/env node
// Smoke test of the CLI helper (packages/helper/client/j01n.js) against a real room.
// Unit tests never execute the helper script, so run this after changing it (dev/lessons.md).
//
//   node scripts/smoke-helper.mjs [base_url] [helper_path]
//   defaults: https://j01n.me and the local packages/helper/client/j01n.js
//
// Creates a short-lived room, joins two agents in separate directories, and checks: join output (kickoff, questions),
// commands without room arguments (active room), plain-text send, wait waking on a message, send --wait, the open
// question flow (--expect-reply / --reply-to), and that the active-room entry holds no secrets. Closes the room.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] ?? "https://j01n.me").replace(/\/$/, "");
const helper = resolve(process.argv[3] ?? fileURLToPath(new URL("../packages/helper/client/j01n.js", import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "j01n-smoke-"));
const env = { ...process.env, BASE_URL: base };
let failures = 0;

function run(dir, args) {
  return JSON.parse(execFileSync("node", [helper, ...args], { cwd: dir, env, encoding: "utf8" }));
}
function runAsync(dir, args) {
  return new Promise((done, fail) => {
    const child = spawn("node", [helper, ...args], { cwd: dir, env });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`exit ${code}`))));
  });
}
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

const room = JSON.parse(execFileSync("node", [helper, "create", base, JSON.stringify({ host_id: "smoke-a", room_name: "helper-smoke", invite_ttl_ms: 300000 })], { cwd: root, env, encoding: "utf8" }));
const a = mkdtempSync(join(root, "a-"));
const b = mkdtempSync(join(root, "b-"));
try {
  const joinA = run(a, ["join", room.invite_link, "smoke-a"]);
  check("join prints kickoff and questions fields", "kickoff" in joinA && Array.isArray(joinA.questions));
  run(b, ["join", room.invite_link, "smoke-b"]);
  const entry = readdirSync(join(a, ".j01n-rooms"))[0];
  check("active-room entry holds no secrets", !/token|secret/i.test(readFileSync(join(a, ".j01n-rooms", entry), "utf8")));

  run(a, ["read"]);
  const waiting = runAsync(a, ["wait", "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  run(b, ["send", "smoke-a", "hello", "from", "b"]);
  const woke = await waiting;
  check("wait wakes on a plain-text message", woke.woke === "message" && woke.messages.some((m) => m.body?.text === "hello from b"));

  const asking = runAsync(b, ["send", "smoke-a", "can", "you", "answer?", "--expect-reply", "--wait"]);
  await new Promise((r) => setTimeout(r, 1500));
  const rejoin = run(a, ["join", room.invite_link, "smoke-a"]);
  const question = rejoin.questions?.[0];
  check("re-join returns the open question with its id", question?.body?.text === "can you answer?", question?.id);
  run(a, ["send", "smoke-b", "yes", "--reply-to", question?.id ?? "none"]);
  const answered = await asking;
  check("send --wait returns the reply", answered.messages?.some((m) => m.body?.text === "yes" && m.reply_to === question?.id));
} catch (error) {
  failures++;
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
} finally {
  const token = JSON.parse(readFileSync(join(a, readdirSync(a).find((n) => n.endsWith("-smoke-a.json"))), "utf8")).participantToken;
  const closed = await fetch(room.access, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  check("room closed", closed === 200, `HTTP ${closed}`);
}
process.exit(failures ? 1 : 0);
