// Sprint orchestrator flow end-to-end: scripts/sprint.mjs start/status/answer/finish against a real room,
// on throwaway repos, with faked herdr/glab/hermes so no real Herdr session, ~/.hermes or Telegram is touched.
// Covers the doctor preflight (refusal before any side effect), the board brief in worker prompts, the host
// keepalive that tops the invite up from status while the decrypted board still holds live work (and stops once the
// board is done and integrated, so idle rooms expire on their own), the opt-in --ui-tester wiring: inbox identity,
// private snake_case profile in the keys dir, one python pane, the role recorded in sprint.json and shown by status,
// and the --roster modes: auto offers each open role-tagged task to a free pane announcing that role (shown by the
// status routed column), manual leaves claiming to the workers, off says nothing, and an offer nobody took up is
// handed back to the board by finish. The verdict watch (a compare.verdict that buries a done task becomes a ROUTED
// prompt, and on roster:auto a refine child) is covered by fixture messages and a stub helper: it needs no room and
// no workerd, so `--decision` runs that part alone.
// Usage: node scripts/e2e/sprint.mjs <base> [helper] | node scripts/e2e/sprint.mjs --decision
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { verdictRework } from "../sprint.mjs";

// The verdict fixtures need no room, and the live flow must never be entered by accident: `--decision` is a mode, not
// a base URL.
const flags = process.argv.slice(2);
const decisionOnly = flags.includes("--decision");
const positional = flags.filter((value) => !value.startsWith("--"));
const base = positional[0] ?? "https://j01n.me";
const helper = positional[1] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
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
} else if(argv[0]==="pane"&&argv[1]==="run"){
  print({id:"cli:pane:run",result:{ok:true,pane_id:argv[2],command:argv.slice(3)}});
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
// `extend` reaches the shipped client only when integration regenerates it, the board `brief` field belongs to the
// spec-parser task, `assign` belongs to the SDK/CLI task and `unassign` to the CLI board task. All four are answered
// here so the orchestrator contract (argv, sprint.json, prompts and routing) is checked against this checkout instead
// of a branch that has not landed. The board writes go straight to the room API with the participant token this keys
// directory holds - the same PUT client.setBoardKey makes.
const briefFor = (id) => `BOARD BRIEF ${id}: change only the files the task lists, then report done with evidence.`;
const wrapper = join(dir, "helper-wrapper.cjs");
const wrapperSource = `
const cp=require("child_process"),fs=require("fs"),P=require("path");
const briefFor=${briefFor.toString()};
const argv=process.argv.slice(2);
const mask=(value)=>typeof value==="string"&&(value.includes("#")||value.length>60)?"<redacted>":value;
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({bin:"helper",argv:argv.map(mask)})+"\\n");
if(argv[0]==="extend"){const minutes=Number(argv[1]||5);console.log(JSON.stringify({ok:true,expires_at:new Date(Date.now()+minutes*60000).toISOString()}));process.exit(0);}
const safe=(value)=>value.replace(/[^a-zA-Z0-9_-]/g,"_");
// Resolved lazily: a room-create call runs through this wrapper before any pointer exists in the keys directory.
const room=()=>{const dir=P.join(process.env.J01N_KEY_DIR||".",".j01n-rooms");const name=fs.readdirSync(dir).find((n)=>/^[a-f0-9]{64}\\.json$/.test(n));if(!name)throw Error("no active room pointer in "+dir);return JSON.parse(fs.readFileSync(P.join(dir,name),"utf8"));};
const api=async(method,path,body)=>{
  const roomInfo=room();
  const token=JSON.parse(fs.readFileSync(P.join(process.env.J01N_KEY_DIR,".j01n-"+safe(new URL(roomInfo.room_url).pathname)+"-"+safe(roomInfo.participant_id)+".json"),"utf8")).participantToken;
  const response=await fetch(roomInfo.room_url+path,{method,headers:Object.assign({authorization:"Bearer "+token},body===undefined?{}:{"content-type":"application/json"}),body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  if(!response.ok){process.stderr.write("helper-wrapper: room API "+method+" "+path+" -> "+response.status+" "+text+"\\n");process.exit(1);}
  return text;
};
const callerId=()=>room().participant_id;
const readEntry=async(key)=>JSON.parse(await api("GET","/board")).board[key];
const writeEntry=(key,value,version)=>api("PUT","/board/"+encodeURIComponent(key)+(version===undefined?"":"?if_version="+version),value);
const forward=()=>{
  const r=cp.spawnSync(process.execPath,[process.env.E2E_REAL_HELPER,...argv],{encoding:"utf8",env:process.env});
  let text=r.stdout||"";
  if(argv[0]==="tasks"&&process.env.FAKE_TASK_BRIEFS){const ids=process.env.FAKE_TASK_BRIEFS.split(",");try{const parsed=JSON.parse(text);for(const task of parsed.tasks||[])if(ids.includes(task.id))task.brief=briefFor(task.id);text=JSON.stringify(parsed);}catch{}}
  process.stdout.write(text);process.stderr.write(r.stderr||"");process.exitCode=r.status===null?1:r.status;
};
(async()=>{
  // assign writes the board exactly the way the SDK/CLI verb defines it: claimed, owned, and the verb's own marks the
  // orchestrator reads back for its routed column and its unaccepted-offer check.
  if(argv[0]==="assign"){
    const [id,worker,...reason]=argv.slice(1);
    const key="task."+id;
    const current=await readEntry(key);
    if(!current){process.stderr.write("assign: no "+key+" on the board\\n");process.exit(1);}
    process.stdout.write(await writeEntry(key,{...current.value,status:"claimed",owner:worker,assigned:worker,assigned_by:callerId(),assigned_at:new Date().toISOString(),assigned_reason:reason.join(" ")},current.version));
    return;
  }
  // unassign is the host-side inverse the CLI board task adds: an offer nobody took goes back to open, every
  // assignment marker is dropped and the note the host passed survives in assigned_reason.
  if(argv[0]==="unassign"){
    const [id,...note]=argv.slice(1);
    const key="task."+id;
    const current=await readEntry(key);
    if(!current){process.stderr.write("unassign: no "+key+" on the board\\n");process.exit(1);}
    if(!current.value.assigned_by){process.stderr.write("unassign: task "+id+" was not assigned\\n");process.exit(1);}
    if(current.value.evidence){process.stderr.write("unassign: task "+id+" has evidence\\n");process.exit(1);}
    const {owner,assigned,assigned_by,assigned_at,assigned_reason,...rest}=current.value;
    process.stdout.write(await writeEntry(key,{...rest,status:"open",...(note.length?{assigned_reason:note.join(" ")}:{})},current.version));
    return;
  }
  forward();
})().catch((error)=>{process.stderr.write("helper-wrapper: "+String(error&&error.message||error)+"\\n");process.exit(1);});
`;
writeFileSync(wrapper, wrapperSource);
// The stand-in must be valid JavaScript and must not need the board verbs this checkout's client does not dispatch.
execFileSync(process.execPath, ["--check", wrapper], { stdio: ["ignore", "ignore", "pipe"] });
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

// ── verdict watch: a losing compare verdict on a done task becomes rework ────────────────────────
// No room and no workerd: the tick's input is fixture messages shaped exactly as packages/sdk/src/room-commands.ts
// writes them (compare.request {a,b,criteria}, compare.verdict {of,winner,reason}), and the room itself is a stub
// helper that records every argv it saw. That makes the whole decision checkable here: the ROUTED prompt a manual
// roster owes the host, the refine call an auto roster runs itself, the once-only stamp in sprint.json, and the fact
// that a verdict which buries nobody (a tie, an unknown candidate, a task already refined) leaves the board alone.
const vKeys = join(dir, "verdict-keys");
mkdirSync(vKeys, { recursive: true, mode: 0o700 });
const vStateFile = join(vKeys, "sprint.json");
const vLog = join(vKeys, "calls.jsonl");
writeFileSync(vLog, "");
const vStub = join(dir, "verdict-stub.cjs");
writeFileSync(vStub, `const fs=require("fs");
const argv=process.argv.slice(2);
fs.appendFileSync(process.env.VERDICT_LOG,JSON.stringify(argv)+"\\n");
const print=(value)=>process.stdout.write(JSON.stringify(value));
const tasks=JSON.parse(process.env.VERDICT_TASKS||"[]");
const team=JSON.parse(process.env.VERDICT_TEAM||"[]");
const messages=JSON.parse(process.env.VERDICT_MESSAGES||"[]");
if(argv[0]==="summary"){print({tasks,participants:team,decisions:[],notes:[],report:null,reservations:[]});return;}
if(argv[0]==="inbox"){print(messages);return;}
if(argv[0]==="usage"){print({rows:[],totals:{},reported:0,lines:[]});return;}
if(argv[0]==="extend"){print({ok:true,expires_at:new Date(Date.now()+3600000).toISOString()});return;}
if(argv[0]==="send"){print({ok:true,seq:1});return;}
if(argv[0]==="refine"){if(process.env.VERDICT_NO_REFINE){process.stderr.write("unknown command: refine\\n");process.exit(1);}
  const parent=argv[1];print({task:{id:parent+"r1",title:"refine "+parent+": the verdict buried it",status:"open",depends_on:[parent],role:"builder",needs:["shell"]}});return;}
process.stderr.write("verdict stub: unhandled "+argv.join(" ")+"\\n");process.exit(1);
`);
execFileSync(process.execPath, ["--check", vStub], { stdio: ["ignore", "ignore", "pipe"] });
// One done task whose evidence commit is the losing candidate, plus the claim that keeps its worker honest.
const vDone = { id: "t2", title: "UI module", files: ["src/ui.ts"], depends_on: [], status: "done", owner: "w1", needs: ["shell"], evidence: { commits: ["0123456789abcdef"], tests: "unit ok" } };
const vClaimed = { id: "t1", title: "API module", files: ["src/api.ts"], depends_on: [], status: "claimed", owner: "w2", needs: ["shell"] };
const vRequest = { id: "req-7", seq: 7, from: "w2", intent: "compare.request", body: { a: "row style", b: "0123456789abcdef stacked dl", criteria: ["scope"] } };
const vVerdict = (over = {}) => ({ id: "ver-9", seq: 9, from: "w2", intent: "compare.verdict", body: { of: "req-7", winner: "A", reason: "the row keeps the contract" }, ...over });
const vFree = { id: "w1", state: "free", capabilities: ["code", "shell"] };
const vBusy = { id: "w2", state: "working", capabilities: ["code", "shell"] };
const vCalls = () => readFileSync(vLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
/** One duty-loop tick over one fixture board. `again` re-reads the sprint.json the previous tick wrote. */
function vTick(label, { tasks = [vDone, vClaimed], messages = [vRequest, vVerdict()], team = [vFree, vBusy], workers = [{ id: "w1", task: "t2" }, { id: "w2", task: "t1" }], roster = "manual", again = false, noRefine = false } = {}) {
  if (!again) writeFileSync(vStateFile, JSON.stringify({
    version: 1, room_id: "verdict-watch", room_url: "http://127.0.0.1:1/r/verdict-watch", state_file: vStateFile,
    host_checkout: host, keys_dir: vKeys, helper: vStub, base: "http://127.0.0.1:1", host: "host-bot", name: label,
    workers, tasks, expires_at: new Date(Date.now() + 3_000_000).toISOString(), last_extend_at: new Date().toISOString(),
    roster: { mode: roster, source: "flag", why: "fixture" },
  }, null, 2), { mode: 0o600 });
  const before = vCalls().length;
  const room = {
    VERDICT_LOG: vLog, VERDICT_TASKS: JSON.stringify(tasks), VERDICT_TEAM: JSON.stringify(team), VERDICT_MESSAGES: JSON.stringify(messages),
    ...(noRefine ? { VERDICT_NO_REFINE: "1" } : {}),
  };
  let text = "";
  try { text = out(host, [orchestrator, "status", "--state", vStateFile, "--helper", vStub], { ...env, J01N_KEY_DIR: vKeys, ...room }); } catch (error) { text = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
  return { text, calls: vCalls().slice(before), state: JSON.parse(readFileSync(vStateFile, "utf8")) };
}
const vRefines = (list) => list.filter((argv) => argv[0] === "refine");
const vAnnounces = (list) => list.filter((argv) => argv[0] === "send" && /Sprint verdict/.test(String(argv[2] ?? "")));
const ROUTED = /^ROUTED verdict: row style over 0123456789abcdef stacked dl — refine with: j01n refine t2 --from 9$/m;

const vManual = vTick("verdict manual");
check("a verdict burying a done task's commit prints the ROUTED refine prompt",
  ROUTED.test(vManual.text) && /\| verdicts:1 rework:t2#9 /.test(vManual.text) && vManual.text.trim().split("\n").length === 2, vManual.text.trim());
check("roster:manual never runs the refine verb itself, it hands the host the command",
  vRefines(vManual.calls).length === 0 && !/claim t2r1/.test(vManual.text), JSON.stringify(vManual.calls));
const vManualAgain = vTick("verdict manual", { again: true });
check("a manual prompt repeats every tick until the board carries the child, because nothing else remembers it",
  ROUTED.test(vManualAgain.text) && vRefines(vManualAgain.calls).length === 0, vManualAgain.text.trim().split("\n")[0]);

const vAuto = vTick("verdict auto", { roster: "auto", team: [vFree, { ...vBusy, state: "free" }] });
check("roster:auto with one free pane that answers the parent's needs runs the refine verb itself",
  vRefines(vAuto.calls).length === 1 && vRefines(vAuto.calls)[0].join(" ") === "refine t2 --from 9",
  JSON.stringify(vRefines(vAuto.calls)));
check("the refine the tick ran names the winner, the loser, the parent, the child and the free pane in the room",
  vAnnounces(vAuto.calls).length === 1 && /^Sprint verdict \(roster:auto\): row style over 0123456789abcdef stacked dl — t2 refined as t2r1; w1 is free and answers its needs; claim t2r1 to rebuild\.$/.test(String(vAnnounces(vAuto.calls)[0][2])),
  String(vAnnounces(vAuto.calls)[0]?.[2] ?? ""));
check("the tick records the verdict it asked about in sprint.json, parent, seq, worker and child included",
  vAuto.state.refines?.["ver-9"]?.parent === "t2" && vAuto.state.refines["ver-9"].seq === 9 &&
    vAuto.state.refines["ver-9"].child === "t2r1" && vAuto.state.refines["ver-9"].worker === "w1",
  JSON.stringify(vAuto.state.refines));
check("the auto tick shows the prompt it acted on and what came of it",
  ROUTED.test(vAuto.text) && /t2 refined as t2r1/.test(vAuto.text), vAuto.text.trim());
const vAutoAgain = vTick("verdict auto", { roster: "auto", team: [vFree, { ...vBusy, state: "free" }], again: true });
check("a second auto tick asks about the same verdict once only, however many ticks read it",
  vRefines(vAutoAgain.calls).length === 0 && /verdicts:1 rework:none/.test(vAutoAgain.text) &&
    vAutoAgain.state.refines["ver-9"].child === "t2r1", JSON.stringify({ line: vAutoAgain.text.trim(), refines: vAutoAgain.state.refines }));
const vNoWorker = vTick("verdict auto no free pane", { roster: "auto", team: [{ ...vFree, state: "working" }, vBusy] });
check("roster:auto with no free pane still prompts the host and asks nobody to rebuild",
  ROUTED.test(vNoWorker.text) && vRefines(vNoWorker.calls).length === 0 && vAnnounces(vNoWorker.calls).length === 0,
  JSON.stringify(vNoWorker.calls));
const vNoCapable = vTick("verdict auto uncapable", { roster: "auto", team: [{ ...vFree, capabilities: ["code"] }, vBusy] });
check("a free pane that does not answer the parent's needs is not handed the rebuild",
  ROUTED.test(vNoCapable.text) && vRefines(vNoCapable.calls).length === 0, JSON.stringify(vNoCapable.calls));
const vSilent = vTick("verdict none", { messages: [] });
check("no verdict, no call and no prompt: the tick says so in one compact line",
  !/ROUTED/.test(vSilent.text) && vRefines(vSilent.calls).length === 0 && /verdicts:0 rework:none/.test(vSilent.text) &&
    vSilent.text.trim().split("\n").length === 1, vSilent.text.trim());
const vTie = vTick("verdict tie", { messages: [vRequest, vVerdict({ body: { of: "req-7", winner: "tie", reason: "both stand" } })] });
check("a draw buries nobody, so nothing is rework", !/ROUTED/.test(vTie.text) && /verdicts:1 rework:none/.test(vTie.text) && vRefines(vTie.calls).length === 0, vTie.text.trim());
const vUntraceable = { ...vRequest, id: "req-8", seq: 8, body: { a: "0123456789abcdef stacked dl", b: "a branch nobody reported", criteria: ["scope"] } };
const vUnknown = vTick("verdict unknown candidate", { messages: [vUntraceable, vVerdict({ id: "ver-10", seq: 10, body: { of: "req-8", winner: "A", reason: "the named option is the done one" } })] });
check("a verdict whose loser maps to no done task is counted, not routed", /verdicts:1 rework:none/.test(vUnknown.text) && !/ROUTED/.test(vUnknown.text) && vRefines(vUnknown.calls).length === 0, vUnknown.text.trim());
const vChild = vTick("verdict already refined", { tasks: [vDone, vClaimed, { id: "t2r1", title: "refine t2: the verdict buried it", files: ["src/ui.ts"], depends_on: ["t2"], status: "open", role: "builder", needs: ["shell"] }] });
check("a verdict the board already turned into a refine child says nothing twice",
  !/ROUTED/.test(vChild.text) && /verdicts:1 rework:none/.test(vChild.text) && vRefines(vChild.calls).length === 0, vChild.text.trim());
const vNoVerb = vTick("verdict without the verb", { roster: "auto", team: [vFree, { ...vBusy, state: "free" }], noRefine: true });
check("a helper build with no refine verb is reported, never faked, and the host keeps the by-hand command",
  ROUTED.test(vNoVerb.text) && vRefines(vNoVerb.calls).length === 1 && /was not refined.*run it by hand: j01n refine t2 --from 9/.test(vNoVerb.text) &&
    vNoVerb.state.refines["ver-9"].child === null && vAnnounces(vNoVerb.calls).length === 0,
  vNoVerb.text.trim().split("\n").slice(-2).join(" | "));
const vNoVerbAgain = vTick("verdict without the verb", { roster: "auto", team: [vFree, { ...vBusy, state: "free" }], noRefine: true, again: true });
check("a failed refine is not retried every tick, and the prompt the host still owes keeps printing",
  vRefines(vNoVerbAgain.calls).length === 0 && ROUTED.test(vNoVerbAgain.text) && /verdicts:1 rework:t2#9/.test(vNoVerbAgain.text),
  vNoVerbAgain.text.trim().split("\n").slice(0, 2).join(" | ") + " | " + JSON.stringify(vNoVerbAgain.state.refines));

// The same decision read straight off the function. The ticks above prove the wiring (prompt, call, stamp, announce);
// these prove the vocabulary - what counts as a named candidate, what counts as already refined, what counts as a
// verdict that decides nothing - without one subprocess per case.
const vRework = (over = {}) => verdictRework({
  messages: over.messages ?? [vRequest, vVerdict()],
  tasks: over.tasks ?? [vDone, vClaimed],
  participants: over.participants ?? [vFree, vBusy],
  workers: over.workers ?? [{ id: "w1", task: "t2" }, { id: "w2", task: "t1" }],
  roster: over.roster ?? "manual", seen: over.seen ?? {},
});
const manualDecision = vRework();
check("the decision carries the verdict's own words: winner, loser, the done task it maps to and the seq to refine from",
  manualDecision.decisions.length === 1 && manualDecision.verdicts === 1 &&
    manualDecision.decisions[0].winner === "row style" && manualDecision.decisions[0].loser === "0123456789abcdef stacked dl" &&
    manualDecision.decisions[0].taskId === "t2" && manualDecision.decisions[0].seq === 9 &&
    manualDecision.decisions[0].action === "route" && manualDecision.decisions[0].worker === "",
  JSON.stringify(manualDecision.decisions));
const autoRework = () => vRework({ roster: "auto", participants: [vFree, { ...vBusy, state: "free" }] });
check("on auto the same fixture yields the refine action with the free pane that answers the needs picked",
  autoRework().decisions[0].action === "refine" && autoRework().decisions[0].worker === "w1",
  JSON.stringify(autoRework().decisions[0]));
const asked = vRework({ roster: "auto", participants: [vFree, { ...vBusy, state: "free" }], seen: { "ver-9": { child: "t2r1" } } }).decisions[0];
check("a verdict sprint.json already asked about decides nothing further",
  asked.action === "none" && /refined as t2r1/.test(asked.reason), JSON.stringify(asked));
const shortSha = vRework({
  messages: [{ ...vRequest, body: { a: "row style", b: "01234567 the UI module retry", criteria: ["scope"] } }, vVerdict({ body: { of: "req-7", winner: "A", reason: "the retry lost the contract" } })],
}).decisions[0];
check("an abbreviated sha in the losing candidate still maps to the task that reported it",
  shortSha.taskId === "t2" && shortSha.action === "route" && /j01n refine t2 --from 9/.test(shortSha.line), JSON.stringify(shortSha));
const lowercase = vRework({
  messages: [{ ...vRequest, body: { a: "0123456789abcdef stacked dl", b: "row style", criteria: ["scope"] } }, vVerdict({ body: { of: "req-7", winner: "b", reason: "the row keeps the contract" } })],
}).decisions[0];
check("a verdict written in lower case decides exactly like the canonical one the verb sends",
  lowercase.winner === "row style" && lowercase.loser === "0123456789abcdef stacked dl" &&
    lowercase.taskId === "t2" && lowercase.action === "route", JSON.stringify(lowercase));
const vDoneApi = { ...vClaimed, status: "done", evidence: { commits: ["cc3333cc44444444"], tests: "unit ok" } };
const vBoth = { ...vRequest, body: { a: "0123456789abcdef stacked dl", b: "the UI module or the API module", criteria: ["scope"] } };
const ambiguous = vRework({ messages: [vBoth, vVerdict({ body: { of: "req-7", winner: "A", reason: "both names are on the board" } })], tasks: [vDone, vDoneApi] }).decisions[0];
check("a candidate naming two done tasks at once maps to neither and says nothing",
  ambiguous.action === "none" && ambiguous.taskId === "" && /names t1 and t2 at once/.test(ambiguous.reason) && !ambiguous.line,
  JSON.stringify(ambiguous));
const orphan = vRework({ messages: [vVerdict({ body: { of: "req-404", winner: "A", reason: "the request is out of the read window" } })] });
check("a verdict whose request the room cannot answer decides nothing, but is still counted",
  orphan.decisions.length === 0 && orphan.verdicts === 1, JSON.stringify(orphan));
check("no verdict in the room is no decision at all", vRework({ messages: [] }).decisions.length === 0 && vRework({ messages: [] }).verdicts === 0);
// The watch repeats the room's compare vocabulary rather than importing it, so a drift on either side has to fail here:
// these are the exact literals packages/sdk/src/room-commands.ts writes for a request and its verdict.
const compareSource = readFileSync(fileURLToPath(new URL("../../packages/sdk/src/room-commands.ts", import.meta.url)), "utf8");
check("the SDK still spells the intents and bodies the verdict watch decrypts",
  compareSource.includes('COMPARE_INTENTS = { request: "compare.request", verdict: "compare.verdict" }') &&
    compareSource.includes('{ a, b, criteria }, { intent: COMPARE_INTENTS.request') &&
    compareSource.includes('{ of: target, winner, reason }, { intent: COMPARE_INTENTS.verdict') &&
    compareSource.includes('COMPARE_WINNERS = ["A", "B", "tie"]'),
  compareSource.split("\n").filter((line) => /COMPARE_(INTENTS|WINNERS)/.test(line)).join(" | ").slice(0, 200));

if (decisionOnly) {
  console.log(results.every(Boolean) ? "SPRINT VERDICT DECISIONS OK" : "SPRINT VERDICT DECISIONS FAILED");
  process.exit(results.every(Boolean) ? 0 : 1);
}

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
const refuse = (label, patterns, patch = {}, prepare, extra = []) => {
  const keys2 = join(dir, `refuse-keys-${refusals.length}`);
  const state2 = join(keys2, "sprint.json");
  mkdirSync(keys2, { recursive: true, mode: 0o700 });
  if (prepare) prepare(keys2);
  const stderr = bad(host, [orchestrator, "start", "--spec", "spec.md", "--name", `refuse ${refusals.length} ${tag}`, "--workers", "1", "--host", `${tag}-refuse-${refusals.length}`, "--worker-prefix", tag, "--invite-to", "none", "--from", "main", "--state", state2, "--helper", wrapper, ...extra], { ...env, J01N_KEY_DIR: keys2, ...patch });
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
// The tester pane boots into a fixed script and cwd, so a missing pair must be caught before a room is wasted. The
// problem count is 2 or 3 depending on whether the machine running this check has python3 at all.
refuse("--ui-tester without its tester script or pane cwd", [/preflight: ui-tester script not found/, /preflight: the ui-tester pane cwd .+ is not a directory/, /preflight refused with [23] problem\(s\)/],
  { J01N_UI_TESTER_SCRIPT: join(dir, "no-such-tester.py"), J01N_UI_TESTER_CWD: join(dir, "no-such-cwd") }, undefined, ["--ui-tester"]);
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

// ── host keepalive: an all-done board stops extending so an idle room expires on its own ────────
// The live-work half of the loop (a claimed task keeps the invite topped, one room notice per hour, no announce
// spam between ticks) runs in its own room at the end of this file: the room here has already finished both tasks,
// so status must NOT keep it alive - not even when the recorded deadline is missing or about to lapse.
const patchState = (patch) => writeFileSync(join(keys, "sprint.json"), JSON.stringify({ ...state(), ...patch }, null, 2), { mode: 0o600 });
const extendCalls = () => calls().filter((call) => call.bin === "helper" && call.argv[0] === "extend");
const keepaliveNotices = () => jso(one.worktree, [helper, "inbox"], workerEnv)
  .filter((message) => message.from === first.host)
  .map((message) => String(message.text ?? message.body?.text ?? ""))
  .filter((text) => text.startsWith("host keepalive:"));
patchState({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), last_extend_at: "" });
const idle = sprint("status").trim();
check("status stops extending a board whose work is all done, whatever the invite window says",
  /keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 2, all done, integration still owed; the room may expire/.test(idle) && extendCalls().length === 0, idle);
patchState({ expires_at: "" });
check("an unknown deadline still does not extend an idle board (crash-safe, no announce either)",
  /keepalive:stopped/.test(sprint("status")) && extendCalls().length === 0 && keepaliveNotices().length === 0, state().expires_at);
check("keepalive keeps status on one compact line", !idle.includes("\n") && idle.split(" | ").length >= 6, idle);

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
// Integrated and nothing left to do: the keepalive stays stopped, so this room now expires on its own schedule.
patchState({ expires_at: new Date(Date.now() + 30_000).toISOString(), last_extend_at: "" });
const afterFinish = sprint("status").trim();
check("a done and integrated board stops the keepalive instead of topping it up forever",
  /keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 2, integrated; the room may expire/.test(afterFinish) &&
    extendCalls().length === 0 && keepaliveNotices().length === 0, afterFinish);

// ── crash-resume: start again against the same state file ──────────────────────────────────────
const resumed = sprint("start", "--spec", "spec.md", "--name", `e2e sprint ${tag}`, "--workers", "2", "--host", `${tag}-host`, "--worker-prefix", tag, "--invite-to", "telegram:e2e", "--from", "main", "--remote", "origin");
check("start resumes the recorded room instead of creating a second one", state().room_id === first.room_id && /Resuming sprint/.test(resumed));
check("resume repeats no side effects", herdrCalls().filter((call) => call.argv[0] === "workspace").length === 2 &&
  calls().filter((call) => call.bin === "hermes").length === 1 && jso(host, [helper, "tasks"], env).tasks.every((task) => task.status === "done"));

// ── --ui-tester: one non-git participant, its private profile in the keys dir, one python pane ─────
// The wiring is opt-in, so the plain sprint above proves the default: no role worker, no extra pane, no profile.
check("a start without --ui-tester records no role peer, no profile and no python pane",
  first.workers.every((worker) => !worker.role) && herdrCalls().filter((call) => call.argv[0] === "pane").length === 0 &&
  !existsSync(join(keys, "ui-tester-profile.json")), JSON.stringify(first.workers.map((worker) => worker.id)));
const orchestratorSource = readFileSync(orchestrator, "utf8");
check("the ui-tester defaults to the ui-tester role, the host tester script, its pane cwd and a 20s poll",
  orchestratorSource.includes('const UI_TESTER_ROLE = "ui-tester";') &&
  orchestratorSource.includes('const UI_TESTER_SCRIPT = "/home/ubuntu/.hermes/scripts/j01n_ui_tester.py";') &&
  orchestratorSource.includes('const UI_TESTER_CWD = "/home/ubuntu/.hermes/j01n";') &&
  orchestratorSource.includes('option("--ui-tester-name", UI_TESTER_ROLE)') &&
  orchestratorSource.includes("const UI_TESTER_INTERVAL = 20;") &&
  orchestratorSource.includes('"python3", plan.script') && orchestratorSource.includes('"--interval", String(plan.interval)'));
const testerDir = join(dir, "tester-cwd");
mkdirSync(testerDir, { recursive: true, mode: 0o700 });
const testerScript = join(dir, "j01n_ui_tester.py");
writeFileSync(testerScript, "#!/usr/bin/env python3\n# fake tester: the pane start is recorded against fakes, never run\n");
// Agent inbox names are global and first-come-first-served, so the check runs its tester under a throwaway name.
const uiName = `${tag}-ui`;
const uiArgs = ["start", "--spec", "spec.md", "--name", `e2e sprint ${tag}`, "--workers", "2", "--host", `${tag}-host`, "--worker-prefix", tag,
  "--invite-to", "none", "--from", "main", "--remote", "origin", "--ui-tester", "--ui-tester-name", uiName];
const uiRun = (extra = []) => out(host, [orchestrator, ...uiArgs, ...extra, "--helper", wrapper], { ...env, J01N_UI_TESTER_SCRIPT: testerScript, J01N_UI_TESTER_CWD: testerDir });
const paneRuns = () => herdrCalls().filter((call) => call.argv[0] === "pane" && call.argv[1] === "run");
const testerPanes = () => herdrCalls().filter((call) => call.argv[0] === "workspace" && call.argv[call.argv.indexOf("--cwd") + 1] === testerDir);
const helperCalls = (command, who) => calls().filter((call) => call.bin === "helper" && call.argv[0] === command && (who ? call.argv.includes(who) : true));
const uiCounts = () => [helperCalls("register", uiName).length, helperCalls("invite", uiName).length, helperCalls("join", uiName).length, testerPanes().length, paneRuns().length].join(",");
const uiStarted = uiRun();
const uiState = state();
const ui = uiState.workers.at(-1);
const profileFile = join(keys, `${uiName}-profile.json`);
const profile = JSON.parse(readFileSync(profileFile, "utf8"));
const uiSecret = (uiState.invite_link ?? "").split("#")[1] ?? "";
check("--ui-tester registers the inbox identity into the keys dir and invites it by name",
  existsSync(join(keys, `.j01n-agent-${uiName}.json`)) && helperCalls("register", uiName).length === 1 &&
  helperCalls("invite", uiName).some((call) => call.argv[1] === uiState.host), JSON.stringify(helperCalls("register", uiName).map((call) => call.argv)));
check("--ui-tester joins the room in its own name and announces the ui-tester role without a workspace",
  helperCalls("join", uiName).length === 1 && helperCalls("join", uiName)[0].argv.includes("--no-workspace") &&
  helperCalls("join", uiName)[0].argv.slice(-2).join(" ") === "--role ui-tester", JSON.stringify(helperCalls("join", uiName).map((call) => call.argv)));
const uiTeam = () => (jso(host, [helper, "team", profileFile, uiName], env).team ?? []);
check("the ui-tester is a room participant with the announced role",
  uiTeam().some((peer) => peer.id === uiName && peer.role === "ui-tester"), JSON.stringify(uiTeam().map((peer) => [peer.id, peer.role ?? ""])));
check("the tester profile is the snake_case room profile, private and without the join secret",
  Object.keys(profile).sort().join(",") === "access,participant_id,participant_token" && profile.access === uiState.room_url &&
  profile.participant_id === uiName && String(profile.participant_token ?? "").length > 8 && !profile.access.includes("#") &&
  (statSync(profileFile).mode & 0o777) === 0o600, JSON.stringify({ keys: Object.keys(profile), access: profile.access?.slice(0, 24) }));
// The join would leave a second active-room pointer in the keys dir; the host's own bare helper calls need exactly one.
check("the keys dir keeps one unambiguous room pointer after the tester joined",
  readdirSync(join(keys, ".j01n-rooms")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length === 1,
  JSON.stringify(readdirSync(join(keys, ".j01n-rooms"))));
check("the tester gets one unfocused pane in the tester cwd that reads its keys from the sprint's keys dir",
  testerPanes().length === 1 && testerPanes()[0].argv.includes("--no-focus") &&
  testerPanes()[0].argv[testerPanes()[0].argv.indexOf("--label") + 1] === uiName &&
  paneEnvs(testerPanes()[0]).includes(`J01N_KEY_DIR=${keys}`) && paneEnvs(testerPanes()[0]).some((value) => value.startsWith("BASE_URL=")) &&
  paneEnvs(testerPanes()[0]).some((value) => value.startsWith("J01N_HELPER=")), JSON.stringify(testerPanes().map(paneEnvs)));
check("herdr starts the python tester in that pane with the profile path and a 20s interval",
  paneRuns().length === 1 && paneRuns()[0].argv[2] === ui.pane_id &&
  paneRuns()[0].argv.slice(3).join(" ") === `python3 ${testerScript} --profile ${profileFile} --interval 20`, JSON.stringify(paneRuns().map((call) => call.argv)));
check("sprint.json records the tester among the workers with its role and no task",
  ui.id === uiName && ui.role === "ui-tester" && ui.task === null && ui.started === true && Boolean(ui.pane_id) &&
  Boolean(ui.workspace_id) && ui.profile === profileFile && uiState.workers.slice(0, 2).every((worker) => !worker.role), JSON.stringify(ui));
check("status shows the recorded ui-tester", new RegExp(`roles:ui-tester=${uiName}`).test(sprint("status")), sprint("status").trim());
check("the wiring neither prints nor panes a room credential",
  !uiStarted.includes(uiSecret) && !uiStarted.includes(uiState.invite_link) && !JSON.stringify(paneRuns()).includes(uiSecret) &&
  !JSON.stringify(paneRuns()).includes(profile.participant_token) && !JSON.stringify(ui).includes(profile.participant_token) &&
  !JSON.stringify(uiState.workers.slice(0, 2)).includes(profile.participant_token), uiStarted.split("\n").slice(-2)[0]?.slice(0, 90));
const uiBefore = uiCounts();
const uiAgain = (() => { try { return uiRun(); } catch (error) { return `ERROR ${String(error.stderr || error.message)}`; } })();
check("a resumed --ui-tester start repeats no register, invite, join or pane",
  /Resuming sprint/.test(uiAgain) && state().room_id === uiState.room_id && state().workers.at(-1).pane_id === ui.pane_id &&
  uiCounts() === uiBefore, `${uiBefore} != ${uiCounts()} | ${uiAgain.slice(0, 160)}`);
check("status still reads the room with the tester wired in", new RegExp(`roles:ui-tester=${uiName}`).test(sprint("status")), sprint("status").trim());

// ── --roster: who puts a task in front of a pane ──────────────────────────────────────────────
// auto = the host offers each open task carrying a role to a joined, free pane announcing that role; manual = the
// workers claim off the board (the historical flow); off = no routing and no routed column. A role-tagged room makes
// the default auto, so the flag only overrides what the room already says. Each case owns a keys directory, because
// the helper needs exactly one active room pointer per directory. Task values are read back through the shipped
// `tasks` verb: the board itself is the routing record, so nothing here needs a board read of its own.
put("spec-roster.md", `# Sprint ${tag} roster\n\nProve the roster modes route tasks to panes.\n\n## Tasks\n\n- t1 API module\n  files: src/api.ts\n  role: builder\n- t2 UI module\n  files: src/ui.ts\n  role: builder\n- t3 Audit pass\n  files: docs/audit.md\n  role: auditor\n`);
git(host, "add", "spec-roster.md");
git(host, "commit", "-q", "-m", "Roster spec fixture");
const rosterRoot = join(dir, "roster");
mkdirSync(rosterRoot, { recursive: true });
const assignLog = () => calls().filter((call) => call.bin === "helper" && call.argv[0] === "assign").map((call) => call.argv.join(" "));
const unassignLog = () => calls().filter((call) => call.bin === "helper" && call.argv[0] === "unassign").map((call) => call.argv.join(" "));
function rosterCase(label) {
  const keys3 = join(rosterRoot, label);
  const env3 = { ...env, J01N_KEY_DIR: keys3, J01N_WORKTREE_ROOT: join(rosterRoot, `wt-${label}`) };
  mkdirSync(keys3, { recursive: true, mode: 0o700 });
  const state3 = () => JSON.parse(readFileSync(join(keys3, "sprint.json"), "utf8"));
  const run3 = (argv, helperArg) => out(host, [orchestrator, ...argv, "--helper", helperArg], env3);
  return {
    state: state3,
    host: () => state3().host,
    task: (id) => (jso(host, [helper, "tasks"], env3).tasks ?? []).find((task) => task.id === id) ?? {},
    status: () => run3(["status"], wrapper).trim(),
    // A worker pane joins for itself and announces the role its panes answer to.
    join: (worker, role) => jso(worker.worktree, [helper, "join", state3().invite_link, worker.id, "--no-workspace", ...(role ? ["--role", role] : [])], workerEnv),
    // A pane that holds a claim is busy: the real claim verb reserves its files and takes the task off the board.
    claim: (worker, id) => jso(worker.worktree, [helper, "claim", id], workerEnv).task,
    // Room-wide findings are read through a joined worker: the host does not receive its own announcements.
    notes: (worker) => jso(worker.worktree, [helper, "inbox"], workerEnv)
      .filter((message) => message.from === state3().host)
      .map((message) => String(message.text ?? message.body?.text ?? ""))
      .filter((text) => /rout|assign/i.test(text)).map((text) => text.slice(0, 120)),
    start: (workers, prefix, extra, helperArg = wrapper) => run3(["start", "--spec", "spec-roster.md", "--name", `roster ${label} ${tag}`, "--workers", String(workers),
      "--host", `${tag}${label}-host`, "--worker-prefix", prefix, "--invite-to", "none", "--from", "main", ...extra], helperArg),
    // Keepalive is the host's own loop: it patches the case's sprint.json and reads the room through a joined worker.
    patch: (patch) => writeFileSync(join(keys3, "sprint.json"), JSON.stringify({ ...state3(), ...patch }, null, 2), { mode: 0o600 }),
    notices: (worker) => jso(worker.worktree, [helper, "inbox"], workerEnv)
      .filter((message) => message.from === state3().host)
      .map((message) => String(message.text ?? message.body?.text ?? ""))
      .filter((text) => text.startsWith("host keepalive:")),
    report: (worker, id) => jso(worker.worktree, [helper, "done", id, "--summary", `${id} done on the fake board`, "--commit", "0123456",
      "--tests", "unit ok", "--contract", "pnpm check:contract --peer passed"], workerEnv).task,
    drop: (id) => jso(host, [helper, "board_delete", `task.${id}`], env3),
    // finish always refuses here (the tasks are unfinished), so both streams of that refusal carry the routing report.
    attempt: (argv, helperArg = wrapper) => { try { return { ok: true, text: run3(argv, helperArg) }; } catch (error) { return { ok: false, text: `${error.stdout ?? ""}${error.stderr ?? ""}` }; } },
  };
}

const autoCase = rosterCase("auto");
const autoStart = autoCase.start(2, `${tag}ra`, ["--roster", "auto"]);
const [autoOne, autoTwo] = autoCase.state().workers;
check("roster:auto is recorded in sprint.json with the reason it chose it", autoCase.state().roster.mode === "auto" && autoCase.state().roster.source === "flag", JSON.stringify(autoCase.state().roster));
check("roster:auto has nothing to offer before a single worker joined",
  /roster:auto \(--roster flag\)/.test(autoStart) && assignLog().length === 0 && !autoStart.includes("routed to") && autoCase.task("t1").status === "open",
  autoStart.split("\n").filter((line) => line.startsWith("roster:")).join(" | "));
autoCase.join(autoOne, "builder");
autoCase.join(autoTwo, "builder");
check("a worker takes a builder task off the board for real", autoCase.claim(autoOne, "t2").owner === autoOne.id && autoCase.task("t2").status === "claimed", autoOne.id);
const autoRouted = autoCase.start(2, `${tag}ra`, ["--roster", "auto"]);
check("roster:auto skips the pane that already holds a claim and offers the idle one",
  new RegExp(`t1 routed to ${autoTwo.id} \\(role: builder\\)`).test(autoRouted) && assignLog().length === 1 &&
    assignLog()[0].split(" ").slice(0, 3).join(" ") === `assign t1 ${autoTwo.id}` && assignLog()[0].includes("roster:auto"),
  JSON.stringify({ log: autoRouted.split("\n").filter((line) => /rout/i.test(line)), assigns: assignLog() }));
check("the offer lands on the board the way the assign verb writes it: claimed, owned and marked",
  autoCase.task("t1").status === "claimed" && autoCase.task("t1").owner === autoTwo.id && autoCase.task("t1").assigned === autoTwo.id &&
    autoCase.task("t1").assigned_by === autoCase.host() && /roster:auto/.test(String(autoCase.task("t1").assigned_reason ?? "")),
  JSON.stringify([autoCase.task("t1").status, autoCase.task("t1").owner, autoCase.task("t1").assigned, autoCase.task("t1").assigned_by]));
check("an unmatched role leaves its task open and says so", /t3 has no free auditor pane; left open/.test(autoRouted) && autoCase.task("t3").status === "open",
  autoRouted.split("\n").filter((line) => line.startsWith("roster:auto:")).join(" | "));
const autoRepeat = autoCase.start(2, `${tag}ra`, ["--roster", "auto"]);
check("a third auto start repeats no offer to a pane that already holds one", assignLog().length === 1 && !autoRepeat.includes("routed to"), JSON.stringify(assignLog()));
check("status gains the routed column mapping the task to the worker it was handed to", new RegExp(`routed:t1@${autoTwo.id}`).test(autoCase.status()), autoCase.status());
check("the routing offer is announced to the room once", autoCase.notes(autoTwo).filter((text) => /Sprint routing/.test(text)).length === 1, JSON.stringify(autoCase.notes(autoTwo)));
const noVerb = autoCase.attempt(["finish", "--reviewed"], helper);
check("finish on a helper build without the unassign verb reports the stuck offer instead of faking a release",
  /every task needs done evidence/.test(noVerb.text) && /no unassign verb/.test(noVerb.text) && assignLog().length === 1 && unassignLog().length === 0 &&
    autoCase.task("t1").status === "claimed" && !autoCase.state().assigns.t1.released,
  noVerb.text.split("\n").filter((line) => /roster|evidence/.test(line)).join(" | "));
const autoFinish = autoCase.attempt(["finish", "--reviewed"]);
check("finish releases the offer nobody accepted back to open, keeping the note on the task",
  /every task needs done evidence.*t1:open/.test(autoFinish.text) && unassignLog().length === 1 && /^unassign t1 /.test(unassignLog()[0]) &&
    autoCase.task("t1").status === "open" && autoCase.task("t1").owner === undefined && autoCase.task("t1").assigned === undefined &&
    autoCase.task("t1").assigned_by === undefined && /not accepted/.test(String(autoCase.task("t1").assigned_reason ?? "")) &&
    Boolean(autoCase.state().assigns.t1.released),
  JSON.stringify({ call: unassignLog(), task: autoCase.task("t1") }));
check("finish says in the room that it released the unaccepted assign", autoCase.notes(autoTwo).some((text) => /released the unaccepted assign/.test(text)),
  JSON.stringify(autoCase.notes(autoTwo)));
check("a released task is no longer shown as routed and the worker's own claim stands", /routed:none/.test(autoCase.status()) && autoCase.task("t2").status === "claimed", autoCase.status());

const defaultCase = rosterCase("default");
const defaultFirst = defaultCase.start(1, `${tag}rb`, []);
check("a room with no role-tagged worker defaults to manual and offers nothing",
  /roster:manual \(no worker announces a role an open task asks for\)/.test(defaultFirst) && assignLog().length === 1 &&
    defaultCase.state().roster.source === "default" && defaultCase.task("t1").status === "open",
  defaultFirst.split("\n").filter((line) => line.startsWith("roster:")).join(" | "));
const [defaultOne] = defaultCase.state().workers;
defaultCase.join(defaultOne, "builder");
const defaultAgain = defaultCase.start(1, `${tag}rb`, []);
check("once a worker announces a matching role the same flagless start routes with it",
  /roster:auto \(role-tagged workers in the room\)/.test(defaultAgain) && new RegExp(`t1 routed to ${defaultOne.id} \\(role: builder\\)`).test(defaultAgain) &&
    assignLog().length === 2 && defaultCase.state().roster.mode === "auto" && defaultCase.task("t1").assigned === defaultOne.id,
  JSON.stringify({ call: assignLog()[1], log: defaultAgain.split("\n").filter((line) => line.startsWith("roster:") || line.includes("routed to")) }));
check("status shows a defaulted offer exactly like an explicit one", new RegExp(`routed:t1@${defaultOne.id}`).test(defaultCase.status()), defaultCase.status());

const manualCase = rosterCase("manual");
manualCase.start(2, `${tag}rc`, ["--roster", "manual"]);
const [manualOne, manualTwo] = manualCase.state().workers;
manualCase.join(manualOne, "builder");
manualCase.join(manualTwo, "builder");
const manualRun = manualCase.start(2, `${tag}rc`, ["--roster", "manual"]);
check("roster:manual leaves every claim to the workers even with two matching free panes",
  /roster:manual \(--roster flag\)/.test(manualRun) && !manualRun.includes("routed to") && assignLog().length === 2 &&
    manualCase.task("t1").status === "open" && manualCase.task("t2").status === "open" && Object.keys(manualCase.state().assigns ?? {}).length === 0,
  JSON.stringify({ log: manualRun.split("\n").filter((line) => line.startsWith("roster:")), assigns: assignLog().slice(2) }));
check("manual still reports the routed column, empty until the board carries an assignment", /routed:none/.test(manualCase.status()), manualCase.status());
const offRun = manualCase.start(2, `${tag}rc`, ["--roster", "off"]);
check("roster:off routes nothing and logs nothing about routing", !/roster:|routed/i.test(offRun) && assignLog().length === 2,
  offRun.split("\n").filter((line) => /roster|rout/i.test(line)).join(" | "));
check("roster:off drops the routed column from status entirely", !manualCase.status().includes("routed"), manualCase.status());

// ── host keepalive while work is live: extend per tick, one room notice per hour ───────────────
// The other half of the loop needs a board with live work, so it gets its own room: three open tasks, a real claim,
// and the fake `extend` the wrapper answers for the shipped client. What the host must never do is keep a finished
// room alive forever, or read the room the same announcement every 10 minutes.
const keepCase = rosterCase("keep");
keepCase.start(1, `${tag}rd`, ["--roster", "manual"]);
const keepOne = keepCase.state().workers[0];
keepCase.join(keepOne);
const keepExtend = () => calls().filter((call) => call.bin === "helper" && call.argv[0] === "extend");
const keepNotices = () => keepCase.notices(keepOne);
const minuteAhead = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
// A tick that already ran, with the deadline still far out: report the live board, spend no extend.
keepCase.patch({ expires_at: minuteAhead(58), last_extend_at: minutesAgo(2) });
const toppedUp = keepCase.status();
check("a live board topped up this tick reports the time left instead of hammering extend",
  /keepalive:live, 58m left, activity:open 3 claimed 0 blocked 0 done 0/.test(toppedUp) && keepExtend().length === 0, toppedUp);
// The duty-loop tick itself: 60 minutes more invite, the deadline and the tick stamp in sprint.json, one notice.
keepCase.patch({ last_extend_at: minutesAgo(11) });
const firstTick = keepCase.status();
check("a tick of status extends a live board by 60 minutes through the helper",
  keepExtend().length === 1 && keepExtend()[0].argv.join(" ") === "extend 60" &&
    /keepalive:extended to \S+, 60m left, activity:open 3 claimed 0 blocked 0 done 0, noticed/.test(firstTick), firstTick);
check("the extend writes the deadline, the tick stamp and the notice stamp back to sprint.json (crash-safe)",
  Date.parse(keepCase.state().expires_at) > Date.now() + 55 * 60_000 &&
    Date.parse(keepCase.state().last_extend_at) > Date.now() - 60_000 &&
    Number.isFinite(Date.parse(keepCase.state().keepalive_notice_at)), JSON.stringify({ expires: keepCase.state().expires_at, last: keepCase.state().last_extend_at, noticed: keepCase.state().keepalive_notice_at }));
const notices = keepNotices();
check("the keepalive notice names the new deadline and the board counts once",
  notices.length === 1 && /^host keepalive: room extended to \d{4}-\d{2}-\d{2}T\S+, activity:open 3 claimed 0 blocked 0 done 0$/.test(notices[0]), JSON.stringify(notices));
// Later ticks keep topping the invite up, and say nothing.
keepCase.patch({ expires_at: minuteAhead(40), last_extend_at: minutesAgo(11) });
const secondTick = keepCase.status();
keepCase.patch({ last_extend_at: minutesAgo(11) });
const thirdTick = keepCase.status();
check("repeated ticks extend again to keep the room topped without repeating the notice",
  keepExtend().length === 3 && /keepalive:extended/.test(secondTick) && /keepalive:extended/.test(thirdTick) &&
    !/, noticed/.test(thirdTick) && keepNotices().length === 1, JSON.stringify({ line: thirdTick, notices: keepNotices().length }));
// A claimed task is live work, and the counts in the line follow the board.
keepCase.claim(keepOne, "t1");
keepCase.patch({ expires_at: minuteAhead(40), last_extend_at: minutesAgo(11) });
const claimedTick = keepCase.status();
check("a board with a claimed task keeps the invite topped and shows the claim in the counts",
  keepExtend().length === 4 && /activity:open 2 claimed 1 blocked 0 done 0/.test(claimedTick), claimedTick);
// A deadline inside the tick window is topped immediately, whatever the last tick stamped.
keepCase.patch({ expires_at: minuteAhead(4) });
const urgentTick = keepCase.status();
check("an invite about to lapse is topped at once, not left for the next tick",
  keepExtend().length === 5 && /keepalive:extended/.test(urgentTick) && Date.parse(keepCase.state().expires_at) > Date.now() + 55 * 60_000, urgentTick);
// The hourly cadence: past an hour since the last notice, the next tick announces once more.
keepCase.patch({ expires_at: minuteAhead(40), last_extend_at: minutesAgo(11), keepalive_notice_at: minutesAgo(61) });
const hourlyTick = keepCase.status();
check("the notice comes once an hour, not once a tick", keepNotices().length === 2 && /, noticed/.test(hourlyTick), JSON.stringify(keepNotices()));
// Everything done: the loop stops, so the room is free to expire, and it says what is still owed.
for (const id of ["t1", "t2", "t3"]) {
  if (keepCase.task(id).status !== "done") { if (keepCase.task(id).status !== "claimed") keepCase.claim(keepOne, id); keepCase.report(keepOne, id); }
}
const extendBeforeDone = keepExtend().length;
keepCase.patch({ expires_at: minuteAhead(3), last_extend_at: minutesAgo(11) });
const doneBoard = keepCase.status();
check("an all-done board stops extending so the idle room expires naturally",
  keepExtend().length === extendBeforeDone &&
    /keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 3, all done, integration still owed; the room may expire/.test(doneBoard), doneBoard);
keepCase.patch({ finish: { pushed: "0123456789abcdef", mr: "https://gitlab.example/sprint/-/merge_requests/7" }, expires_at: minuteAhead(2) });
check("a done and integrated board says the room may expire and spends no extend",
  keepExtend().length === extendBeforeDone && /keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 3, integrated; the room may expire/.test(keepCase.status()), keepCase.status());
for (const id of ["t1", "t2", "t3"]) keepCase.drop(id);
check("a board with no task keys at all is zero open work: nothing to keep alive",
  keepExtend().length === extendBeforeDone && /keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 0, empty board; the room may expire/.test(keepCase.status()), keepCase.status());

console.log(results.every(Boolean) ? "SPRINT FLOW OK" : "SPRINT FLOW FAILED");
if (!results.every(Boolean)) process.exitCode = 1;