// Sprint orchestrator flow end-to-end: scripts/sprint.mjs start/status/answer/finish against a real room,
// on throwaway repos, with faked herdr/glab/hermes so no real Herdr session, ~/.hermes or Telegram is touched.
// Covers the doctor preflight (refusal before any side effect), the board brief in worker prompts and the host
// keepalive that extends a room whose invite is about to expire.
// Usage: node scripts/e2e/sprint.mjs <base> [helper]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "https://j01n.me";
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const orchestrator = fileURLToPath(new URL("../sprint.mjs", import.meta.url));
const tag = `w${Math.random().toString(36).slice(2, 7)}`;
const results = [];
const check = (label, ok, detail = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${String(detail).slice(0, 220)})` : ""}`); };
const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
const out = (cwd, argv, env) => execFileSync("node", argv, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const jso = (cwd, argv, env) => JSON.parse(out(cwd, argv, env));
const bad = (cwd, argv, env) => { try { out(cwd, argv, env); return ""; } catch (error) { return String(error.stderr || error.message); } };

// ── fakes: herdr, glab and hermes send are recorded, never real ────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), `sprint-${tag}-`));
const home = join(dir, "home");
const bin = join(dir, "bin");
const keys = join(dir, "keys");
const worktrees = join(dir, "wt");
const fakeState = join(dir, "fake-state");
const log = join(dir, "fake-log.jsonl");
const contractLog = join(dir, "contract.log");
for (const path of [home, bin, worktrees, fakeState]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(log, "");
const fake = (name, body) => {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst fs=require("fs"),P=require("path");\nconst rec=()=>fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({bin:"${name}",argv:process.argv.slice(2)})+"\\n");\nrec();\n${body}\n`);
  chmodSync(file, 0o755);
};
fake("herdr", `const argv=process.argv.slice(2);
const print=(value)=>console.log(JSON.stringify(value));
const flag=(name)=>argv[argv.indexOf(name)+1];
const counter=P.join(process.env.FAKE_STATE,"n");
const next=()=>{const value=Number(fs.existsSync(counter)?fs.readFileSync(counter,"utf8"):0)+1;fs.writeFileSync(counter,String(value));return value;};
if(argv[0]==="status"){
  console.log("client:\\n  version: 0.9.3\\nserver:\\n  status: "+(process.env.FAKE_HERDR_STATUS||"running")+"\\n  socket: /tmp/fake-herdr.sock");
} else if(argv[0]==="agent"&&argv[1]==="list"){
  print({id:"cli:agent:list",result:{agents:(process.env.FAKE_AGENTS||"").split(",").filter(Boolean).map((name,index)=>({name,agent:"pi",agent_status:"idle",pane_id:"w9:p"+(index+1),workspace_id:"w9"+(index+1),cwd:"/tmp/"+name}))}});
} else if(argv[0]==="workspace"&&argv[1]==="create"){
  const id="w9"+next(); const cwd=flag("--cwd");
  print({id:"cli:workspace:create",result:{workspace:{workspace_id:id,label:flag("--label"),cwd},tab:{tab_id:id+":t1"},root_pane:{pane_id:id+":p1",workspace_id:id,cwd}}});
} else if(argv[0]==="agent"&&argv[1]==="start"){
  print({id:"cli:agent:start",result:{agent:{name:argv[2],pane_id:flag("--pane"),agent:flag("--kind"),agent_status:"idle"}}});
} else if(argv[0]==="agent"&&argv[1]==="prompt"){
  print({id:"cli:agent:prompt",result:{submitted:true,pane_id:argv[2]}});
} else {
  print({id:"cli:fake",result:{ok:true,argv}});
}`);
fake("hermes", `const argv=process.argv.slice(2);
const file=argv[argv.indexOf("-f")+1];
if(!file||!fs.existsSync(file)){console.error("fake hermes: missing -f file");process.exit(1);}
fs.writeFileSync(P.join(process.env.FAKE_STATE,"invite.bin"),fs.readFileSync(file));
fs.writeFileSync(P.join(process.env.FAKE_STATE,"invite.target"),argv[argv.indexOf("-t")+1]||"");
console.log("sent");`);
fake("glab", `const argv=process.argv.slice(2);
console.log("Creating merge request for "+(argv[argv.indexOf("--source-branch")+1]||"?")+" into "+(argv[argv.indexOf("--target-branch")+1]||"main"));
console.log("https://gitlab.com/acme/sprint/-/merge_requests/42");`);

// ── helper wrapper: forwards to the real client and stands in for what other task branches own ──
// `extend` reaches the shipped client only when integration regenerates it, and the board `brief` field belongs to
// the spec-parser task. Both are answered here so the orchestrator contract (argv, sprint.json and prompts) is
// checked against this checkout instead of a branch that has not landed yet.
const briefFor = (id) => `BOARD BRIEF ${id}: change only the files the task lists, then report done with evidence.`;
const wrapper = join(dir, "helper-wrapper.cjs");
writeFileSync(wrapper, `const cp=require("child_process"),fs=require("fs");
const briefFor=${briefFor.toString()};
const argv=process.argv.slice(2);
const mask=(value)=>typeof value==="string"&&(value.includes("#")||value.length>60)?"<redacted>":value;
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({bin:"helper",argv:argv.map(mask)})+"\\n");
if(argv[0]==="extend"){const minutes=Number(argv[1]||5);console.log(JSON.stringify({ok:true,expires_at:new Date(Date.now()+minutes*60000).toISOString()}));process.exit(0);}
const r=cp.spawnSync(process.execPath,[process.env.E2E_REAL_HELPER,...argv],{encoding:"utf8",env:process.env});
let text=r.stdout||"";
if(argv[0]==="tasks"&&process.env.FAKE_TASK_BRIEFS){const ids=process.env.FAKE_TASK_BRIEFS.split(",");try{const parsed=JSON.parse(text);for(const task of parsed.tasks||[])if(ids.includes(task.id))task.brief=briefFor(task.id);text=JSON.stringify(parsed);}catch{}}
process.stdout.write(text);process.stderr.write(r.stderr||"");process.exit(r.status===null?1:r.status);\n`);
chmodSync(wrapper, 0o755);

// ── fixture repo: a throwaway checkout with a sprint spec and stubbed checks ───────────────────
const host = join(dir, "host");
mkdirSync(host);
git(dir, "init", "--bare", "-q", "remote.git");
git(host, "init", "-q");
git(host, "symbolic-ref", "HEAD", "refs/heads/main");
git(host, "remote", "add", "origin", join(dir, "remote.git"));
const put = (path, text) => { mkdirSync(join(host, dirname(path)), { recursive: true }); writeFileSync(join(host, path), text); };
put(".gitignore", "node_modules/\n.j01n-*.json\n.j01n-rooms/\n");
put("README.md", "# sprint fixture\n");
put("spec.md", `# Sprint ${tag}\n\nProve the orchestrator drives the whole host flow.\n\n## Tasks\n\n- t1 API module\n  files: src/api.ts\n- t2 UI module\n  files: src/ui.ts\n  depends: t1\n`);
for (const path of ["packages/helper/client/j01n.js", "packages/helper/src/client-script.ts", "apps/web/src/markdown-assets.ts", "packages/skill/src/skill.ts"]) put(path, "// generated v1\n");
put("scripts/generate-client-script.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";import{dirname}from"node:path";for(const f of["packages/helper/client/j01n.js","packages/helper/src/client-script.ts"]){mkdirSync(dirname(f),{recursive:true});writeFileSync(f,"// generated v2 client-script\\n");}\n');
put("scripts/generate-assets.mjs", 'import{mkdirSync,writeFileSync}from"node:fs";import{dirname}from"node:path";for(const f of["apps/web/src/markdown-assets.ts","packages/skill/src/skill.ts"]){mkdirSync(dirname(f),{recursive:true});writeFileSync(f,"// generated v2 assets\\n");}\n');
put("scripts/check-contract.mjs", 'import{appendFileSync}from"node:fs";appendFileSync(process.env.E2E_CONTRACT_LOG,"check-contract "+(process.argv.slice(2).join(" ")||"FULL")+"\\n");console.log("Contract check passed (fixture)");\n');
git(host, "add", "-A");
git(host, "commit", "-q", "-m", "Sprint fixture base");
git(host, "push", "-q", "origin", "HEAD:refs/heads/main");

const env = {
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  HOME: home,
  FAKE_LOG: log,
  FAKE_STATE: fakeState,
  E2E_CONTRACT_LOG: contractLog,
  E2E_REAL_HELPER: helper,
  FAKE_TASK_BRIEFS: "t1",
  J01N_KEY_DIR: keys,
  J01N_WORKTREE_ROOT: worktrees,
  BASE_URL: base,
  GIT_AUTHOR_NAME: "Sprint", GIT_AUTHOR_EMAIL: "sprint@example.com",
  GIT_COMMITTER_NAME: "Sprint", GIT_COMMITTER_EMAIL: "sprint@example.com",
};
// Workers keep their keys in their own worktree, exactly like a real seeded peer checkout.
const { J01N_KEY_DIR: _hostKeys, J01N_WORKTREE_ROOT: _hostWorktrees, ...workerEnv } = env;
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sprint = (...argv) => out(host, [orchestrator, ...argv, "--helper", wrapper], env);
const state = () => JSON.parse(readFileSync(join(keys, "sprint.json"), "utf8"));

// ── preflight: a refused start leaves no room, no state and no pane behind ─────────────────────
const badBin = join(dir, "bin-bad");
mkdirSync(badBin, { recursive: true, mode: 0o700 });
for (const [name, body] of [
  ["git", 'if(process.argv[2]==="--version"){console.log("git version 2.17.0");process.exit(0);}console.error("fake ancient git: no other subcommand works here");process.exit(1);'],
  ["herdr", 'console.error("fake herdr: could not connect to the socket at /tmp/fake-herdr.sock: connection refused");process.exit(1);'],
]) {
  const file = join(badBin, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst fs=require("fs"),P=require("path");\n${body}\n`);
  chmodSync(file, 0o755);
}
const refusals = [];
// Each case runs a real start against a scratch key directory, so a refusal proves itself by leaving nothing behind.
const refuse = (label, patterns, patch = {}, prepare) => {
  const keys2 = join(dir, `refuse-keys-${refusals.length}`);
  const state2 = join(keys2, "sprint.json");
  mkdirSync(keys2, { recursive: true, mode: 0o700 });
  if (prepare) prepare(keys2);
  const stderr = bad(host, [orchestrator, "start", "--spec", "spec.md", "--name", `refuse ${refusals.length} ${tag}`, "--workers", "1", "--host", `${tag}-refuse-${refusals.length}`, "--worker-prefix", tag, "--invite-to", "none", "--from", "main", "--state", state2, "--helper", wrapper], { ...env, J01N_KEY_DIR: keys2, ...patch });
  refusals.push({ state2, stderr });
  check(`${label}: refused before any side effect, one line per fix`, patterns.every((pattern) => pattern.test(stderr)), stderr.split("\n").filter(Boolean)[0] ?? "no refusal message");
};
refuse("git 2.17 and a dead herdr socket", [/preflight: git 2\.17 is older than 2\.25/, /preflight: "herdr status" did not answer/, /preflight refused with 3 problem\(s\)/], { PATH: `${badBin}${delimiter}${process.env.PATH}` });
refuse("a herdr server that is not running", [/preflight: herdr reports "status: stopped"/, /bring the Herdr server up/], { FAKE_HERDR_STATUS: "stopped" });
refuse("worktrees on /Volumes", [/preflight: the worktree root \/Volumes\/sprints is not usable/, /sprint worktrees cannot live on \/Volumes/, /set J01N_WORKTREE_ROOT to an absolute path on internal storage/], { J01N_WORKTREE_ROOT: "/Volumes/sprints" });
refuse("worker names already live in a workspace", [/preflight: worker name\(s\) .+-1 already run in a live Herdr workspace/, /--worker-prefix <fresh>/], { FAKE_AGENTS: `${tag}-1` });
refuse("another live room owns the key directory", [/preflight: 1 other room\(s\) are still active in/, /leave or close them so this sprint owns the directory/], {}, (keys2) => {
  // An unreachable host reads as "still alive" to the pointer probe, exactly like a room another sprint owns.
  mkdirSync(join(keys2, ".j01n-rooms"), { recursive: true, mode: 0o700 });
  writeFileSync(join(keys2, ".j01n-rooms", `${"f".repeat(64)}.json`), JSON.stringify({ room_url: "http://127.0.0.1:1/r/aaaa", participant_id: "other-room" }));
});
check("a refused start leaves no state file, no room and no pane behind",
  refusals.every((entry) => !existsSync(entry.state2)) && !calls().some((call) => call.argv[0] === "create") &&
  !calls().some((call) => call.bin === "herdr" && call.argv[0] === "workspace"), JSON.stringify(calls().map((call) => `${call.bin}:${call.argv[0]}`)));

// A pointer left over from an earlier wave must not make the new sprint ambiguous.
mkdirSync(join(keys, ".j01n-rooms"), { recursive: true, mode: 0o700 });
const staleUrl = `${base.replace(/\/$/, "")}/r/${createHash("sha256").update(tag).digest("hex").slice(0, 22)}`;
writeFileSync(join(keys, ".j01n-rooms", `${createHash("sha256").update(`${staleUrl}\0stale-bot`).digest("hex")}.json`), JSON.stringify({ room_url: staleUrl, participant_id: "stale-bot" }));

// ── start ──────────────────────────────────────────────────────────────────────────────────────
const started = sprint("start", "--spec", "spec.md", "--name", `e2e sprint ${tag}`, "--workers", "2", "--host", `${tag}-host`, "--worker-prefix", tag, "--invite-to", "telegram:e2e", "--from", "main", "--remote", "origin");
check("start prunes the stale room pointer before taking over the key directory", /Pruned 1 stale room pointer/.test(started));
const first = state();
const secret = first.invite_link?.split("#")[1] ?? "";
check("start creates and joins the sprint room as the configured host", first.host === `${tag}-host` && Boolean(first.room_id) && first.workers.length === 2, JSON.stringify({ room: first.room_id?.slice(0, 8), host: first.host }));
check("start pairs each worker with a task in dependency order", (first.workers ?? []).map((worker) => worker.task).join(",") === "t1,t2", JSON.stringify((first.workers ?? []).map((worker) => [worker.id, worker.task])));
check("start records the invite deadline the server handed back for the keepalive loop", Date.parse(first.expires_at ?? "") > Date.now(), JSON.stringify(first.expires_at));
check("start keeps each task's board brief in sprint.json", first.tasks?.find((task) => task.id === "t1")?.brief === briefFor("t1") &&
  !first.tasks?.find((task) => task.id === "t2")?.brief, JSON.stringify((first.tasks ?? []).map((task) => [task.id, task.brief ?? ""])));
const roomTasks = jso(host, [helper, "tasks"], env).tasks ?? [];
check("the sprint template seeded both tasks as open", roomTasks.length === 2 && roomTasks.every((task) => task.status === "open"), JSON.stringify(roomTasks.map((task) => [task.id, task.status])));
const [one, two] = first.workers;
check("start creates one worktree per worker on its own branch", existsSync(join(one.worktree, "spec.md")) && existsSync(join(two.worktree, "spec.md")) &&
  git(one.worktree, "rev-parse", "--abbrev-ref", "HEAD") === one.branch && git(two.worktree, "rev-parse", "--abbrev-ref", "HEAD") === two.branch, JSON.stringify({ branch: one.branch }));
check("start seeds exactly one worker identity file per worktree and leaves it clean",
  existsSync(join(one.worktree, `.j01n-agent-${one.id}.json`)) && existsSync(join(two.worktree, `.j01n-agent-${two.id}.json`)) &&
  !git(one.worktree, "status", "--porcelain", "--untracked-files=all") && !git(two.worktree, "status", "--porcelain", "--untracked-files=all"));
const herdrCalls = () => calls().filter((call) => call.bin === "herdr");
const made = herdrCalls().filter((call) => call.argv[0] === "workspace");
const prompts = herdrCalls().filter((call) => call.argv[0] === "agent" && call.argv[1] === "prompt");
check("herdr gets one new workspace per worker worktree, unfocused", made.length === 2 && made.every((call) => call.argv.includes("--no-focus")) &&
  made.map((call) => call.argv[call.argv.indexOf("--cwd") + 1]).join(" ") === `${one.worktree} ${two.worktree}`, JSON.stringify(made.map((call) => call.argv.slice(0, 5))));
// The pane env is what lets the session-start autojoin announce capabilities, so it must be there before turn one.
const paneEnvs = (call) => call.argv.reduce((acc, value, index) => (value === "--env" ? [...acc, call.argv[index + 1]] : acc), []);
check("each new workspace env carries the sprint capabilities so an autojoin announces them",
  made.length === 2 && made.every((call, index) => {
    const worker = first.workers[index];
    const values = paneEnvs(call);
    return values.includes(`J01N_WORKER=${worker.id}`) && values.includes(`J01N_TASK=${worker.task}`) &&
      values.includes("J01N_WORKER_CAPABILITIES=code,files") && values.some((entry) => entry.startsWith("BASE_URL="));
  }), JSON.stringify(made.map(paneEnvs)));
check("herdr starts the agent in each new pane", herdrCalls().filter((call) => call.argv[0] === "agent" && call.argv[1] === "start").length === 2);
check("each prompt states the exact listen command with capabilities", prompts.length === 2 && prompts[0].argv[3].includes(`/j01n listen ${one.id} --capabilities code,files`) && prompts[1].argv[3].includes(`/j01n listen ${two.id} --capabilities code,files`), prompts[0]?.argv[3]?.slice(0, 80));
check("the listen step is framed as the fallback after an autojoin, not the first move",
  prompts.every((call) => /Open with \/j01n tasks/.test(call.argv[3]) && call.argv[3].includes("must NOT run listen") &&
    /only when no room is joined run exactly: \/j01n listen/.test(call.argv[3])), prompts[0]?.argv[3]?.slice(0, 200));
check("each prompt carries that worker's task id", prompts.length === 2 && prompts[0].argv[3].includes("claim t1") && prompts[1].argv[3].includes("claim t2"));
// The board is the only thing a late joiner can read, so a briefed task is prompted from the board, not from chat.
check("a task with a board brief is prompted with that brief and its board key",
  prompts[0].argv[3].includes("board BRIEF for t1") && prompts[0].argv[3].includes("task.t1") && prompts[0].argv[3].includes(briefFor("t1")), prompts[0]?.argv[3]?.slice(0, 120));
check("a task without a brief still gets the sealed-spec reading step", !prompts[1].argv[3].includes(briefFor("t2")) &&
  /read the sealed BRIEF for t2 with \/j01n read/.test(prompts[1].argv[3]), prompts[1]?.argv[3]?.slice(0, 120));
check("prompts never carry the room link or join secret", !JSON.stringify(prompts).includes(secret) && !JSON.stringify(prompts).includes(first.room_url));
const delivered = readFileSync(join(fakeState, "invite.bin"));
check("the raw invite link is delivered as a byte-exact file body", delivered.equals(Buffer.from(first.invite_link)) && !delivered.toString().includes("\n") &&
  readFileSync(join(fakeState, "invite.target"), "utf8") === "telegram:e2e", delivered.toString().slice(0, 20) + "...");
check("no Hermes home config and no real send path is touched", !existsSync(join(home, ".hermes")));
check("start never prints the invite link or join secret", !started.includes(secret) && !started.includes(first.invite_link));

// ── workers: claim, commit, done through the real helper ───────────────────────────────────────
jso(one.worktree, [helper, "join", first.invite_link, one.id, "--no-workspace"], workerEnv);
jso(two.worktree, [helper, "join", first.invite_link, two.id, "--no-workspace"], workerEnv);
check("a worker claims its assigned task", (jso(one.worktree, [helper, "claim", "t1"], workerEnv).task ?? {}).owner === one.id);
check("claiming a dependent task before its dependency is done is refused", /t1/.test(bad(two.worktree, [helper, "claim", "t2"], workerEnv)));
mkdirSync(join(one.worktree, "src"), { recursive: true });
writeFileSync(join(one.worktree, "src", "api.ts"), "export const api = 1;\n");
git(one.worktree, "add", "-A");
git(one.worktree, "commit", "-q", "-m", "Add the API module");
const sha1 = git(one.worktree, "rev-parse", "HEAD");
jso(one.worktree, [helper, "done", "t1", "--summary", "API ready", "--commit", sha1, "--tests", "unit ok", "--contract", "pnpm check:contract --peer passed"], workerEnv);
check("a worker claims its task once the dependency is done", (jso(two.worktree, [helper, "claim", "t2"], workerEnv).task ?? {}).owner === two.id);
mkdirSync(join(two.worktree, "src"), { recursive: true });
writeFileSync(join(two.worktree, "src", "ui.ts"), "export const ui = 2;\n");
git(two.worktree, "add", "-A");
git(two.worktree, "commit", "-q", "-m", "Add the UI module");
const sha2 = git(two.worktree, "rev-parse", "HEAD");
jso(two.worktree, [helper, "done", "t2", "--summary", "UI ready", "--commit", sha2, "--tests", "unit ok", "--contract", "pnpm check:contract --peer passed"], workerEnv);

// ── status / answer ────────────────────────────────────────────────────────────────────────────
const ask = jso(one.worktree, [helper, "send", first.host, "Is t2 limited to src/ui.ts?", "--kind", "question", "--expect-reply"], workerEnv);
const line = sprint("status").trim();
check("status is one compact line covering tasks, the open ask and usage",
  !line.includes("\n") && line.includes(`t1:done@${one.id}`) && line.includes(`t2:done@${two.id}`) && line.includes("asks:1") && line.includes("usage:"), line);
check("finish refuses while an ask is unanswered", /unanswered/.test(bad(host, [orchestrator, "finish", "--reviewed", "--helper", helper], env)));
check("finish needs the explicit --reviewed authorization", /--reviewed/.test(bad(host, [orchestrator, "finish", "--helper", helper], env)));
check("answer replies in the ask thread", /answered/.test(sprint("answer", String(ask.seq), "Yes: src/ui.ts only.")));
check("the ask is closed by that reply in the room history", jso(host, [helper, "inbox"], env).some((message) => message.reply_to === ask.id && message.from === first.host));
check("status shows no unanswered asks afterwards", /asks:none/.test(sprint("status")));

// ── host keepalive: status extends a room whose invite is about to expire ────────────────────
const patchState = (patch) => writeFileSync(join(keys, "sprint.json"), JSON.stringify({ ...state(), ...patch }, null, 2), { mode: 0o600 });
const extendCalls = () => calls().filter((call) => call.bin === "helper" && call.argv[0] === "extend");
patchState({ expires_at: new Date(Date.now() + 40 * 60_000).toISOString() });
const healthy = sprint("status").trim();
check("status leaves a healthy invite alone and reports the time left", /keepalive:40m left/.test(healthy) && extendCalls().length === 0, healthy);
patchState({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
const kept = sprint("status").trim();
check("status extends through the helper while under 15 minutes are left",
  /keepalive:extended, 30m left/.test(kept) && extendCalls().length === 1 && extendCalls()[0].argv.includes(String(30)), kept);
check("the new deadline is written back so the next status sees a healthy invite",
  Date.parse(state().expires_at ?? "") > Date.now() + 25 * 60_000 && !/EXTEND FAILED/.test(sprint("status")) && extendCalls().length === 1, state().expires_at);
check("keepalive keeps status on one compact line", !kept.includes("\n") && kept.split(" | ").length >= 6, kept);
patchState({ expires_at: "" });
check("an unknown deadline is treated as urgent, not silently skipped", /keepalive:/.test(sprint("status")) && extendCalls().length === 2, state().expires_at);

// ── finish ─────────────────────────────────────────────────────────────────────────────────────
const integration = `sprint/${(first.room_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12)}`;
const plan = sprint("finish", "--dry-run");
check("finish --dry-run plans the rebase chain, full check and merge request", /Plan: rebase t1@/.test(plan) && /-> t2@/.test(plan) && /check-contract/.test(plan) && /open MR/.test(plan), plan.slice(0, 180));
check("finish --dry-run changes nothing", !git(host, "branch", "--list", integration) && git(one.worktree, "rev-parse", one.branch) === sha1 && git(two.worktree, "rev-parse", two.branch) === sha2);
const finished = sprint("finish", "--reviewed");
const after = state();
check("finish rebases every task branch in dependency order", Object.keys(after.finish?.rebased ?? {}).join(",") === "t1,t2" &&
  git(two.worktree, "merge-base", "--is-ancestor", after.finish.rebased.t1, two.branch) === "" &&
  git(host, "rev-list", "--count", "--merges", `origin/main..${after.finish.branch}`) === "0", JSON.stringify(after.finish?.rebased));
check("finish fast-forwards one integration branch holding both task commits", git(host, "rev-parse", "--abbrev-ref", "HEAD") === after.finish.branch &&
  after.finish.branch === integration && git(host, "log", "--format=%s", "origin/main..HEAD").includes("Add the UI module"));
check("finish regenerates client-script and assets in their own commit", git(host, "log", "--format=%s", "HEAD~1..HEAD") === "Regenerate sprint integration outputs" &&
  readFileSync(join(host, "packages/helper/client/j01n.js"), "utf8").includes("generated v2"));
const contractRows = readFileSync(contractLog, "utf8").trim().split("\n").filter(Boolean);
check("finish ran the FULL contract check, never --peer", contractRows.length === 1 && contractRows[0] === "check-contract FULL", JSON.stringify(contractRows));
check("finish pushed the integration branch to the remote", (git(host, "ls-remote", "origin", `refs/heads/${after.finish.branch}`).split(/\s+/)[0] ?? "") === after.finish.pushed);
check("finish opened the merge request through glab", after.finish.mr === "https://gitlab.com/acme/sprint/-/merge_requests/42" &&
  calls().some((call) => call.bin === "glab" && call.argv.includes("--source-branch") && call.argv.includes(after.finish.branch) &&
    call.argv[call.argv.indexOf("--target-branch") + 1] === "main"), JSON.stringify(after.finish.mr));
check("finish records the host integration decision in the room", /decisions:1/.test(sprint("status")), sprint("status").trim());
check("finish leaves the room open for owner review", /stays open/.test(finished) && (jso(host, [helper, "tasks"], env).tasks ?? []).length === 2);
check("a second finish repeats no irreversible work", /merge request/.test(sprint("finish", "--reviewed")) &&
  calls().filter((call) => call.bin === "glab").length === 1 && readFileSync(contractLog, "utf8").trim().split("\n").filter(Boolean).length === 1 &&
  /decisions:1/.test(sprint("status")));

// ── crash-resume: start again against the same state file ──────────────────────────────────────
const resumed = sprint("start", "--spec", "spec.md", "--name", `e2e sprint ${tag}`, "--workers", "2", "--host", `${tag}-host`, "--worker-prefix", tag, "--invite-to", "telegram:e2e", "--from", "main", "--remote", "origin");
check("start resumes the recorded room instead of creating a second one", state().room_id === first.room_id && /Resuming sprint/.test(resumed));
check("resume repeats no side effects", herdrCalls().filter((call) => call.argv[0] === "workspace").length === 2 &&
  calls().filter((call) => call.bin === "hermes").length === 1 && jso(host, [helper, "tasks"], env).tasks.every((task) => task.status === "done"));

console.log(results.every(Boolean) ? "SPRINT FLOW OK" : "SPRINT FLOW FAILED");
if (!results.every(Boolean)) process.exitCode = 1;
