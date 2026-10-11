#!/usr/bin/env node
// Operator-driven sprint automation. Never print room credentials or accept a dirty integration checkout.
import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "packages/helper/client/j01n.js");
const [action, ...args] = process.argv.slice(2);
const dry = args.includes("--dry-run");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function fail(message) { throw new Error(message); }
function run(command, argv, cwd = process.cwd(), silent = false) {
  console.log(`$ ${command} ${argv.join(" ")}`);
  try { return execFileSync(command, argv, { cwd, encoding: "utf8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) {
    if (!silent) console.error(error.stderr?.toString().trim() || error.message);
    fail(`${command} failed; stopped (inspect the checkout before retrying)`);
  }
}
function git(...argv) { return run("git", argv); }
function assertClean(cwd = process.cwd()) {
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], cwd)) fail(`dirty checkout: ${cwd}; save all work before continuing`);
}
function internal(path) {
  if (!isAbsolute(path)) fail("path must be absolute on internal storage");
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, path));
  if (physical === "/Volumes" || physical.startsWith("/Volumes/")) fail("sprint host cannot live on /Volumes");
  return physical;
}
function copyMissing(source, target, worktree) {
  const child = relative(worktree, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) fail("spec/dev destination escapes host worktree");
  for (let path = dirname(target); path !== dirname(worktree); path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(`refusing destination symlink: ${path}`);
  }
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) fail(`refusing to copy symlink: ${source}`);
  if (stat.isDirectory()) {
    if (existsSync(target) && !lstatSync(target).isDirectory()) fail(`destination is not a directory: ${target}`);
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyMissing(join(source, name), join(target, name), worktree);
  } else if (stat.isFile()) {
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || !readFileSync(source).equals(readFileSync(target))) fail(`spec/dev collision: ${target}; inspect before continuing`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  } else fail(`unsupported spec/dev entry: ${source}`);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${name} needs a value`);
  return args[index + 1];
}
function room(command) {
  // Capture, never echo, CLI output or errors: they can contain private room details.
  try { return JSON.parse(execFileSync(process.execPath, [helper, command], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })); }
  catch { fail(`room ${command} failed; check that exactly one host room is joined here`); }
}
function announce(text) {
  try { execFileSync(process.execPath, [helper, "send", "all", text, "--kind", "finding"], { cwd: process.cwd(), timeout: 30_000, stdio: "ignore" }); }
  catch { fail("room stage announcement failed; stop and inspect host session"); }
}
function peerContractPassed(evidence) {
  // Older sprint peers put the explicit result in --tests instead of --contract.
  const report = evidence?.contract ?? evidence?.tests ?? "";
  return /\bpnpm\s+check:contract\s+--peer\s+passed\b/i.test(report);
}
function summarize() {
  const summary = room("summary");
  const tasks = summary.tasks || [];
  console.log("Tasks:");
  for (const task of tasks) console.log(`  ${task.id}: ${task.status} (${task.owner || "unclaimed"})${task.blocked_by?.length ? ` blocked by ${task.blocked_by.join(", ")}` : ""}`);
  console.log("Participants:");
  for (const p of summary.participants || []) console.log(`  ${p.id}: ${p.role || "member"} ${p.state || ""}`);
  return summary;
}
function validName(name) { if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail("--name must be a Herdr-compatible agent name"); return name; }
function checkFlags(allowed, positional = 0) {
  const flags = args.filter((v) => v.startsWith("--"));
  if (flags.some((f) => !allowed.includes(f)) || args.length !== positional + flags.reduce((n, f) => n + (["--name", "--peers"].includes(f) ? 2 : 1), 0)) fail(`Invalid ${action} arguments; see docs/SPAWN-RUNBOOK.md`);
}
async function start() {
  checkFlags(["--name", "--peers", "--dry-run"], 1);
  const spec = resolve(args[0]);
  if (!existsSync(spec) || !statSync(spec).isFile()) fail("spec.md must exist and be a regular file");
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) fail("start requires a Herdr-managed pane");
  const repo = git("rev-parse", "--show-toplevel");
  if (repo !== process.cwd()) fail("start must run from the repository root");
  const repoName = basename(git("remote", "get-url", "origin").replace(/\.git$/, ""));
  const baseDir = internal(join(homedir(), "Development", "_MY"));
  const waves = readdirSync(baseDir).map((name) => name.match(new RegExp(`^${repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-w(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  const wave = `w${Math.max(0, ...waves) + 1}`;
  const branch = `${wave}/host`;
  const target = internal(join(baseDir, `${repoName}-${wave}`, "host"));
  if (existsSync(target) || git("branch", "--list", branch)) fail(`host target or branch already exists: ${branch}`);
  const name = validName(option("--name", "host").toLowerCase());
  const peers = Number(option("--peers", "3"));
  if (!Number.isInteger(peers) || peers < 1 || peers > 5) fail("--peers must be 1..5");
  const identity = internal(process.env.J01N_AGENT_DIR || join(homedir(), ".local/share/j01n/agents"));
  if (!existsSync(identity) || (statSync(identity).mode & 0o077)) fail("J01N_AGENT_DIR must be an existing private directory (0700)");
  const inbox = `host-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dev = join(repo, "dev");
  const specInDev = spec.startsWith(dev + sep);
  if (specInDev && !realpathSync(spec).startsWith(realpathSync(repo) + sep)) fail("spec inside dev/ resolves outside the repository");
  // A dry run uses the locally fetched gitlab/main ref; actual start refreshes it before copying.
  const devTrackedInSource = specInDev && !!git("ls-files", "--", "dev");
  const devTrackedInBase = specInDev && !!git("ls-tree", "-r", "--name-only", "gitlab/main", "--", "dev");
  const copyDev = specInDev && !devTrackedInSource && !devTrackedInBase;
  console.log(`Host ${branch} -> ${target}; spec ${spec}; ${peers} peer spawn(s)`);
  console.log(copyDev ? "Spec preflight: dev/ untracked in source and cached gitlab/main; copy only missing dev/ files (reject collisions)." : "Spec preflight: copy only the missing spec; tracked dev/ will not be overwritten.");
  if (dry) { console.log("Plan: fetch gitlab, create host worktree, copy missing spec/dev, install, split/label/start Pi, prompt host, wait for room and open owner invitation. No changes made."); return; }
  git("fetch", "gitlab");
  git("worktree", "add", "-b", branch, target, "gitlab/main");
  // Re-check the fetched base; never overwrite tracked content or copy a source symlink.
  const trackedInHost = specInDev && !!run("git", ["ls-files", "--", "dev"], target);
  if (specInDev && !devTrackedInSource && !trackedInHost) copyMissing(dev, join(target, "dev"), target);
  else copyMissing(spec, specInDev ? join(target, relative(repo, spec)) : join(target, basename(spec)), target);
  const manifest = join(target, "pnpm-workspace.yaml");
  const before = existsSync(manifest) ? readFileSync(manifest) : null;
  try { run("pnpm", ["install", "--frozen-lockfile"], target); }
  catch { fail(`host checkout remains at ${target}; inspect before retrying`); }
  finally { if (before && (!existsSync(manifest) || !readFileSync(manifest).equals(before))) writeFileSync(manifest, before); }
  const env = [`J01N_AGENT_DIR=${identity}`, `J01N_PEER_SPAWNS=${peers}`, `BASE_URL=${process.env.BASE_URL || "https://j01n.me"}`, `J01N_HOST_INBOX=${inbox}`];
  const pane = JSON.parse(run("herdr", ["pane", "split", "--current", "--direction", "down", "--cwd", target, ...env.flatMap((v) => ["--env", v]), "--no-focus"])).result?.pane?.pane_id;
  if (!pane) fail("Herdr did not return a host pane; inspect the checkout before retrying");
  run("herdr", ["pane", "rename", pane, name]);
  run("herdr", ["agent", "start", name, "--kind", "pi", "--pane", pane]);
  const copied = spec.startsWith(dev + sep) ? relative(repo, spec) : basename(spec);
  run("herdr", ["agent", "prompt", pane, `Host this sprint from ${copied}. Create the sprint with {"spec":${JSON.stringify(copied)}}; confirm the owner joins, invite repo agents, spawn one peer per task, coordinate review. Follow docs/SPAWN-RUNBOOK.md. Never paste room credentials into Herdr.`]);
  const roomDir = join(target, ".j01n-rooms");
  let joined = false;
  for (let i = 0; i < 180; i++) {
    if (existsSync(roomDir) && readdirSync(roomDir).some((v) => /^[a-f0-9]{64}\.json$/.test(v))) { joined = true; break; }
    await pause(1000);
  }
  if (!joined) fail("host room not joined within 3 minutes; host pane remains running. Open owner invite from host once joined");
  // A host room may be created before its key file is saved; retry without emitting private CLI output.
  for (let i = 0; i < 10; i++) {
    try {
      execFileSync(process.execPath, [join(target, "packages/helper/client/j01n.js"), "invite-link", "--open"], { cwd: target, timeout: 15_000, stdio: "ignore" });
      console.log("Owner invitation opened in browser (confirm the owner joined in sprint status).");
      return;
    } catch { await pause(1000); }
  }
  fail("owner invitation could not be opened; host must run invite-link --open before proceeding");
}
function remotes() {
  for (const remote of ["gitlab", "origin"]) git("fetch", remote);
  for (const remote of ["gitlab", "origin"]) {
    // A remote update not contained in HEAD means a parallel actor has changed main.
    try { execFileSync("git", ["merge-base", "--is-ancestor", `${remote}/main`, "HEAD"], { stdio: "ignore" }); }
    catch { fail(`${remote}/main moved outside the integration history; reconcile before proceeding`); }
  }
}
function appendLessons(summary) {
  const entries = [...(summary.notes || []).map((n) => `- ${n.by}: ${n.text}`), ...(summary.decisions || []).map((d) => `- Decision (${d.by}): ${d.decision} — ${d.why}`)];
  if (!entries.length) return;
  const path = join(process.cwd(), "dev/lessons.md");
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "# Sprint lessons\n";
  writeFileSync(path, `${existing.trimEnd()}\n\n## Sprint ${git("branch", "--show-current")}\n${entries.join("\n")}\n`);
  git("add", "--", "dev/lessons.md");
  git("commit", "-m", "Record sprint notes and decisions");
}
async function localE2E() {
  const server = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "apps/web/wrangler.jsonc", "--port", "8787"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let logs = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { logs = (logs + data.toString()).slice(-4000); });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (server.exitCode !== null) fail("wrangler dev exited before readiness");
      if (/ready on|localhost:8787|127\.0\.0\.1:8787/i.test(logs)) { ready = true; break; }
      await pause(1000);
    }
    if (!ready) fail("wrangler dev did not become ready within 60 seconds");
    run(process.execPath, ["scripts/e2e.mjs", "http://127.0.0.1:8787"]);
  } finally { if (server.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already exited */ } } }
}
async function finish() {
  checkFlags(["--dry-run", "--reviewed", "--owner-read"]);
  if (!dry && (!args.includes("--reviewed") || !args.includes("--owner-read"))) fail("finish needs --reviewed --owner-read: host reviewed diffs/evidence and owner has read the report");
  const cwd = git("rev-parse", "--show-toplevel");
  if (cwd !== process.cwd() || !/^w\d+\/host$/.test(git("branch", "--show-current"))) fail("finish must run at a sprint host worktree root");
  assertClean();
  const summary = summarize();
  const tasks = summary.tasks || [];
  if (!tasks.length || tasks.some((task) => task.status !== "done" || !task.owner || !task.evidence?.commits?.length || !task.evidence?.tests || !peerContractPassed(task.evidence))) fail("all tasks need done evidence (commits, tests and explicit passed peer contract)");
  if (!summary.report) fail("post the host review report before finish");
  if (summary.reservations?.length) fail("release or reconcile outstanding reservations before finish");
  if (!(summary.participants || []).some((p) => p.role === "owner")) fail("owner must join before finish");
  const byId = new Map((summary.participants || []).map((p) => [p.id, p]));
  const branches = [];
  for (const task of tasks) {
    const branch = byId.get(task.owner)?.workspace?.branch;
    if (!branch || branch === git("branch", "--show-current") || !/^w\d+\/t\d+$/.test(branch) || branches.includes(branch)) fail(`task ${task.id}: unique peer branch unavailable`);
    const expected = task.evidence.commits.at(-1);
    if (!/^[0-9a-f]{7,40}$/.test(expected)) fail(`task ${task.id}: invalid commit evidence`);
    const actual = git("rev-parse", branch);
    if (git("rev-parse", expected) !== actual) fail(`task ${task.id}: branch HEAD changed since done evidence; stop and re-review`);
    branches.push(branch);
  }
  console.log(`Verified ${branches.length} reported branch heads. Plan: fetch/reconcile, no-ff merges, regenerate, clean full contract, local E2E, deploy/live E2E, push both remotes, pi update, close room and safe cleanup.`);
  if (dry) return;
  announce("Sprint integration: fetching gitlab and origin before merging.");
  remotes();
  const conflicts = room("conflicts");
  if (conflicts.conflicts?.length) fail("peer branch merge conflicts reported; resolve/review before finishing");
  announce("Sprint integration: merging the reviewed task branches.");
  for (const branch of branches) { assertClean(); git("merge", "--no-ff", "--no-edit", branch); }
  run(process.execPath, ["scripts/generate-client-script.mjs"]);
  run(process.execPath, ["scripts/generate-assets.mjs"]);
  git("add", "--", "packages/helper/client/j01n.js", "packages/helper/src/client-script.ts", "apps/web/src/markdown-assets.ts", "packages/skill/src/skill.ts");
  if (git("diff", "--cached", "--name-only")) git("commit", "-m", "Regenerate sprint integration outputs");
  appendLessons(summary);
  assertClean();
  run("pnpm", ["check:contract"]);
  run("pnpm", ["check:generated"]);
  await localE2E();
  assertClean();
  announce("Sprint integration: fetching remotes before deployment.");
  remotes();
  const deployed = git("rev-parse", "HEAD");
  announce("Sprint integration: deploying the verified clean snapshot.");
  run("pnpm", ["deploy"]);
  run(process.execPath, ["scripts/e2e.mjs", "https://j01n.me"]);
  announce("Sprint integration: fetching and reconciling both remotes before pushing.");
  remotes();
  assertClean();
  announce("Sprint integration: pushing the deployed commit to gitlab and origin.");
  for (const remote of ["gitlab", "origin"]) git("push", remote, `HEAD:main`);
  for (const remote of ["gitlab", "origin"]) if (git("ls-remote", remote, "refs/heads/main").split(/\s+/)[0] !== deployed) fail(`${remote} does not point to deployed commit; stop cleanup`);
  run("pi", ["update"]);
  // Read only the local host key file; never print its URL, token or join secret.
  const rooms = readdirSync(".j01n-rooms").filter((f) => /^[a-f0-9]{64}\.json$/.test(f));
  if (rooms.length !== 1) fail("expected exactly one host room; close it manually after verifying ownership");
  const { room_url, participant_id } = JSON.parse(readFileSync(join(".j01n-rooms", rooms[0]), "utf8"));
  const safe = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const keyDir = process.env.J01N_KEY_DIR || process.cwd();
  const session = JSON.parse(readFileSync(join(keyDir, `.j01n-${safe(new URL(room_url).pathname)}-${safe(participant_id)}.json`), "utf8"));
  if (!session.participantToken) fail("no host participant token in local key file; close manually");
  announce("Sprint integration: deployment verified and both remotes updated; closing the room.");
  const response = await fetch(room_url, { method: "DELETE", headers: { authorization: `Bearer ${session.participantToken}` } });
  if (!response.ok) fail("room close failed; stop cleanup and inspect host session");
  console.log("Room closed. Inspecting worktrees for safe cleanup.");
  const listed = git("worktree", "list", "--porcelain");
  const agents = JSON.parse(run("herdr", ["agent", "list"])).result?.agents || [];
  for (const branch of branches) {
    const entry = listed.split(/\n\n+/).find((block) => block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`));
    const path = entry?.match(/^worktree (.+)$/m)?.[1];
    if (!path || !isAbsolute(path) || !existsSync(path) || run("git", ["status", "--porcelain"], path)) { console.log(`Skipping dirty/missing worktree ${branch}`); continue; }
    try { execFileSync("git", ["merge-base", "--is-ancestor", branch, "HEAD"], { stdio: "ignore" }); }
    catch { console.log(`Skipping unmerged branch ${branch}`); continue; }
    const owner = tasks.find((task) => byId.get(task.owner)?.workspace?.branch === branch)?.owner;
    const declared = byId.get(owner)?.workspace?.path;
    const occupants = agents.filter((agent) => agent.cwd === path);
    if (!declared || resolve(declared) !== resolve(path) || occupants.length !== 1 || occupants[0].agent !== "pi" ||
        ![owner, `${owner}-`].some((prefix) => occupants[0].name === prefix || occupants[0].name?.startsWith(prefix)) ||
        !["idle", "done"].includes(occupants[0].agent_status)) { console.log(`Skipping unconfirmed/active peer pane/worktree ${branch}`); continue; }
    run("herdr", ["pane", "close", occupants[0].pane_id]);
    if (run("git", ["status", "--porcelain"], path)) { console.log(`Skipping worktree changed after pane close ${branch}`); continue; }
    git("worktree", "remove", path);
    git("branch", "-d", branch);
  }
  console.log("Host worktree/pane retained: close only after verifying no uncommitted or unpushed work.");
}
try {
  if (action === "start") await start();
  else if (action === "status") { checkFlags([]); summarize(); }
  else if (action === "finish") await finish();
  else fail("Usage: node scripts/sprint.mjs start <spec.md> [--name <Host>] [--peers N] [--dry-run] | status | finish [--reviewed --owner-read] [--dry-run]");
} catch (error) { console.error(error.message); process.exitCode = 1; }
