#!/usr/bin/env node
// Host-side sprint orchestrator: start | status | answer | finish.
// It owns the canonical host flow so a host never improvises room setup: doctor the toolchain and the directory
// (git, Herdr socket, free worker names, private keys dir, internal worktree root), prune stale room pointers, create
// and join the room as the host, seed worker identities into their own worktrees, give each worker a Herdr workspace
// plus pane and an explicit task prompt carrying its board brief, optionally route role-tagged tasks to the free panes
// that announce that role (--roster), hand the raw invite link to the owner as a file
// body, top the room invite up from status while the board still holds work, then rebase the reviewed task branches in dependency
// order onto main and open a merge request. With --ui-tester the room also gets one non-git participant: an inbox
// identity, a private room profile in the keys dir and one Herdr pane polling the room in the ui-tester role.
// Rules: never print a room credential, never integrate a dirty checkout, persist every step in sprint.json so an
// interrupted start or finish resumes instead of repeating side effects (no duplicate rooms, panes or invites).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [action, ...args] = process.argv.slice(2);
const dry = args.includes("--dry-run");
const PARTICIPANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
// git 2.25 is the floor for this flow (`worktree add -b`, `:(exclude)` pathspecs). The script never uses `git init -b`.
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 25;
// The 11.10 sprint board died silently: the invite TTL caps at 1h and nobody extended it. A host run of status is the
// documented duty loop, so every tick of it tops the invite up for as long as the board holds live work - the clock
// alone says nothing about whether somebody is still working. An invite below this window is always topped, whatever
// the tick says, so a loop that was interrupted cannot leave the room to expire mid-work.
const KEEPALIVE_TICK_MS = 10 * 60_000;
const KEEPALIVE_EXTEND_MINUTES = 60;
// The room hears about the keepalive once an hour, not once a tick: workers need to know the room is alive, not read
// the same line every 10 minutes. Both stamps live in sprint.json, so a crashed loop resumes without a second notice.
const KEEPALIVE_NOTICE_MS = 60 * 60_000;
// A prompt carries the board brief inline; the board key is named too so a worker can re-read the full text.
const MAX_PROMPT_BRIEF = 900;
// Generated outputs belong to integration, never to a task's files[].
const GENERATED = ["packages/helper/client/j01n.js", "packages/helper/src/client-script.ts", "apps/web/src/markdown-assets.ts", "packages/skill/src/skill.ts"];
// Owner delivery target for the raw invite file; J01N_INVITE_TO or --invite-to overrides, "none" skips sending.
const DEFAULT_INVITE_TO = process.env.J01N_INVITE_TO || "telegram:5199310384";
// The ui-tester role: a python participant that watches the room for UI-verifying handoffs and posts the verdict. It is
// not a git peer, so it gets an inbox identity, a room profile in the keys dir and one Herdr pane running the tester.
// Only the profile *path* crosses into the pane, so no room credential is ever a pane argument; the pane reads its keys
// from J01N_KEY_DIR. J01N_UI_TESTER_{SCRIPT,CWD,INTERVAL} move the host install for a check run against fakes.
const UI_TESTER_ROLE = "ui-tester";
const UI_TESTER_SCRIPT = "/home/ubuntu/.hermes/scripts/j01n_ui_tester.py";
const UI_TESTER_CWD = "/home/ubuntu/.hermes/j01n";
const UI_TESTER_INTERVAL = 20;
const VALUED_FLAGS = ["--spec", "--name", "--workers", "--host", "--worker-prefix", "--from", "--remote", "--invite-to", "--capabilities", "--server", "--state", "--helper", "--title", "--kind", "--ui-tester-name", "--roster"];
// Roster modes say who puts a task in front of a pane. `auto`: after the panes are up the host assigns every open,
// unblocked task carrying a `role:` to a joined free pane announcing that role (an offer - the worker still claims).
// `manual`: today's flow, workers claim off the board themselves. `off`: no routing, no routing log, no routed column.
// Without the flag the default is auto as soon as the room has a role-tagged worker matching an open task's role,
// and manual while it does not, so an existing sprint keeps behaving exactly as it did.
const ROSTER_MODES = ["auto", "manual", "off"];
const secrets = new Set();
function fail(message, detail) { const error = new Error(message); if (detail) error.detail = detail; throw error; }
/** Remember a value so it can be scrubbed even when another program echoes it back in an error. */
function track(value) { if (typeof value === "string" && value.length > 8) secrets.add(value); return value; }
function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`${name} needs a value`);
  return args[index + 1];
}
function positional() {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (VALUED_FLAGS.includes(args[i])) i++; continue; }
    out.push(args[i]);
  }
  return out;
}
function checkFlags(allowed, minPositional = 0) {
  const flags = args.filter((value) => value.startsWith("--"));
  if (flags.some((flag) => !allowed.includes(flag))) fail(`unknown argument for ${action}: ${flags.filter((f) => !allowed.includes(f)).join(" ")}; see docs/SPAWN-RUNBOOK.md`);
  for (const flag of new Set(flags)) if (VALUED_FLAGS.includes(flag)) option(flag, undefined);
  if (positional().length < minPositional) fail(`${action} needs ${minPositional} argument(s); see docs/SPAWN-RUNBOOK.md`);
}
/** Run a command, capture stdout, and stop on the first failure with redacted, truncated stderr. */
function exec(command, argv, options = {}) {
  const { cwd = process.cwd(), label, redactArgs = [], quiet = false, timeout = 900_000, echoError = true } = options;
  const shown = label ?? `${command} ${argv.map((value, index) => (redactArgs.includes(index) || secrets.has(value) ? "<redacted>" : value)).join(" ")}`;
  if (!quiet) console.log(`$ ${shown}`);
  try {
    return execFileSync(command, argv, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env }).trim();
  } catch (error) {
    const detail = redact(error.stderr?.toString().trim() || error.message);
    if (echoError) console.error(detail.split("\n").slice(-12).join("\n"));
    fail(`${shown} failed; stopped (inspect the state before retrying)`, detail);
  }
}
function json(command, argv, options = {}) {
  try { return JSON.parse(exec(command, argv, options)); }
  catch (error) { if (error instanceof SyntaxError) fail(`${options.label ?? command} returned no JSON`, error.message); throw error; }
}
/** A doctor probe: an answer instead of an exception, and never a side effect. */
function probe(command, argv, options = {}) {
  try {
    return { ok: true, out: execFileSync(command, argv, { cwd: options.cwd ?? process.cwd(), encoding: "utf8", timeout: options.timeout ?? 60_000, stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env }).trim() };
  } catch (error) {
    // One line of the real complaint, without the Node crash banner a broken wrapper prints around it.
    const lines = redact(String(error?.stderr || error?.message || "")).split("\n").map((line) => line.trim())
      .filter((line) => line && !/^Node\.js v/.test(line) && !/^at /.test(line) && !/^[~^]+$/.test(line));
    return { ok: false, out: "", detail: (lines.at(-1) ?? "").slice(0, 160) };
  }
}
const git = (...argv) => exec("git", argv);
const gitAt = (cwd, ...argv) => exec("git", argv, { cwd });
/** A ref lookup that must not stop the run: "" means missing. */
function gitSoft(cwd, ...argv) {
  try { return execFileSync("git", argv, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}
const slug = (roomId) => String(roomId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "room";
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
const nowIso = () => new Date().toISOString();
function internal(path) {
  if (!isAbsolute(path)) fail("worktree root must be an absolute path on internal storage");
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, path));
  if (physical === "/Volumes" || physical.startsWith("/Volumes/")) fail("sprint worktrees cannot live on /Volumes");
  return physical;
}

// ── sprint.json state ──────────────────────────────────────────────────────────────────────────

const keysDir = () => resolve(process.env.J01N_KEY_DIR || process.cwd());
const serverBase = () => (option("--server", process.env.BASE_URL || "https://j01n.me")).replace(/\/$/, "");
const stateFile = (state = null) => resolve(state?.state_file ?? option("--state", join(keysDir(), "sprint.json")));
function loadState() {
  const file = stateFile();
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { fail(`sprint state is unreadable: ${file}`); }
}
function saveState(state) {
  const file = stateFile(state);
  state.updated_at = nowIso();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  track(state.invite_link);
  return state;
}
function requireState() {
  const state = loadState();
  if (!state?.room_id) fail(`no sprint.json at ${stateFile()}; run start first`);
  track(state.invite_link);
  return state;
}
/** Every room call runs as the host, from the host checkout, against this sprint's own key directory. */
function helper(state, argv, options = {}) {
  return json(process.execPath, [resolve(option("--helper", state?.helper ?? join(root, "packages/helper/client/j01n.js"))), ...argv], {
    cwd: state?.host_checkout ?? process.cwd(),
    env: { ...process.env, J01N_KEY_DIR: state?.keys_dir ?? keysDir(), BASE_URL: state?.base ?? serverBase() },
    label: options.label ?? `j01n ${argv[0]}`,
    redactArgs: options.redactArgs ?? [],
    quiet: options.quiet ?? true,
    timeout: options.timeout ?? 60_000,
    echoError: options.echoError ?? true,
  });
}
/** Never let a reporting nicety fail an irreversible step. */
function soft(state, argv) { try { return helper(state, argv, { echoError: false }); } catch { return null; } }
function announce(state, text) { soft(state, ["send", "all", text, "--kind", "finding"]); }
/** 404 = room never existed, 410 = closed or expired. Anything else (403, network) keeps the pointer. */
async function roomAlive(roomUrl, token) {
  try {
    const response = await fetch(`${roomUrl}?view=all`, { headers: { authorization: `Bearer ${token || "stale-pointer-probe"}` } });
    return response.status !== 404 && response.status !== 410;
  } catch { return true; }
}
function pointerFiles(dir) {
  const active = join(dir, ".j01n-rooms");
  if (!existsSync(active)) return [];
  return readdirSync(active).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => join(active, name));
}
/** Sort the keys directory's pointers: unreadable or gone rooms are safe to drop, everything else owns the directory. */
async function scanPointers(dir) {
  const dead = [];
  const alive = [];
  for (const file of pointerFiles(dir)) {
    let pointer = null;
    try { pointer = JSON.parse(readFileSync(file, "utf8")); } catch { pointer = null; }
    if (typeof pointer?.room_url !== "string" || typeof pointer?.participant_id !== "string" || !/^https?:/.test(pointer.room_url)) { dead.push({ file, label: basename(file) }); continue; }
    const keyFile = join(dir, `.j01n-${safeName(new URL(pointer.room_url).pathname)}-${safeName(pointer.participant_id)}.json`);
    let token;
    try { token = JSON.parse(readFileSync(keyFile, "utf8")).participantToken; } catch { token = undefined; }
    // One stale pointer makes every later CLI call ambiguous, so it must go before the sprint starts.
    if (await roomAlive(pointer.room_url, token)) { alive.push(file); continue; }
    dead.push({ file, label: `${pointer.participant_id}@${slug(new URL(pointer.room_url).pathname.split("/").pop() ?? "")}` });
  }
  return { dead, alive };
}
/** The dev/ plan folder, the untracked worktree roots, sprint.json and the tester profile are working material, never input. */
function assertClean(cwd = process.cwd(), state = loadState()) {
  const excluded = ["dev"];
  const working = state ? [stateFile(state), state.worktree_root, ...(state.workers ?? []).map((worker) => worker.profile)] : [stateFile()];
  for (const path of working.filter(Boolean)) {
    const inside = relative(cwd, path);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) excluded.push(inside);
  }
  const pathspec = ["--", ".", ...excluded.map((path) => `:(exclude)${path}`)];
  if (exec("git", ["status", "--porcelain", "--untracked-files=all", ...pathspec], { cwd })) fail(`dirty checkout: ${cwd}; save all work before continuing`);
}

// ── preflight (doctor) ─────────────────────────────────────────────────────────────────────────

/** An old git breaks worktrees and pathspecs halfway through a start; the doctor wants to hear about it first. */
function gitProblem() {
  const answer = probe("git", ["--version"], { timeout: 30_000 });
  if (!answer.ok) return `"git --version" did not run${answer.detail ? `: ${answer.detail}` : ""}: install git ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} or newer and put it first on PATH`;
  const found = /(\d+)\.(\d+)/.exec(answer.out);
  if (!found) return `cannot read a git version out of "${answer.out.slice(0, 60)}": put a standard git binary first on PATH`;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
    return `git ${found[1]}.${found[2]} is older than ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}: point PATH at a newer git (the flow needs "worktree add -b", never "git init -b")`;
  }
  return null;
}
/** A relative or /Volumes worktree root produces worktrees nothing can boot from. */
function worktreeRootProblem(path) {
  try { internal(path); return null; }
  catch (error) { return `the worktree root ${path} is not usable (${error?.message ?? error}): set J01N_WORKTREE_ROOT to an absolute path on internal storage`; }
}
/** The socket has to answer, and the pane names this sprint is about to create have to be free. */
function herdrProblems(names, resuming) {
  const problems = [];
  const warnings = [];
  const status = probe("herdr", ["status"], { timeout: 30_000 });
  if (!status.ok) problems.push(`"herdr status" did not answer${status.detail ? `: ${status.detail}` : ""}: start the Herdr server on this machine before creating a sprint`);
  else {
    const reported = /status:\s*(\S+)/.exec(status.out)?.[1];
    if (reported && reported !== "running") problems.push(`herdr reports "status: ${reported}": bring the Herdr server up (herdr status) before creating a sprint`);
  }
  const listed = probe("herdr", ["agent", "list"], { timeout: 30_000 });
  if (!listed.ok) problems.push(`"herdr agent list" failed${listed.detail ? `: ${listed.detail}` : ""}: fix the Herdr session so worker pane names can be checked`);
  else {
    let live = null;
    try { live = JSON.parse(listed.out)?.result?.agents; } catch { live = null; }
    if (!Array.isArray(live)) warnings.push(`"herdr agent list" returned no agent list: skipped the worker-name check`);
    else {
      const taken = new Set(live.map((agent) => (typeof agent?.name === "string" ? agent.name : "")).filter(Boolean));
      // A resumed sprint owns the panes it created, so its own names are live by design and must not clash.
      const clashes = resuming ? [] : names.filter((name) => taken.has(name));
      if (clashes.length) problems.push(`worker name(s) ${clashes.join(", ")} already run in a live Herdr workspace: pass --worker-prefix <fresh> or close those workspaces (herdr agent list)`);
    }
  }
  return { problems, warnings };
}
/**
 * Everything that could waste a room, a worktree or a pane, checked before any side effect: an interrupted or
 * refused start must leave nothing behind. Each problem is one line carrying its own fix.
 */
async function preflight({ keys, worktreeRoot, helperPath, names, resuming, roomPointer, uiTester, dry }) {
  const found = gitProblem();
  const problems = found ? [found] : [];
  const root = worktreeRootProblem(worktreeRoot);
  if (root) problems.push(root);
  if (!existsSync(helperPath)) problems.push(`j01n helper not found: ${helperPath}; run node scripts/generate-client-script.mjs or pass --helper <path>`);
  if (uiTester) {
    // The tester pane boots straight into this script and cwd, so a missing one must refuse before the room exists.
    if (!existsSync(uiTester.script)) problems.push(`ui-tester script not found: ${uiTester.script}; install the tester or point J01N_UI_TESTER_SCRIPT at it`);
    if (!existsSync(uiTester.cwd) || !statSync(uiTester.cwd).isDirectory()) problems.push(`the ui-tester pane cwd ${uiTester.cwd} is not a directory: create it or point J01N_UI_TESTER_CWD at the tester's home`);
    const python = probe("python3", ["--version"], { timeout: 30_000 });
    if (!python.ok) problems.push(`"python3 --version" did not run${python.detail ? `: ${python.detail}` : ""}: the ui-tester pane starts python3`);
  }
  const herdr = herdrProblems(names, resuming);
  problems.push(...herdr.problems);
  const scanned = await scanPointers(keys);
  if (scanned.dead.length && !dry) {
    for (const { file } of scanned.dead) rmSync(file, { force: true });
    console.log(`Pruned ${scanned.dead.length} stale room pointer(s): ${scanned.dead.map(({ label }) => label).join(", ")}`);
  } else if (scanned.dead.length) {
    console.log(`Dry run: ${scanned.dead.length} stale room pointer(s) would be pruned: ${scanned.dead.map(({ label }) => label).join(", ")}`);
  }
  const foreign = scanned.alive.filter((file) => !(resuming && basename(file) === roomPointer));
  if (foreign.length) problems.push(`${foreign.length} other room(s) are still active in ${keys}; leave or close them so this sprint owns the directory`);
  return { problems, warnings: herdr.warnings };
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────

function orderedTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const out = [];
  const visit = (task, seen) => {
    if (out.includes(task.id) || seen.has(task.id)) return;
    seen.add(task.id);
    for (const dep of task.depends_on ?? []) if (byId.has(dep)) visit(byId.get(dep), seen);
    out.push(task.id);
  };
  for (const task of [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) visit(task, new Set());
  return out.map((id) => byId.get(id));
}
/** The board task value carries the spec brief once the spec parser seeds it; free text, one line. */
const briefOf = (task) => (typeof task?.brief === "string" ? task.brief.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_BRIEF) : "");
/** A state written before briefs existed still gets them: merge the board values in once, quietly. */
function refreshBriefsForStart(state) {
  const tasks = (state.tasks ??= []);
  if (tasks.length && tasks.every((task) => briefOf(task))) return;
  let changed = false;
  for (const task of soft(state, ["tasks"])?.tasks ?? []) {
    const brief = briefOf(task);
    if (!brief) continue;
    const known = tasks.find((entry) => entry.id === task.id);
    if (known) { if (known.brief !== brief) { known.brief = brief; changed = true; } }
    else { tasks.push({ id: task.id, title: task.title ?? "", files: task.files ?? [], depends_on: task.depends_on ?? [], brief }); changed = true; }
  }
  if (changed) saveState(state);
}
function promptFor(state, worker) {
  const task = worker.task;
  const brief = task ? briefOf((state.tasks ?? []).find((entry) => entry.id === task)) : "";
  return [
    `You are ${worker.id} in the j01n room "${state.name}" (host ${state.host}). The invitation is already in your inbox and the identity file is seeded in this checkout.`,
    `Open with /j01n tasks: if that answers, this pane already auto-joined at session start and you must NOT run listen (its invite is spent, so listen would only time out); only when no room is joined run exactly: /j01n listen ${worker.id} --capabilities ${state.capabilities}`,
    // A late joiner cannot read chat sent before it joined, so the brief comes off the room-sealed board, never a message.
    !task ? `Then: /j01n tasks and claim one open unblocked task.`
      : brief ? `Then: /j01n tasks, /j01n claim ${task}, and work the board BRIEF for ${task} (board key task.${task}, field "brief"): ${brief}`
        : `Then: /j01n tasks, /j01n claim ${task}, and read the sealed BRIEF for ${task} with /j01n read before coding.`,
    `Work only in this worktree on task ${task ?? "your claim"} and only the files it lists. Never push or merge, and never put a room link, join secret or token in a file, prompt or commit.`,
    `Before reporting run node scripts/check-contract.mjs --peer. Then commit and immediately: /j01n done ${task ?? "<id>"} --summary <text> --commit <sha> --tests <text> --contract "pnpm check:contract --peer passed".`,
    `If you are blocked or cannot read the brief, ask ${state.host} with --kind question --expect-reply and say what you tried.`,
  ].join(" ");
}
/** Agent inboxes are global first-come-first-served names: keep an existing identity, never hide a clash. */
function ensureIdentity(state, name, acceptFrom, hint) {
  const file = join(state.keys_dir, `.j01n-agent-${safeName(name)}.json`);
  if (existsSync(file)) return;
  try { helper(state, ["register", name, acceptFrom], { quiet: false, label: `j01n register ${name}` }); }
  catch (error) {
    const detail = String(error.detail ?? error.message);
    if (/already registered|taken/i.test(detail)) fail(`agent name "${name}" is already registered on ${state.base}: ${hint}`, detail);
    throw error;
  }
}
/** Workers read as `id=task`; a role peer (the ui-tester) owns no task, so it reads as `id:role`. */
const roster = (state) => (state.workers ?? []).map((worker) => (worker.role ? `${worker.id}:${worker.role}` : `${worker.id}=${worker.task ?? "?"}`)).join(" ");
/** The role peers only: status gets this segment when a sprint runs with --ui-tester, and nothing otherwise. */
const roleRoster = (state) => (state.workers ?? []).filter((worker) => worker.role).map((worker) => `${worker.role}=${worker.id}${worker.started ? "" : "(pending pane)"}`).join(",");
/**
 * Which role a worker pane answers to: what it announced in the room. Role peers (the ui-tester) are not candidates at
 * all - they own no task - so the routing role always comes from the peer's own announcement.
 */
const workerRole = (worker, team) => {
  const announced = team.find((peer) => peer.id === worker.id)?.role;
  return typeof announced === "string" ? announced : "";
};
/** An open task's role only routes if some worker pane actually announces that role; that is what "role-tagged" means. */
function rosterPlan(state, tasks, team, explicit) {
  const roles = new Set((state.workers ?? []).filter((worker) => !worker.role).map((worker) => workerRole(worker, team)).filter(Boolean));
  const matched = (tasks ?? []).some((task) => typeof task.role === "string" && task.role && task.status === "open" && roles.has(task.role));
  if (explicit) return { mode: explicit, source: "flag", why: "--roster flag" };
  // A mode the host chose with the flag sticks across resumes; a defaulted one is re-read, because workers join later.
  if (state.roster?.source === "flag") return { mode: state.roster.mode, source: "flag", why: "recorded from --roster" };
  return matched ? { mode: "auto", source: "default", why: "role-tagged workers in the room" }
    : { mode: "manual", source: "default", why: "no worker announces a role an open task asks for" };
}
/**
 * Host routing: offer every open, unblocked task carrying a role to a joined, free pane announcing that role, the
 * pane paired with the task at start first. An assign is an offer, never a force - the worker still claims - so a
 * refusal must not abort a start: each offer is soft, logged, and recorded in sprint.json under `assigns` so status
 * can show the routed column and finish can hand an untouched offer back to the board.
 */
function routeRoster(state, summary) {
  const team = summary.participants ?? [];
  const tasks = summary.tasks ?? [];
  const offers = (state.assigns ??= {});
  const taken = new Set(Object.entries(offers).filter(([, offer]) => !offer.released).map(([, offer]) => offer.worker));
  // A pane holding an unfinished claim is not idle, whatever its turn state says; our own offer already covers its task.
  const busy = new Set(tasks.filter((task) => ["claimed", "blocked"].includes(task.status) && task.owner).map((task) => task.owner));
  const routed = [];
  const unrouted = [];
  for (const task of orderedTasks(tasks)) {
    if (typeof task.role !== "string" || !task.role || task.status !== "open" || (task.blocked_by ?? []).length) continue;
    const prior = offers[task.id];
    if (prior && !prior.released) continue; // the offer still stands, do not spam the pane with a second one
    const worker = (state.workers ?? [])
      .filter((entry) => !entry.role && !taken.has(entry.id) && !busy.has(entry.id) && workerRole(entry, team) === task.role &&
        team.some((peer) => peer.id === entry.id && (peer.state || "free") === "free"))
      .sort((a, b) => Number(b.task === task.id) - Number(a.task === task.id))[0];
    if (!worker) { unrouted.push(`${task.id} has no free ${task.role} pane; left open`); continue; }
    const offered = soft(state, ["assign", task.id, worker.id, `roster:auto: ${task.role} pane ${worker.id}`]);
    if (!offered) { unrouted.push(`${task.id} was not offered to ${worker.id}: assign refused (or this helper build has no assign verb)`); continue; }
    offers[task.id] = { worker: worker.id, role: task.role, at: nowIso(), released: null };
    taken.add(worker.id);
    routed.push(`${task.id}->${worker.id}`);
    console.log(`${task.id} routed to ${worker.id} (role: ${task.role})`);
  }
  saveState(state);
  for (const line of unrouted) console.log(`roster:auto: ${line}`);
  // One finding for the room, and only when this run actually handed something over: workers claim from the board anyway.
  if (routed.length) announce(state, `Sprint routing (roster:auto): offered ${routed.join(", ")}${unrouted.length ? `; ${unrouted.join("; ")}` : ""}. Claim to accept.`);
  return { routed, unrouted };
}
/** Resolve the mode for this run and route when it is auto; `off` stays completely silent about routing. */
function applyRoster(state, explicit) {
  const summary = soft(state, ["summary"]);
  if (!summary) { if (explicit !== "off") console.log("roster: the room is not readable right now, nothing was routed"); return; }
  const plan = rosterPlan(state, summary.tasks, summary.participants ?? [], explicit);
  state.roster = { ...plan, at: nowIso() };
  saveState(state);
  if (plan.mode === "off") return;
  console.log(`roster:${plan.mode} (${plan.why})`);
  if (plan.mode === "auto") routeRoster(state, summary);
}
/**
 * Routed column for status: task.id -> the worker the board hands it to. `assigned` is exactly what the assign verb
 * writes (and what a routed task.unblocked notice carries), so the board alone answers the question; the sprint's own
 * still-standing offer covers a helper build whose assign verb writes only owner+status.
 */
function assignedWorker(state, task) {
  if (typeof task.assigned === "string" && task.assigned) return task.assigned;
  const offer = (state?.assigns ?? {})[task.id];
  return offer && !offer.released && task.status === "claimed" && task.owner === offer.worker ? offer.worker : "";
}
const routedTasks = (state, tasks) => (tasks ?? []).filter((task) => task.status !== "done")
  .map((task) => [task.id, assignedWorker(state, task)]).filter(([, worker]) => worker);
const compactRouted = (entries) => `routed:${entries.length ? entries.map(([id, worker]) => `${id}@${worker}`).join(",") : "none"}`;
/**
 * Was an offer taken up? The assign verb marks its own write (`assigned` plus `assigned_by`), so an offer still stands
 * while both name the same worker and that worker wrote nothing of their own on the key: no evidence, no summary, no
 * block, no handover, and no file reservation under "task <id>" from the claim that accepts it. Without the verb's own
 * mark the claim belongs to the worker and is never ours to hand back.
 */
function assignTaken(task, id, offer, reservations) {
  if (!task || task.owner !== offer.worker) return true; // gone, or handed to somebody else: nothing to release
  if (["done", "blocked"].includes(task.status) || task.summary || task.evidence) return true;
  if ((reservations ?? []).some((entry) => entry.by === offer.worker && entry.reason === `task ${id}`)) return true;
  return !(typeof task.assigned === "string" && task.assigned === offer.worker && typeof task.assigned_by === "string" && task.assigned_by);
}
/**
 * Finish releases the offers nobody accepted back to open, with a note, so the task is claimable again instead of
 * sitting claimed-by-host forever. `unassign <id> <note>` is the host-side inverse of the assign verb that the CLI task
 * routes; on a helper build without it the release is REPORTED and never faked - the host is told which task key to set
 * back to open by hand, and sprint.json keeps the offer live so the next finish retries it. A dry run only reports.
 */
function releaseStaleAssigns(state, summary, dry) {
  const pending = Object.entries(state.assigns ?? {}).filter(([, offer]) => !offer.released);
  if (!pending.length) return { released: [], stuck: [] };
  const released = [];
  const stuck = [];
  for (const [id, offer] of pending) {
    const task = (summary.tasks ?? []).find((entry) => entry.id === id);
    if (assignTaken(task, id, offer, summary.reservations)) continue;
    const note = `roster:auto offer to ${offer.worker} at ${offer.at} was not accepted`;
    if (dry) { released.push(`${id}->${offer.worker}`); continue; }
    if (!soft(state, ["unassign", id, note])) {
      stuck.push(`${id}->${offer.worker}`);
      console.log(`roster: ${id} stays claimed by ${offer.worker}: this helper build has no unassign verb, set task.${id} back to open by hand`);
      continue;
    }
    offer.released = nowIso();
    saveState(state);
    released.push(`${id}->${offer.worker}`);
    console.log(`${id} released to open: offer to ${offer.worker} was not accepted`);
  }
  if (released.length && !dry) announce(state, `Sprint finish: released the unaccepted assign(s) ${released.join(", ")} back to open with a note on each task.`);
  if (stuck.length && !dry) announce(state, `Sprint finish: ${stuck.join(", ")} still holds an unaccepted assign this helper build cannot release; set those task keys back to open by hand.`);
  return { released, stuck };
}
/**
 * The ui-tester wiring, run after the workers and recorded step by step so a resume repeats none of it: register the
 * inbox identity into the keys dir, invite it, join the room *on its behalf* (only the host holds the invitation, so
 * only it can hand out a participant token) and write the snake_case profile the python pane reads by path, then open
 * one Herdr pane running the tester against that profile.
 */
function wireUiTester(state, plan) {
  let acted = false;
  let record = state.workers.find((worker) => worker.role === UI_TESTER_ROLE);
  if (!record) {
    record = { id: plan.name, role: UI_TESTER_ROLE, task: null, pane_cwd: plan.cwd, profile: join(state.keys_dir, `${safeName(plan.name)}-profile.json`) };
    state.workers.push(record);
    saveState(state);
    acted = true;
  } else if (record.id !== plan.name) fail(`sprint.json already records the ui-tester as ${record.id}; --ui-tester-name ${plan.name} does not match it (pass the recorded name or start a fresh room)`);
  const identity = join(state.keys_dir, `.j01n-agent-${safeName(record.id)}.json`);
  ensureIdentity(state, record.id, state.host, `pass --ui-tester-name <fresh> for this sprint or restore ${identity}`);
  if (!record.invited) {
    helper(state, ["invite", state.host, record.id, state.invite_link], { redactArgs: [3], quiet: false, label: `j01n invite ${record.id}` });
    record.invited = true;
    acted = true;
    saveState(state);
  }
  if (!record.joined || !existsSync(record.profile)) {
    const joined = helper(state, ["join", state.invite_link, record.id, "--no-workspace", "--role", UI_TESTER_ROLE], { redactArgs: [1], quiet: false, label: `j01n join ${record.id}` });
    if (!joined?.access || !joined?.participant_token) fail(`j01n join ${record.id} returned no participant profile; the tester pane needs ${record.profile}`);
    track(joined.participant_token);
    // snake_case keys on purpose: this file is a room profile the helper and the tester read as-is, never a sprint field.
    writeFileSync(record.profile, JSON.stringify({ access: joined.access, participant_token: joined.participant_token, participant_id: joined.participant_id ?? record.id }, null, 2), { mode: 0o600 });
    chmodSync(record.profile, 0o600);
    // Joining also records an active-room pointer for the tester. The host's own bare helper calls need exactly one
    // pointer in this directory, and the pane addresses its room through the profile path, so the extra one goes.
    rmSync(join(state.keys_dir, ".j01n-rooms", `${createHash("sha256").update(`${joined.access}\0${record.id}`).digest("hex")}.json`), { force: true });
    record.joined = true;
    acted = true;
    saveState(state);
    console.log(`${record.id}: joined ${slug(state.room_id)} as ${UI_TESTER_ROLE}, profile ${record.profile}`);
  }
  if (!record.workspace_id || !record.pane_id) {
    // The pane needs the keys directory and the client it polls with, not a checkout: it works the room, not the repo.
    const made = json("herdr", ["workspace", "create", "--cwd", record.pane_cwd, "--label", record.id, "--env", `BASE_URL=${state.base}`,
      "--env", `J01N_KEY_DIR=${state.keys_dir}`, "--env", `J01N_HELPER=${state.helper}`, "--no-focus"], { cwd: state.host_checkout, label: `herdr workspace create ${record.id}`, timeout: 120_000 });
    record.workspace_id = made.result?.workspace?.workspace_id ?? made.result?.workspace_id ?? made.result?.workspace?.id;
    record.pane_id = made.result?.root_pane?.pane_id ?? made.result?.pane?.pane_id ?? made.result?.pane_id;
    if (!record.workspace_id || !record.pane_id) fail("herdr did not return the new ui-tester workspace and its pane; inspect the session before retrying");
    acted = true;
    saveState(state);
  }
  if (!record.started) {
    exec("herdr", ["pane", "run", record.pane_id, "python3", plan.script, "--profile", record.profile, "--interval", String(plan.interval)],
      { cwd: state.host_checkout, label: `herdr pane run ${record.id}`, timeout: 60_000 });
    record.started = true;
    acted = true;
    saveState(state);
  }
  console.log(`${record.id}: ${UI_TESTER_ROLE} pane ${record.pane_id} polling every ${plan.interval}s from ${record.pane_cwd}`);
  return acted;
}
/** Workers need their own installed checkout; a fixture repo without a manifest needs none. */
function installDeps(worktree) {
  if (!existsSync(join(worktree, "package.json"))) return;
  const manifest = join(worktree, "pnpm-workspace.yaml");
  const before = existsSync(manifest) ? readFileSync(manifest) : null;
  try { exec("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, label: "pnpm install --frozen-lockfile" }); }
  finally { if (before && (!existsSync(manifest) || !readFileSync(manifest).equals(before))) writeFileSync(manifest, before); }
}
async function start() {
  checkFlags(["--spec", "--name", "--workers", "--host", "--worker-prefix", "--from", "--remote", "--invite-to", "--capabilities", "--server", "--state", "--helper", "--dry-run", "--ui-tester", "--ui-tester-name", "--roster"]);
  if (positional().length) fail("start takes flags only; see the usage line");
  const specArg = option("--spec", "");
  const name = option("--name", "").trim();
  const workersArg = option("--workers", "");
  const workers = Number(workersArg);
  if (!specArg || !name || !workersArg) fail("start needs --spec <spec.md> --name <room> --workers N");
  const spec = resolve(specArg);
  if (!existsSync(spec) || !statSync(spec).isFile()) fail(`--spec must be a regular file: ${specArg}`);
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) fail("--workers must be an integer from 1 to 8");
  const host = option("--host", process.env.J01N_HOST_ID || "hermes-bot");
  if (!PARTICIPANT_ID.test(host)) fail("--host must be a valid room participant id");
  const prefix = option("--worker-prefix", "worker");
  if (!PARTICIPANT_ID.test(`${prefix}-1`)) fail("--worker-prefix must produce valid participant ids");
  const capabilities = option("--capabilities", process.env.J01N_WORKER_CAPABILITIES || "code,files");
  const rosterArg = option("--roster", undefined);
  if (rosterArg !== undefined && !ROSTER_MODES.includes(rosterArg)) fail(`--roster must be one of ${ROSTER_MODES.join(", ")}`);
  const uiTesterFlag = args.includes("--ui-tester");
  const uiTesterName = option("--ui-tester-name", UI_TESTER_ROLE).trim();
  if (!uiTesterFlag && args.includes("--ui-tester-name")) fail("--ui-tester-name needs --ui-tester");
  if (uiTesterFlag && !PARTICIPANT_ID.test(uiTesterName)) fail("--ui-tester-name must be a valid room participant id");
  const uiTester = uiTesterFlag ? {
    name: uiTesterName,
    script: process.env.J01N_UI_TESTER_SCRIPT || UI_TESTER_SCRIPT,
    cwd: process.env.J01N_UI_TESTER_CWD || UI_TESTER_CWD,
    interval: Number(process.env.J01N_UI_TESTER_INTERVAL || UI_TESTER_INTERVAL),
  } : null;
  if (uiTester && (!Number.isInteger(uiTester.interval) || uiTester.interval < 1)) fail("J01N_UI_TESTER_INTERVAL must be a positive whole number of seconds");
  const inviteTo = option("--invite-to", DEFAULT_INVITE_TO);
  const helperPath = resolve(option("--helper", join(root, "packages/helper/client/j01n.js")));
  const keys = keysDir();
  const worktreeRoot = process.env.J01N_WORKTREE_ROOT || join(homedir(), "Development", "_worktrees");
  const base = serverBase();
  const existing = loadState();
  const resuming = Boolean(existing?.room_id);
  if (resuming && !(await roomAlive(existing.room_url, undefined))) fail(`sprint.json tracks ${existing.room_id}, which is closed or expired; move ${stateFile()} aside and start again`);
  // Doctor first: a refused start must leave no room, no worktree, no pane and no identity behind.
  const planned = resuming ? (existing.workers ?? []).map((worker) => worker.id) : Array.from({ length: workers }, (unused, index) => `${prefix}-${index + 1}`);
  // Task worker names are the ones the tester name may not collide with: on a resume the recorded ui-tester is planned too.
  const taskNames = resuming ? (existing.workers ?? []).filter((worker) => !worker.role).map((worker) => worker.id) : planned;
  if (uiTester) {
    if (uiTester.name === host) fail(`--ui-tester-name must differ from --host ${host}`);
    if (taskNames.includes(uiTester.name)) fail(`--ui-tester-name ${uiTester.name} is also a worker name; pass --ui-tester-name <fresh> or --worker-prefix <fresh>`);
    if (!planned.includes(uiTester.name)) planned.push(uiTester.name);
  }
  const doctor = await preflight({ keys, worktreeRoot, helperPath, names: planned, resuming, roomPointer: existing?.room_pointer, uiTester, dry });
  if (doctor.problems.length) {
    for (const problem of doctor.problems) console.error(`preflight: ${problem}`);
    fail(`sprint preflight refused with ${doctor.problems.length} problem(s); fix each line above and run start again`);
  }
  for (const warning of doctor.warnings) console.log(`preflight: ${warning}`);
  const repoDir = git("rev-parse", "--show-toplevel");
  if (repoDir !== process.cwd()) fail("start must run from the repository root");
  const from = option("--from", "main");
  git("check-ref-format", "--branch", from);
  if (!gitSoft(process.cwd(), "rev-parse", "--verify", "--quiet", `${from}^{commit}`)) fail(`--from ${from} does not name a commit here`);
  const wtRoot = internal(worktreeRoot);
  if (dry) {
    console.log(`Plan: preflight passed (git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}, herdr socket, free worker names, private keys dir, internal worktree root); prune stale pointers in ${join(keys, ".j01n-rooms")}; create+join "${name}" as ${host} from ${basename(spec)} on ${base}; ${workers} worker(s) ${prefix}-1..${prefix}-${workers} in ${wtRoot}/<room>/<worker> off ${from}, each with its own Herdr workspace + pane carrying BASE_URL/J01N_TASK/J01N_WORKER/J01N_WORKER_CAPABILITIES in its env and prompted to open with /j01n tasks (listen ${prefix}-N --capabilities ${capabilities} only as the fallback when the pane did not auto-join), its task id and its board brief; register+invite each worker, seed its identity file into its worktree${uiTester ? `; then register+invite ${uiTester.name} as the ${UI_TESTER_ROLE}, join it on its own behalf into a private profile at ${join(keys, `${safeName(uiTester.name)}-profile.json`)} and start one more Herdr pane (cwd ${uiTester.cwd}) running python3 ${uiTester.script} --profile <that file> --interval ${uiTester.interval}, recorded in workers with role ${UI_TESTER_ROLE} so status shows it` : ""}; route open tasks with a role to free panes announcing that role when --roster auto (or by default once a role-tagged worker joins), leave claiming to the workers on --roster manual and stay silent about routing on --roster off; deliver the raw invite link as a file via ${inviteTo === "none" ? "(skipped)" : inviteTo}; status keeps the invite topped up by ${KEEPALIVE_EXTEND_MINUTES} minutes on every ${Math.round(KEEPALIVE_TICK_MS / 60_000)} minute tick while the board holds live work (one room notice per hour, and no extension once the board is done and integrated so idle rooms expire); state in ${stateFile()}. Nothing changed.`);
    return;
  }
  assertClean();
  let state = existing;
  if (!resuming) {
    const created = helper({ host_checkout: process.cwd(), keys_dir: keys, helper: helperPath }, ["create", base, JSON.stringify({
      host_id: host, room_name: name, purpose: `Sprint ${name}`, max_participants: Math.min(64, workers + 4), template: "sprint", spec,
    })], { redactArgs: [2], quiet: false, echoError: false, label: `j01n create ${basename(spec)} as ${host}` });
    const roomUrl = created.room_url ?? created.access;
    const roomId = created.room_id ?? new URL(roomUrl).pathname.split("/").pop();
    if (!created?.invite_link || !roomUrl || !roomId) fail("room create returned no invite; check the helper, the server and the spec");
    track(created.invite_link);
    track(created.join_secret);
    state = saveState({
      version: 1, created_at: nowIso(), state_file: stateFile(), host_checkout: repoDir, keys_dir: keys, helper: helperPath, base,
      room_pointer: basename(pointerFiles(keys).at(-1) ?? ""), room_id: roomId, room_url: roomUrl, invite_link: created.invite_link,
      // The keepalive loop needs the invite deadline the server handed back; each extend refreshes it, and
      // last_extend_at is the tick stamp that keeps a resumed loop from re-extending early or re-announcing.
      expires_at: typeof created.expires_at === "string" ? created.expires_at : "",
      host, name, spec, from, remote: option("--remote", "origin"), capabilities, invite_to: inviteTo, worktree_root: wtRoot,
      agent_kind: process.env.J01N_AGENT_KIND || "pi", workers: [], delivered: false, assigns: {},
    });
    const ordered = orderedTasks(helper(state, ["tasks"], { echoError: false }).tasks ?? []);
    if (!ordered.length) fail(`the room has no tasks; ${basename(spec)} needs a "## Tasks" section`);
    state.tasks = ordered.map((task) => ({
      id: task.id, title: task.title, files: task.files ?? [], depends_on: task.depends_on ?? [],
      ...(briefOf(task) ? { brief: briefOf(task) } : {}),
    }));
    state.workers = Array.from({ length: workers }, (unused, index) => ({
      id: `${prefix}-${index + 1}`, task: ordered[index]?.id ?? null, branch: `${slug(state.room_id)}/${prefix}-${index + 1}`,
      worktree: join(wtRoot, basename(repoDir), slug(state.room_id), `${prefix}-${index + 1}`),
    }));
    saveState(state);
    const unstaffed = ordered.slice(workers).map((task) => task.id);
    if (unstaffed.length) console.log(`No worker for ${unstaffed.join(", ")}; claim them yourself or raise --workers`);
    console.log(`Room ${state.room_id} "${state.name}" created and joined as ${state.host}.`);
  } else {
    console.log(`Resuming sprint ${state.room_id} "${state.name}" from ${stateFile()}`);
  }
  const hostIdentity = join(state.keys_dir, `.j01n-agent-${safeName(state.host)}.json`);
  let acted = !resuming;
  // Role peers (the ui-tester) are wired after this loop: they own no task, no branch and no git worktree.
  const builders = state.workers.filter((worker) => !worker.role);
  // Briefs come off the board so a worker never has to read chat it missed; a pre-brief state gets them merged in once.
  if (builders.some((worker) => !worker.prompted)) refreshBriefsForStart(state);
  ensureIdentity(state, state.host, state.workers.map((worker) => worker.id).join(","), `pass --host <fresh id> (the host's room id and its inbox name are the same) or restore ${hostIdentity}`);
  for (const worker of builders) {
    const identity = join(state.keys_dir, `.j01n-agent-${safeName(worker.id)}.json`);
    const wasPrompted = Boolean(worker.prompted);
    ensureIdentity(state, worker.id, state.host, `pass --worker-prefix <fresh> for this sprint or restore ${identity}`);
    if (!worker.invited) { helper(state, ["invite", state.host, worker.id, state.invite_link], { redactArgs: [3], quiet: false, label: `j01n invite ${worker.id}` }); worker.invited = true; acted = true; saveState(state); }
    if (!existsSync(worker.worktree)) {
      if (!resolve(worker.worktree).startsWith(resolve(state.worktree_root, basename(state.host_checkout), slug(state.room_id)) + "/")) fail(`refusing a worktree outside the sprint root: ${worker.worktree}`);
      mkdirSync(dirname(worker.worktree), { recursive: true, mode: 0o755 });
      if (gitAt(state.host_checkout, "branch", "--list", worker.branch)) gitAt(worker.worktree, "worktree", "add", worker.worktree, worker.branch);
      else gitAt(state.host_checkout, "worktree", "add", "-b", worker.branch, worker.worktree, state.from);
      installDeps(worker.worktree);
      acted = true;
    }
    assertClean(worker.worktree, state);
    const seeded = join(worker.worktree, `.j01n-agent-${safeName(worker.id)}.json`);
    if (!existsSync(seeded)) { copyFileSync(identity, seeded); chmodSync(seeded, 0o600); worker.seeded = true; acted = true; saveState(state); }
    if (!worker.workspace_id || !worker.pane_id) {
      // J01N_WORKER_CAPABILITIES lets the pane's own session-start autojoin announce capabilities, so the worker's
      // presence is right before its first turn; the listen fallback above carries the same value.
      const made = json("herdr", ["workspace", "create", "--cwd", worker.worktree, "--label", worker.id, "--env", `BASE_URL=${state.base}`,
        "--env", `J01N_TASK=${worker.task ?? ""}`, "--env", `J01N_WORKER=${worker.id}`, "--env", `J01N_WORKER_CAPABILITIES=${state.capabilities}`, "--no-focus"], { cwd: state.host_checkout, label: `herdr workspace create ${worker.id}`, timeout: 120_000 });
      worker.workspace_id = made.result?.workspace?.workspace_id ?? made.result?.workspace_id ?? made.result?.workspace?.id;
      worker.pane_id = made.result?.root_pane?.pane_id ?? made.result?.pane?.pane_id ?? made.result?.pane_id ?? made.result?.pane_id;
      if (!worker.workspace_id || !worker.pane_id) fail("herdr did not return the new workspace and its root pane; inspect the session before retrying");
      acted = true;
      saveState(state);
    }
    if (!worker.started) {
      exec("herdr", ["agent", "start", worker.id, "--kind", state.agent_kind, "--pane", worker.pane_id], { cwd: state.host_checkout, label: `herdr agent start ${worker.id}`, timeout: 300_000 });
      worker.started = true;
      acted = true;
      saveState(state);
    }
    if (!worker.prompted) {
      exec("herdr", ["agent", "prompt", worker.pane_id, promptFor(state, worker)], { cwd: state.host_checkout, label: `herdr agent prompt ${worker.id}`, timeout: 60_000 });
      worker.prompted = true;
      acted = true;
      saveState(state);
    }
    console.log(`${worker.id}: task ${worker.task ?? "(any open task)"} branch ${worker.branch} pane ${worker.pane_id}${wasPrompted ? " (already prompted)" : ""}`);
  }
  // The room needs a pair of eyes on the running UI: one extra participant, one extra pane, no task and no worktree.
  if (uiTester && wireUiTester(state, uiTester)) acted = true;
  if (!state.delivered && state.invite_to && state.invite_to !== "none") {
    const dir = mkdtempSync(join(tmpdir(), "j01n-sprint-"));
    chmodSync(dir, 0o700);
    const file = join(dir, `invite-${slug(state.room_id)}.txt`);
    // Byte-exact: the file body is the raw link and nothing else, so no client reflows, quotes or truncates it.
    writeFileSync(file, state.invite_link, { mode: 0o600 });
    try { exec("hermes", ["send", "-t", state.invite_to, "-f", file, "-q"], { label: `hermes send -t ${state.invite_to} -f <invite file>`, timeout: 120_000 }); state.delivered = true; acted = true; saveState(state); }
    finally { rmSync(dir, { recursive: true, force: true }); }
    console.log(`Invite link sent to ${state.invite_to} as a raw file; confirm with status that the owner actually joins.`);
  }
  // Room announcements are noise on a no-op resume, so only speak when this run actually did something.
  const branches = state.workers.filter((worker) => !worker.role).map((worker) => worker.branch).join(" ");
  if (acted) announce(state, `Sprint ${state.name} started: ${roster(state)}; branches ${branches} off ${state.from}.`);
  // Routing runs last: by now the panes exist, were invited and had their first turn, so "free" means idle.
  applyRoster(state, rosterArg);
  console.log(`Next: status, answer <msg-id> <text>, finish --dry-run.`);
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────

const compactTasks = (tasks) => tasks.map((task) => `${task.id}:${task.status}${task.owner ? `@${task.owner}` : ""}${task.blocked_by?.length ? `<- ${task.blocked_by.join(",")}` : ""}`).join(" ") || "no tasks";
/** Unanswered asks, counted the way the room does it: an ask closes when the owed participant replies to it. */
function openAsks(messages) {
  const repliers = new Map();
  for (const message of messages) {
    if (!message.reply_to) continue;
    if (!repliers.has(message.reply_to)) repliers.set(message.reply_to, new Set());
    repliers.get(message.reply_to).add(message.from);
  }
  const now = Date.now();
  return messages.filter((message) => message.expects_reply).flatMap((ask) => {
    const replied = repliers.get(ask.id) ?? new Set();
    const owedBy = ask.to === "all" ? ([...replied].some((id) => id !== ask.from) ? [] : ["anyone"]) : (Array.isArray(ask.to) ? ask.to : [ask.to]).filter((id) => !replied.has(id));
    return owedBy.map((who) => ({ ask_id: ask.id, seq: ask.seq, from: ask.from, owed_by: who, due_at: ask.expects_reply.due_at, overdue: Date.parse(ask.expects_reply.due_at) < now }));
  });
}
const compactAsks = (asks) => (asks.length ? `asks:${asks.length} ${asks.map((ask) => `#${ask.seq ?? String(ask.ask_id).slice(0, 8)} ${ask.from}->${ask.owed_by}${ask.overdue ? " OVERDUE" : ""}`).join(",")}` : "asks:none");
/**
 * Board activity, read off the decrypted board: anything that is not `done` is work the room must survive. A blocked
 * task counts while its dependencies are unresolved - and a blocked task whose deps are done still waits on the host
 * to unblock it, so it is unfinished work too. Anything the board spells differently than these four statuses counts
 * as open rather than silently stopping the keepalive.
 */
function boardActivity(tasks) {
  const counts = { open: 0, claimed: 0, blocked: 0, done: 0 };
  for (const task of tasks ?? []) {
    const status = String(task?.status ?? "");
    if (status === "done") counts.done++;
    else if (status === "claimed") counts.claimed++;
    else if (status === "blocked") counts.blocked++;
    else counts.open++;
  }
  return counts;
}
const activityLine = (counts) => `open ${counts.open} claimed ${counts.claimed} blocked ${counts.blocked} done ${counts.done}`;
/** finish records its push, its merge request and its decision, so any one of them means the work is integrated. */
const isIntegrated = (state) => Boolean(state?.finish?.pushed || state?.finish?.mr || state?.finish?.reported);
/**
 * Host keepalive, driven by the board instead of the clock: the room must never expire while a peer is working, and
 * must not be kept alive forever once nobody is. A tick of the documented duty loop (`status`, every ~10 minutes)
 * tops the invite up by KEEPALIVE_EXTEND_MINUTES while the board holds live work - any open, claimed or blocked task.
 * The server caps the invite, so re-running each tick just keeps it topped; an invite already inside the tick window
 * is topped immediately whatever the last tick did, and between ticks a healthy invite is left alone so a host
 * running status twice in a minute does not hammer the room. Once nothing on the board is live - every task done, or
 * no tasks at all - extending stops and an idle room expires on its own, and the status line says whether integration
 * is still owed, so the host knows what it is letting expire. Each top-up gets one in-room notice per hour, never one
 * per tick. The deadline and both stamps live in sprint.json, so a crashed loop resumes without re-extending early
 * and without a duplicate notice: the stamps are written before the send, which costs at most one notice instead of
 * repeating one.
 */
function keepalive(state, tasks) {
  if (!state?.room_id) return "keepalive:no sprint state";
  const counts = boardActivity(tasks);
  const live = counts.open + counts.claimed + counts.blocked;
  const activity = `activity:${activityLine(counts)}`;
  if (!live) {
    if (!tasks.length) return `keepalive:stopped, ${activity}, empty board; the room may expire`;
    return `keepalive:stopped, ${activity}, ${isIntegrated(state) ? "integrated" : "all done, integration still owed"}; the room may expire`;
  }
  const left = Date.parse(state.expires_at ?? "") - Date.now();
  const since = Date.parse(state.last_extend_at ?? "") - Date.now();
  // Top the invite up once per duty-loop tick, and immediately when the deadline is unknown or about to lapse. A lost
  // last_extend_at (crash, or a state file from before this loop) therefore reads as "extend now", never as "skip".
  const topped = Number.isFinite(left) && left >= KEEPALIVE_TICK_MS;
  const withinTick = Number.isFinite(since) && -since < KEEPALIVE_TICK_MS;
  if (topped && withinTick) return `keepalive:live, ${Math.round(left / 60_000)}m left, ${activity}`;
  const extended = soft(state, ["extend", String(KEEPALIVE_EXTEND_MINUTES)]);
  const next = Date.parse(extended?.expires_at ?? "");
  if (!Number.isFinite(next)) {
    return `keepalive:EXTEND FAILED with live work (${activity}; invite ${Number.isFinite(left) ? `expires in ${Math.round(left / 60_000)}m` : "has no recorded deadline"}; extend is host-only, so run status as ${state.host ?? "the host"} or extend by hand)`;
  }
  const at = nowIso();
  state.expires_at = extended.expires_at;
  state.last_extend_at = at;
  const noticed = Date.parse(state.keepalive_notice_at ?? "");
  const notice = !Number.isFinite(noticed) || Date.now() - noticed >= KEEPALIVE_NOTICE_MS;
  if (notice) state.keepalive_notice_at = at;
  saveState(state);
  if (notice) announce(state, `host keepalive: room extended to ${extended.expires_at}, ${activity}`);
  return `keepalive:extended to ${extended.expires_at}, ${Math.round((next - Date.now()) / 60_000)}m left, ${activity}${notice ? ", noticed" : ""}`;
}
function compactUsage(usage) {
  if (!usage) return "usage:unavailable";
  const rows = usage.rows ?? [];
  const total = (usage.lines ?? []).at(-1)?.replace(/^room:\s*/, "") ?? "";
  return `usage:${usage.reported ?? 0}/${rows.length} ${rows.map((row) => `${row.participant}=${row.snapshot ? `${row.snapshot.input_tokens}in/${row.snapshot.output_tokens}out${row.stale ? "?" : ""}` : "-"}`).join(",")}${total ? ` | ${total}` : ""}`;
}
async function status() {
  checkFlags(["--state", "--helper"]);
  if (positional().length) fail("status takes no arguments");
  const state = loadState() ?? { host_checkout: process.cwd(), keys_dir: keysDir() };
  const summary = helper(state, ["summary"]);
  const asks = openAsks(helper(state, ["inbox"]));
  const usage = soft(state, ["usage"]);
  const participants = summary.participants ?? [];
  const owner = participants.some((participant) => participant.role === "owner") ? "owner" : "no owner";
  const roles = roleRoster(state);
  // The routed column is the host's answer to "who was this handed to": read off the board, hidden when roster is off.
  const routed = state.roster?.mode === "off" ? null : routedTasks(state, summary.tasks ?? []);
  console.log(`[${slug(state.room_id ?? "")} ${(state.name ?? "?").trim()}] ${compactTasks(summary.tasks ?? [])}${routed ? ` | ${compactRouted(routed)}` : ""} | ${compactAsks(asks)} | ${compactUsage(usage)} | report:${summary.report ? "yes" : "no"} decisions:${(summary.decisions ?? []).length} | ${participants.length} in, ${owner}${roles ? ` | roles:${roles}` : ""} | ${keepalive(state, summary.tasks ?? [])}`);
}

// ── answer ─────────────────────────────────────────────────────────────────────────────────────

async function answer() {
  checkFlags(["--state", "--helper", "--kind"], 2);
  const [target, ...words] = positional();
  const kind = option("--kind", undefined);
  if (kind && !["finding", "decision", "handoff", "notify"].includes(kind)) fail("--kind must be finding, decision, handoff or notify");
  const state = loadState() ?? { host_checkout: process.cwd(), keys_dir: keysDir() };
  const messages = helper(state, ["inbox"]);
  const asked = messages.find((message) => message.id === target) || (/^\d+$/.test(target) ? messages.find((message) => String(message.seq) === target) : undefined);
  if (!asked) fail(`no message ${target} in this room; run j01n inbox and answer what you can read`);
  if (asked.from === "system") fail("system notices have no participant to answer");
  const sent = helper(state, ["send", asked.from, ...words, "--reply-to", asked.id, ...(kind ? ["--kind", kind] : [])],
    { quiet: false, label: `j01n send ${asked.from} <text> --reply-to ${String(asked.id).slice(0, 8)}` });
  console.log(`answered #${asked.seq ?? "?"} from ${asked.from}${sent.seq ? ` as #${sent.seq}` : ""}`);
}

// ── finish ─────────────────────────────────────────────────────────────────────────────────────

function peerContractPassed(evidence) {
  // Older sprint peers put the explicit result in --tests instead of --contract.
  const report = evidence?.contract ?? evidence?.tests ?? "";
  return /\bpnpm\s+check:contract\s+--peer\s+passed\b/i.test(report);
}
function branchFor(state, task, participants) {
  const worker = state.workers.find((entry) => entry.id === task.owner);
  if (worker?.branch && worker?.worktree && existsSync(worker.worktree)) return worker;
  const peer = participants.find((participant) => participant.id === task.owner);
  if (!peer?.workspace?.branch || !peer?.workspace?.path || !existsSync(peer.workspace.path)) {
    fail(`task ${task.id}: no recorded branch/worktree for ${task.owner}; finish needs the sprint state or a peer workspace announcement`);
  }
  return { id: peer.id, branch: peer.workspace.branch, worktree: peer.workspace.path };
}
function printLessons(summary) {
  // dev/ may be private and untracked: print room notes and decisions for dev/lessons.md, never commit them.
  const entries = [...(summary.notes ?? []).map((note) => `- ${note.by}: ${note.text}`), ...(summary.decisions ?? []).map((d) => `- Decision (${d.by}): ${d.decision} — ${d.why}`)];
  if (entries.length) console.log(`Room notes and decisions for dev/lessons.md:\n${entries.join("\n")}`);
}
async function finish() {
  checkFlags(["--state", "--helper", "--title", "--dry-run", "--reviewed"]);
  if (positional().length) fail("finish takes no positional arguments");
  const state = requireState();
  if (!dry && !args.includes("--reviewed")) fail("finish needs --reviewed: the host reviewed each diff and its evidence");
  if (git("rev-parse", "--show-toplevel") !== state.host_checkout) fail(`finish must run in the host checkout ${state.host_checkout}`);
  assertClean();
  // Worker test runs may have left fake-room pointers in the keys dir (tests that inherit
  // J01N_KEY_DIR without overriding it); prune dead pointers first so summary reads resolve.
  const scan = await scanPointers(state.keys_dir ?? keysDir()).catch(() => ({ dead: [] }));
  for (const { file } of scan.dead) rmSync(file, { force: true });
  const summary = helper(state, ["summary"]);
  let tasks = summary.tasks ?? [];
  // Offers nobody took up go back to the board first, so a refused finish leaves the task claimable, not stuck claimed.
  const { released: stale, stuck } = releaseStaleAssigns(state, summary, dry);
  if (dry && stale.length) console.log(`Dry run: would release the unaccepted assign(s) ${stale.join(", ")} back to open with a note.`);
  if (stuck.length) console.log(`Roster: ${stuck.length} unaccepted assign(s) still need a manual release: ${stuck.join(", ")}.`);
  // A release just changed the board, so re-read the list: the refusal below has to describe what the host can act on.
  if (stale.length && !dry) tasks = soft(state, ["tasks"])?.tasks ?? tasks;
  const missing = tasks.filter((task) => task.status !== "done" || !task.owner || !task.evidence?.commits?.length || !task.evidence?.tests || !peerContractPassed(task.evidence));
  if (!tasks.length || missing.length) fail(`every task needs done evidence (commits, tests, explicit passed peer contract): ${missing.map((task) => `${task.id}:${task.status}`).join(", ") || "no tasks"}`);
  const openAsksList = openAsks(helper(state, ["inbox"]));
  if (openAsksList.length) fail(`answer the ${openAsksList.length} unanswered ask(s) first: ${openAsksList.map((ask) => `#${ask.seq ?? "?"}?${ask.from}`).join(", ")}`);
  if (summary.reservations?.length) fail("release or reconcile outstanding reservations before finish");
  const conflicts = helper(state, ["conflicts"], { echoError: false });
  if (conflicts.conflicts?.length) fail("peer branch merge conflicts reported; resolve and review before finishing");
  const participants = summary.participants ?? [];
  const ordered = orderedTasks(tasks);
  state.finish ??= { rebased: {}, generated: null, checked: false, pushed: null, mr: null };
  const records = new Map(ordered.map((task) => [task.id, branchFor(state, task, participants)]));
  for (const task of ordered) {
    const record = records.get(task.id);
    const expected = task.evidence.commits.at(-1);
    if (!/^[0-9a-f]{7,40}$/.test(expected)) fail(`task ${task.id}: invalid commit evidence`);
    const actual = gitAt(record.worktree, "rev-parse", record.branch);
    const reviewed = gitAt(record.worktree, "rev-parse", expected);
    // A completed rebase moves the branch on purpose; only a head that nobody recorded is a real surprise.
    if (actual !== reviewed && actual !== state.finish.rebased[task.id]) fail(`task ${task.id}: ${record.branch} is at ${actual.slice(0, 7)}, not the reviewed ${reviewed.slice(0, 7)}; stop and re-review`);
  }
  const integration = state.finish.branch ?? `sprint/${slug(state.room_id)}`;
  state.finish.branch = integration;
  saveState(state);
  let base = state.from;
  const hasRemote = Boolean(state.remote) && gitSoft(state.host_checkout, "remote", "get-url", state.remote);
  if (hasRemote) {
    git("fetch", state.remote, state.from);
    if (gitSoft(state.host_checkout, "rev-parse", "--verify", "--quiet", `${state.remote}/${state.from}^{commit}`)) base = `${state.remote}/${state.from}`;
  } else if (!dry) console.log(`remote ${state.remote} is not configured; rebasing onto the local ${state.from}`);
  console.log(`Plan: rebase ${ordered.map((task) => `${task.id}@${records.get(task.id).branch}`).join(" -> ")} onto ${base} (no merge commits), fast-forward ${integration}, regenerate client-script+assets, run FULL node scripts/check-contract.mjs, push ${state.remote}/${integration}, open MR ${integration} -> ${state.from}. The room stays open; no deploy and no merge to ${state.from}.`);
  if (dry) return;
  let onto = base;
  for (const task of ordered) {
    const record = records.get(task.id);
    const done = state.finish.rebased[task.id];
    if (done && gitAt(record.worktree, "rev-parse", record.branch) === done) { onto = record.branch; console.log(`task ${task.id}: already rebased at ${done.slice(0, 7)}`); continue; }
    assertClean(record.worktree, state);
    announce(state, `Sprint integration: rebasing ${record.branch} (task ${task.id}) onto ${onto}.`);
    gitAt(record.worktree, "rebase", onto);
    state.finish.rebased[task.id] = gitAt(record.worktree, "rev-parse", record.branch);
    saveState(state);
    onto = record.branch;
  }
  announce(state, `Sprint integration: fast-forwarding ${integration} to the rebased chain.`);
  if (!gitSoft(state.host_checkout, "rev-parse", "--verify", "--quiet", `${integration}^{commit}`)) git("branch", integration, onto);
  if (git("branch", "--show-current") !== integration) git("checkout", integration);
  git("merge", "--ff-only", onto);
  if (!state.finish.generated) {
    exec(process.execPath, ["scripts/generate-client-script.mjs"], { label: "node scripts/generate-client-script.mjs" });
    exec(process.execPath, ["scripts/generate-assets.mjs"], { label: "node scripts/generate-assets.mjs" });
    const present = GENERATED.filter((path) => existsSync(path));
    if (present.length) git("add", "--", ...present);
    if (git("diff", "--cached", "--name-only")) git("commit", "-m", "Regenerate sprint integration outputs");
    state.finish.generated = git("rev-parse", "HEAD");
    saveState(state);
  }
  assertClean();
  if (!state.finish.checked) {
    announce(state, "Sprint integration: running the full contract check (not --peer).");
    // The suite spawns CLI helpers whose fallback keys dir is the inherited J01N_KEY_DIR; run the
    // gate with it removed so test runs can neither pollute the sprint's live keys directory nor
    // misread it as their own state (each test overrides the dir it needs explicitly).
    const gateEnv = { ...process.env }; delete gateEnv.J01N_KEY_DIR;
    exec(process.execPath, ["scripts/check-contract.mjs"], { label: "node scripts/check-contract.mjs", env: gateEnv });
    state.finish.checked = true;
    saveState(state);
  }
  printLessons(summary);
  const head = git("rev-parse", "HEAD");
  if (!state.finish.pushed) {
    if (!hasRemote) fail(`finish needs a push remote: ${state.remote} is not configured (pass --remote at start)`);
    announce(state, `Sprint integration: pushing ${integration} to ${state.remote}; the merge request follows.`);
    git("push", state.remote, `HEAD:refs/heads/${integration}`);
    if (git("ls-remote", state.remote, `refs/heads/${integration}`).split(/\s+/)[0] !== head) fail(`${state.remote} does not point at ${head.slice(0, 7)}; stop before opening the merge request`);
    state.finish.pushed = head;
    saveState(state);
  }
  if (!state.finish.mr) {
    const description = [
      `Sprint ${state.name} (room ${state.room_id}): ${ordered.length} task branch(es) rebased in dependency order onto ${base}, no merge commits.`,
      "",
      ...ordered.map((task) => `- ${task.id} ${task.title} (${task.owner}, ${task.evidence.commits.map((c) => c.slice(0, 7)).join(",")}): ${task.summary}`),
      "",
      "Every task reported an explicit passed peer contract; this branch passed the full node scripts/check-contract.mjs.",
      `Workers: ${roster(state)}.`,
    ].join("\n");
    const out = exec("glab", ["mr", "create", "--source-branch", integration, "--target-branch", state.from, "--title", option("--title", `Sprint ${state.name}`), "--description", description, "--yes"],
      { label: `glab mr create ${integration} -> ${state.from}`, timeout: 120_000 });
    state.finish.mr = (out.match(/https?:\/\/\S+/) ?? [])[0] ?? "";
    saveState(state);
    announce(state, `Sprint integration: merge request ready for review: ${state.finish.mr || `${integration} -> ${state.from}`}`);
  }
  // The standalone CLI has no board_set, so the host report lands as a durable room decision (status counts them).
  if (!state.finish.reported) {
    soft(state, ["decide", `integrated ${integration} at ${head.slice(0, 7)} -> ${state.finish.mr || "merge request pending"}`,
      "--why", `rebased ${ordered.map((task) => task.id).join(",")} onto ${base} in dependency order; full node scripts/check-contract.mjs passed`]);
    state.finish.reported = true;
    saveState(state);
  }
  console.log(`Integrated ${ordered.length} task(s) into ${integration} at ${head.slice(0, 7)}; merge request: ${state.finish.mr || "see glab output"}.`);
  console.log(`Room ${state.room_id} stays open for owner review (status shows asks and usage); close it once the merge request lands.`);
}

try {
  if (action === "start") await start();
  else if (action === "status") await status();
  else if (action === "answer") await answer();
  else if (action === "finish") await finish();
  else fail("Usage: node scripts/sprint.mjs start --spec <spec.md> --name <room> --workers N [--host hermes-bot] [--worker-prefix worker] [--from main] [--remote origin] [--invite-to telegram:chat|none] [--capabilities code,files] [--roster auto|manual|off] [--ui-tester [--ui-tester-name ui-tester]] [--server url] [--state sprint.json] [--helper j01n.js] [--dry-run] | status | answer <msg-id|seq> <text> [--kind finding] | finish [--reviewed] [--title <text>] [--dry-run]");
} catch (error) {
  // SPRINT_DEBUG=1 keeps the stack for operators; the normal message stays one line.
  console.error(redact(process.env.SPRINT_DEBUG && error instanceof Error && error.stack ? error.stack : error?.message ?? String(error)));
  process.exitCode = 1;
}
