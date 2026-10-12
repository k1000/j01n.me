// Host keepalive (scripts/sprint.mjs status): the decision comes off the decrypted board, not the clock. These run the
// real orchestrator against a stub helper - no room server, no workerd - and read back both the one-line status report
// and the calls it made, so the extend cadence, the hourly notice and the stop on an idle board are all executable here.
// The stub answers exactly the verbs status uses (summary, inbox, usage) plus the two the keepalive needs (extend, send)
// and appends every argv it saw, which is what makes "repeated ticks do not spam the room" a checkable claim.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const orchestrator = join(root, "scripts/sprint.mjs");
const STUB = `const fs=require("fs");
const argv=process.argv.slice(2);
fs.appendFileSync(process.env.KEEPALIVE_LOG,JSON.stringify(argv)+"\\n");
const board=JSON.parse(process.env.KEEPALIVE_BOARD||"[]");
const print=(value)=>process.stdout.write(JSON.stringify(value));
const ahead=(minutes)=>new Date(Date.now()+minutes*60000).toISOString();
if(argv[0]==="summary"){print({tasks:board,participants:[{id:"host-bot",role:"host"}],decisions:[],notes:[],report:null});return;}
if(argv[0]==="inbox"){print([]);return;}
if(argv[0]==="usage"){print({rows:[],totals:{},reported:0,lines:[]});return;}
if(argv[0]==="extend"){print({ok:true,extended_ms:Number(argv[1])*60000,expires_at:ahead(Number(argv[1]))});return;}
if(argv[0]==="send"){print({ok:true,seq:1});return;}
process.stderr.write("keepalive stub: unhandled "+argv.join(" ")+"\\n");process.exit(1);
`;
const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title: id, files: [`src/${id}.ts`], depends_on: [], status, ...extra });
const minute = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "j01n-keepalive-"));
  const stateFile = join(dir, "sprint.json");
  const log = join(dir, "calls.jsonl");
  const stub = join(dir, "stub-j01n.cjs");
  writeFileSync(stub, STUB);
  writeFileSync(log, "");
  const write = (state: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({
    version: 1, room_id: "keepalive-check", room_url: "http://127.0.0.1:1/r/keepalive-check", state_file: stateFile,
    host_checkout: root, keys_dir: dir, helper: stub, base: "http://127.0.0.1:1", host: "host-bot", name: "keepalive check",
    workers: [], tasks: [], expires_at: minute(60), ...state,
  }, null, 2), { mode: 0o600 });
  const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, string>;
  // One duty-loop tick: the board is what status decrypts, so the test hands it over the same channel the stub reads.
  const status = (board: unknown[]) => {
    const out = execFileSync("node", [orchestrator, "status", "--state", stateFile, "--helper", stub], {
      cwd: root, encoding: "utf8", env: { ...process.env, KEEPALIVE_LOG: log, KEEPALIVE_BOARD: JSON.stringify(board), J01N_KEY_DIR: dir },
    });
    return out.trim().split("\n").at(-1) ?? "";
  };
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const extended = () => calls().filter((argv) => argv[0] === "extend");
  const noticed = () => calls().filter((argv) => argv[0] === "send" && String(argv[2] ?? "").startsWith("host keepalive:"));
  return { dir, write, state, status, extended, noticed };
}

describe("sprint host keepalive", () => {
  const live = [task("t1", "open"), task("t2", "claimed", { owner: "worker-2" }), task("t3", "blocked", { blocked_by: ["t2"] })];
  const done = [task("t1", "done", { owner: "worker-1" }), task("t2", "done", { owner: "worker-2" }), task("t3", "done", { owner: "worker-3" })];

  it("extends a live board by 60 minutes and announces the deadline the server returned", () => {
    const room = harness();
    room.write({ expires_at: minute(40), last_extend_at: minute(-11) });
    const line = room.status(live);
    expect(line).toMatch(/keepalive:extended to \d{4}-\d{2}-\d{2}T\S+, 60m left, activity:open 1 claimed 1 blocked 1 done 0, noticed/);
    expect(room.extended()).toEqual([["extend", "60"]]);
    expect(room.noticed()).toHaveLength(1);
    expect(String(room.noticed()[0]?.[2] ?? "")).toMatch(/^host keepalive: room extended to \d{4}-\d{2}-\d{2}T\S+, activity:open 1 claimed 1 blocked 1 done 0$/);
    // Crash-safe: the deadline, the tick stamp and the notice stamp are all in sprint.json before the send.
    expect(new Date(room.state().expires_at).getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);
    expect(Date.parse(room.state().last_extend_at)).toBeLessThanOrEqual(Date.now());
    expect(Number.isFinite(Date.parse(room.state().keepalive_notice_at))).toBe(true);
  }, 30_000);

  it("leaves a topped-up invite alone inside the same tick", () => {
    const room = harness();
    room.write({ expires_at: minute(40) });
    expect(room.status(live)).toMatch(/keepalive:extended/);
    const line = room.status(live);
    expect(line).toMatch(/keepalive:live, \d+m left, activity:open 1 claimed 1 blocked 1 done 0/);
    expect(room.extended()).toHaveLength(1);
    expect(room.noticed()).toHaveLength(1);
  }, 30_000);

  it("keeps topping the invite up on every tick without repeating the room notice", () => {
    const room = harness();
    room.write({ expires_at: minute(40), last_extend_at: minute(-11) });
    room.status(live);
    // Two more ticks: the notice stamp survives in sprint.json, so the room hears it once per hour, not per tick.
    room.write({ expires_at: minute(35), last_extend_at: minute(-11), keepalive_notice_at: room.state().keepalive_notice_at });
    room.status(live);
    room.write({ expires_at: minute(30), last_extend_at: minute(-11), keepalive_notice_at: room.state().keepalive_notice_at });
    const third = room.status(live);
    expect(third).toMatch(/keepalive:extended/);
    expect(third).not.toMatch(/, noticed/);
    expect(room.extended()).toHaveLength(3);
    expect(room.noticed()).toHaveLength(1);
    // Once the hour is over, the next tick does announce again.
    room.write({ expires_at: minute(30), last_extend_at: minute(-11), keepalive_notice_at: minute(-61) });
    expect(room.status(live)).toMatch(/, noticed/);
    expect(room.noticed()).toHaveLength(2);
    expect(String(room.noticed()[1]?.[2] ?? "")).toMatch(/activity:open 1 claimed 1 blocked 1 done 0$/);
  }, 30_000);

  it("tops an invite that is about to lapse immediately, and treats a lost deadline as urgent", () => {
    const room = harness();
    room.write({ expires_at: minute(4), last_extend_at: minute(0) });
    expect(room.status(live)).toMatch(/keepalive:extended/);
    expect(room.extended()).toHaveLength(1);
    room.write({ expires_at: "", last_extend_at: minute(0) });
    expect(room.status(live)).toMatch(/keepalive:extended/);
    expect(room.extended()).toHaveLength(2);
  }, 30_000);

  it("stops extending an all-done board so the idle room expires naturally", () => {
    const room = harness();
    room.write({ expires_at: minute(0), last_extend_at: minute(-11) });
    const line = room.status(done);
    expect(line).toMatch(/keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 3, all done, integration still owed; the room may expire/);
    expect(room.extended()).toEqual([]);
    expect(room.noticed()).toEqual([]);
  }, 30_000);

  it("calls a done and integrated board finished for keepalive purposes", () => {
    const room = harness();
    room.write({ expires_at: minute(0), last_extend_at: minute(-11), finish: { pushed: "0123456789abcdef", mr: "http://gitlab.invalid/-/merge_requests/1" } });
    expect(room.status(done)).toMatch(/keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 3, integrated; the room may expire/);
    expect(room.extended()).toEqual([]);
  }, 30_000);

  it("treats a board with no task keys as zero open work", () => {
    const room = harness();
    room.write({ expires_at: minute(0), last_extend_at: minute(-11) });
    expect(room.status([])).toMatch(/keepalive:stopped, activity:open 0 claimed 0 blocked 0 done 0, empty board; the room may expire/);
    expect(room.extended()).toEqual([]);
  }, 30_000);

  it("keeps status a single compact line whatever the keepalive decides", () => {
    const room = harness();
    room.write({ expires_at: minute(40), last_extend_at: minute(-11) });
    for (const board of [live, done, []]) {
      const line = room.status(board);
      expect(line.includes("\n")).toBe(false);
      expect(line.split(" | ").length).toBeGreaterThanOrEqual(6);
    }
  }, 30_000);
});
