#!/usr/bin/env node
// Smoke test of the CLI helper (packages/helper/client/j01n.js) against a real room.
// Unit tests never execute the helper script, so run this after changing it (dev/lessons.md).
//
//   node scripts/smoke-helper.mjs [base_url] [helper_path]
//   defaults: https://j01n.me and the local packages/helper/client/j01n.js
//
// Creates a short-lived room, joins two agents in separate directories, and checks: join output (kickoff, questions),
// commands without room arguments (active room), plain-text send, wait waking on a message, send --wait, the open
// question flow (--expect-reply / --reply-to), wait filters (--from), host handover, team capabilities/workspace,
// file reservations (reserve / release / leave guard), inviting an agent by name (register / invite /
// listen), and that the active-room entry holds no secrets. Closes the room.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// A command that must fail: returns its error output.
function fails(dir, args) {
  try { run(dir, args); return ""; } catch (error) { return String(error.stderr || error.message); }
}
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

const room = JSON.parse(execFileSync("node", [helper, "create", base, JSON.stringify({ host_id: "smoke-a", room_name: "helper-smoke", invite_ttl_ms: 300000 })], { cwd: root, env, encoding: "utf8" }));
const a = mkdtempSync(join(root, "a-"));
const b = mkdtempSync(join(root, "b-"));
// Two clones of the same repo (same remote), so file reservations apply across them.
for (const dir of [a, b]) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://example.com/acme/smoke.git"], { cwd: dir });
}
try {
  const joinA = run(a, ["join", room.invite_link, "smoke-a"]);
  check("join prints kickoff and questions fields", "kickoff" in joinA && Array.isArray(joinA.questions));
  const joinB = run(b, ["join", room.invite_link, "smoke-b", "--capabilities", "code,shell", "--model", "claude-sonnet-4-5", "--provider", "anthropic"]);
  const teamA = joinB.team?.find((p) => p.id === "smoke-a");
  check("join shows the team: capabilities and others' opened (sealed) workspaces", teamA?.workspace?.path?.endsWith(a.split("/").pop()) && joinB.team.find((p) => p.id === "smoke-b")?.capabilities?.join() === "code,shell");
  const teamList = run(b, ["team"]).team ?? [];
  const [teamA2, teamB2] = ["smoke-a", "smoke-b"].map((id) => teamList.find((p) => p.id === id));
  check("team prints participants, state, status, capabilities, workspace and last activity as JSON", teamA2?.state === "free" && typeof teamB2?.status === "string" && teamB2?.capabilities?.join() === "code,shell" && teamA2?.workspace?.path?.endsWith(a.split("/").pop()) && !!teamA2?.last_seen_at);
  check("team shows the announced model and provider", teamB2?.model === "claude-sonnet-4-5" && teamB2?.provider === "anthropic");
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

  run(a, ["read"]);
  const filtered = runAsync(a, ["wait", "3", "--from", "nobody"]);
  await new Promise((r) => setTimeout(r, 1000));
  run(b, ["send", "smoke-a", "filtered", "out"]);
  check("wait --from ignores other senders", (await filtered).timeout === true);
  check("wait --from returns their unread message", run(a, ["wait", "5", "--from", "smoke-b"]).messages?.some((m) => m.body?.text === "filtered out"));

  const changed = run(a, ["profile", "--capabilities", "code,browser"]);
  check("profile changes capabilities during the session", changed.team?.find((p) => p.id === "smoke-a")?.capabilities?.join() === "code,browser");
  check("the change is announced in the chat for everyone", run(b, ["read"]).some((m) => m.intent === "profile.changed" && m.body?.text === "smoke-a can now: code, browser"));
  check("host hands the role to another participant", run(a, ["host", "smoke-b"]).host_id === "smoke-b");
  check("the new host can hand it back", run(b, ["host", "smoke-a"]).host_id === "smoke-a");

  // Agent names are global and permanent, so each run registers fresh ones.
  const suffix = Math.random().toString(36).slice(2, 8);
  const [host, guest] = [`smoke-host-${suffix}`, `smoke-guest-${suffix}`];
  run(b, ["register", host]);
  run(a, ["register", guest, host]);
  const listening = runAsync(a, ["listen", guest, "20"]);
  await new Promise((r) => setTimeout(r, 1500));
  run(b, ["invite", host, guest, room.invite_link]);
  const joinedByName = await listening;
  check("listen joins the room an allowed agent invited it to", joinedByName.invited_by === host && joinedByName.participant_id === guest && "board" in joinedByName);

  // Directory a now also holds the guest's room entry, so name the room and participant explicitly there.
  const asA = (...args) => [args[0], room.invite_link, "smoke-a", ...args.slice(1)];
  // Reservations apply only between participants sharing a checkout (same machine + worktree). Directory a is shared
  // by smoke-a and the guest that joined there via listen; b is alone in its own checkout.
  const asGuest = (...args) => [args[0], room.invite_link, guest, ...args.slice(1)];
  run(a, asA("reserve", "src/auth", "--reason", "smoke", "refactor"));
  check("in a shared checkout, reserving a path someone else holds fails, naming the holder", fails(a, asGuest("reserve", "src/auth/login.ts")).includes("already reserved by smoke-a (smoke refactor)"));
  check("reservations are announced in the chat", run(b, ["read"]).some((m) => m.body?.text === "smoke-a reserved files (1)"));
  writeFileSync(join(b, "README.md"), "existing file\n");
  const alone = run(b, ["reserve", "README.md"]);
  check("alone in a checkout, reserve needs no reservation (an existing file is a path, not an invitation)", alone.ok === true && alone.reservations.length === 0 && /no reservation needed/.test(alone.message ?? ""));
  run(a, asGuest("reserve", "docs/"));
  check("leaving while holding reservations is refused", fails(a, asGuest("leave")).includes("release them first"));
  check("leave --release releases them and leaves", run(a, asGuest("leave", "--release")).left === true && run(a, asA("reservations")).reservations.every((r) => r.by === "smoke-a"));
  run(a, asA("release"));
  check("release frees your reservations", run(a, asA("reservations")).reservations.length === 0);
} catch (error) {
  failures++;
  console.log(`FAIL ${error instanceof Error ? error.message : error}`);
} finally {
  const token = JSON.parse(readFileSync(join(a, readdirSync(a).find((n) => n.endsWith("-smoke-a.json"))), "utf8")).participantToken;
  const closed = await fetch(room.access, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  check("room closed", closed === 200, `HTTP ${closed}`);
}
process.exit(failures ? 1 : 0);
