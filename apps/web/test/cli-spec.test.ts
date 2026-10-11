import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openRoomSeal, openUsage, usageKey } from "@j01n/sdk";

const exec = promisify(execFile);
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  if (req.url === "/rooms") {
    calls.push(body);
    res.end(JSON.stringify({ intro: "intro", next_step: "join", room_id: "room-1", room: { name: "sprint", purpose: "sprint", host_id: "host", max_participants: 8 }, join_secret: "secret", room_url: `http://127.0.0.1:${port}/r/room-1`, api: {}, skill: "skill", expires_at: new Date(Date.now() + 60_000).toISOString() }));
  } else if (req.url === "/r/room-1/participants/host" || req.url === "/r/room-1/participants/peer") {
    res.end(JSON.stringify({ ok: true, cursor: 0, participant_token: "token" }));
  } else if (req.url === "/r/room-1/participants") {
    res.end(JSON.stringify({ participants: [] }));
  } else if (req.url === "/r/room-1/asks") {
    res.end(JSON.stringify({ asks: [] }));
  } else if (req.url === "/r/room-1/board") {
    res.end(JSON.stringify({ board: { kickoff: { value: { rules: ["claim before editing"] }, version: 1 } }, board_schema: null }));
  } else if (req.url?.startsWith("/r/room-1/?") && req.method === "GET") {
    const kickoff = calls.find((call) => call.intent === "kickoff");
    res.end(JSON.stringify({ cursor: 1, messages: kickoff ? [{ id: "kickoff", seq: 1, from: "host", to: "all", intent: "kickoff", body: kickoff.body }] : [] }));
  } else if (req.url === "/r/room-1" && req.method === "POST") {
    calls.push(body);
    res.end(JSON.stringify({ ok: true, id: "kickoff", seq: 1 }));
  } else { res.statusCode = 404; res.end("not found"); }
});
let port: number;
const calls: Record<string, unknown>[] = [];
afterEach(async () => { calls.length = 0; if (server.listening) await new Promise<void>((done) => server.close(() => done())); });

it("CLI create --spec sends only tasks in plaintext and seals the complete kickoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "j01n-spec-cli-"));
  const spec = "# Goal (private)\n\n## Tasks\n- T1 Build\n  files: src/build.ts\n";
  writeFileSync(join(dir, "sprint.md"), spec);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
  const cli = fileURLToPath(new URL("../../../packages/helper/src/cli.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const { stdout } = await exec(process.execPath, [tsx, cli, "create", `http://127.0.0.1:${port}`, JSON.stringify({ host_id: "host", spec: "sprint.md" })], { cwd: dir, env: { ...process.env, J01N_KEY_DIR: dir } });
  expect(JSON.parse(stdout).room_id).toBe("room-1");
  expect(calls[0]).toMatchObject({ template: "sprint", tasks: [{ id: "T1", title: "Build", files: ["src/build.ts"] }] });
  expect(JSON.stringify(calls[0])).not.toContain("Goal (private)");
  const message = calls.find((call) => call.intent === "kickoff") as { intent: string; body: { encrypted_payload: string } };
  expect(message.intent).toBe("kickoff");
  expect(await openRoomSeal(message.body.encrypted_payload, "secret", "room-1")).toBe(spec);
  expect(readFileSync(join(dir, ".j01n-_r_room-1-host.json"), "utf8")).not.toContain(spec);
  writeFileSync(join(dir, "invite.json"), stdout);
  const joined = await exec(process.execPath, [tsx, cli, "join", "invite.json", "peer"], { cwd: dir, env: { ...process.env, J01N_KEY_DIR: dir } });
  expect(JSON.parse(joined.stdout)).toMatchObject({ kickoff: { rules: ["claim before editing"] }, spec });
});

// ── CLI usage commands: flags -> UsageDelta -> the sealed usage.<participant> contract (t1/t2) ──
// The real cli.ts runs in a child process against a room of its own, so these also pin what the server receives.
const usageRoomId = "usage-1";
const usageSecret = "test-room-secret-0123456789";
/** Only ever inside a sealed delta: base64url ciphertext cannot hold ".", so its absence on the wire is provable. */
const usageModel = "qwen3.8-flash";

type BoardEntry = { value: unknown; version: number };

describe("CLI usage commands", () => {
  let usageServer: ReturnType<typeof createServer>;
  let usagePort: number;
  let usageBoard: Record<string, BoardEntry> = {};
  let usageWire: unknown[] = [];
  const dir = mkdtempSync(join(tmpdir(), "j01n-cli-usage-"));
  const usageCli = fileURLToPath(new URL("../../../packages/helper/src/cli.ts", import.meta.url));
  const usageTsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const roomUrl = () => `http://127.0.0.1:${usagePort}/r/${usageRoomId}`;
  const stored = () => usageBoard[usageKey("worker")];

  /** Run the CLI; a non-zero exit comes back as { code, stderr } instead of throwing. */
  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> => {
    try {
      const result = await exec(process.execPath, [usageTsx, usageCli, ...args], { cwd: dir, env: { ...process.env, J01N_KEY_DIR: dir } });
      return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", json: undefined };
    }
  };

  const route = async (req: { url?: string; method?: string }, res: { statusCode: number; end: (body: string) => void }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body !== undefined) usageWire.push(body);
    const url = req.url || "";
    const path = url.split("?")[0];
    const reply = (value: unknown) => res.end(JSON.stringify(value));

    if (req.method === "POST" && path === "/rooms") {
      const api = (suffix: string) => `${roomUrl()}/${suffix}`;
      return reply({
        intro: "intro", next_step: "join", room_id: usageRoomId,
        room: { name: "usage", purpose: "usage", host_id: "worker", max_participants: 8 },
        join_secret: usageSecret, room_url: roomUrl(),
        api: { join: api("participants/{id}"), send: roomUrl(), read: roomUrl(), read_all: `${roomUrl()}?view=all`, events: api("events"), board: api("board"), participants: api("participants"), status: api("status"), extend: api("extend"), export: api("export"), leave: api("participants/{id}"), kick: api("participants/{id}"), close: roomUrl() },
        skill: "skill", expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === `/r/${usageRoomId}/participants/worker`) return reply({ ok: true, cursor: 0, participant_token: "participant-token-1", peers: [] });
    // "quiet" never reports: the read path must still show them.
    if (path === `/r/${usageRoomId}/participants`) return reply({ participants: [{ id: "worker" }, { id: "quiet" }] });
    if (path === `/r/${usageRoomId}/board` && req.method === "GET") return reply({ board: usageBoard, board_schema: null });
    if (path.startsWith(`/r/${usageRoomId}/board/`) && req.method === "PUT") {
      const key = decodeURIComponent(path.slice(`/r/${usageRoomId}/board/`.length));
      const wanted = new URL(url, roomUrl()).searchParams.get("if_version");
      const current = usageBoard[key];
      if (wanted !== null && Number(wanted) !== (current?.version ?? 0)) {
        res.statusCode = 409;
        return reply({ error: "version conflict", entry: current ?? null });
      }
      // A board value is the raw JSON body the CLI put there, exactly as the room would store it.
      usageBoard[key] = { value: body, version: (current?.version ?? 0) + 1 };
      return reply({ ok: true, key, entry: usageBoard[key] });
    }
    if (path === `/r/${usageRoomId}/asks`) return reply({ asks: [] });
    if (path === `/r/${usageRoomId}` && req.method === "POST") return reply({ ok: true, id: "message-1", seq: 1 });
    if (path === `/r/${usageRoomId}` && req.method === "GET") return reply({ cursor: 0, messages: [] });
    res.statusCode = 404;
    res.end("not found");
  };

  beforeAll(async () => {
    usageServer = createServer((req, res) => { void route(req, res); });
    await new Promise<void>((done) => usageServer.listen(0, "127.0.0.1", done));
    usagePort = (usageServer.address() as { port: number }).port;
    const created = await run("create", `http://127.0.0.1:${usagePort}`, JSON.stringify({ host_id: "worker", room_name: "usage" }));
    expect(created.code, created.stderr).toBe(0);
    writeFileSync(join(dir, "invite.json"), created.stdout);
    const joinedRoom = await run("join", "invite.json", "worker");
    expect(joinedRoom.code, joinedRoom.stderr).toBe(0);
  });

  afterAll(async () => {
    if (usageServer?.listening) await new Promise<void>((done) => usageServer.close(() => done()));
  });

  it("maps the key-named flags onto a validated delta", async () => {
    const reported = await run("usage", "report", "--active-ms", "90000", "--input-tokens", "1200", "--output-tokens", "300", "--cost-usd", "0.42", "--model", usageModel);
    expect(reported.code, reported.stderr).toBe(0);
    expect(reported.json.snapshot).toMatchObject({ participant: "worker", reports: 1, active_ms: 90_000, input_tokens: 1200, output_tokens: 300, cost_usd: 0.42, model: usageModel });
    expect(reported.json.key).toBe(usageKey("worker"));
    // Rows come from t1's formatter, not a re-invented one: 1m 30s, k-scaled tokens, reported cost.
    expect(reported.json.line).toBe(`worker: 1m 30s active · 1.2k in / 300 out · $0.42 · ${usageModel}`);
  });

  it("takes the short flags and puts only a room seal on the wire", async () => {
    usageWire = [];
    const reported = await run("usage", "report", "--active", "2", "--tokens", "500,200", "--cost", "1.5");
    expect(reported.code, reported.stderr).toBe(0);
    expect(reported.json.snapshot).toMatchObject({ reports: 2, active_ms: 210_000, input_tokens: 1700, output_tokens: 500, cost_usd: 1.92 });
    // What the room stores is one opaque seal string, never an object holding counters.
    const write = usageWire.filter((call) => JSON.stringify(call).includes("jsk1:"));
    expect(write).toHaveLength(1);
    expect(typeof stored().value).toBe("string");
    expect(String(stored().value).startsWith("jsk1:")).toBe(true);
    expect(JSON.stringify(usageWire)).not.toContain(usageModel);
    expect(JSON.stringify(usageBoard)).not.toContain(usageModel);
    // And it is keyed with the room secret, so a holder of the link can read the numbers back.
    expect(await openRoomSeal(String(stored().value), usageSecret, usageRoomId)).toMatchObject({ participant: "worker", active_ms: 210_000, input_tokens: 1700 });
  });

  it("accumulates every report onto the stored snapshot", async () => {
    const reported = await run("usage", "report", "--tokens", "1000,1000");
    expect(reported.code, reported.stderr).toBe(0);
    expect(reported.json.snapshot).toMatchObject({ reports: 3, active_ms: 210_000, input_tokens: 2700, output_tokens: 1500 });
    expect(reported.json.version).toBe(3);
  });

  it("reads every participant back, silent ones included, with a room total", async () => {
    const report = await run("usage");
    expect(report.code, report.stderr).toBe(0);
    expect(report.json.rows.map((row: { participant: string }) => row.participant)).toEqual(["quiet", "worker"]);
    expect(report.json.reported).toBe(1);
    expect(report.json.stale).toBe(1);
    expect(report.json.totals).toMatchObject({ participants: 1, active_ms: 210_000, input_tokens: 2700, output_tokens: 1500, tokens: 4200, cost_usd: 1.92 });
    expect(report.json.lines[0]).toBe("quiet: no usage reported");
    expect(report.json.lines.at(-1)).toMatch(/^room: 3m 30s active · 2.7k in \/ 1.5k out · \$1\.92$/);
  });

  it("seals with the room key when a profile carries only a participant token", async () => {
    const before = await openUsage(stored().value, "worker", usageSecret, usageRoomId);
    writeFileSync(join(dir, "worker.j01n.json"), JSON.stringify({ access: roomUrl(), participant_id: "worker", participant_token: "participant-token-1" }));
    const reported = await run("usage", "worker.j01n.json", "report", "--input-tokens", "7");
    expect(reported.code, reported.stderr).toBe(0);
    const expected = (before?.input_tokens ?? 0) + 7;
    // The join secret is the seal key; the token that authenticated the call must never become it,
    // or t4's live view reads every row back as "no usage reported".
    expect(await openRoomSeal(String(stored().value), usageSecret, usageRoomId)).toMatchObject({ participant: "worker", input_tokens: expected });
    await expect(openRoomSeal(String(stored().value), "participant-token-1", usageRoomId)).rejects.toThrow();
    const read = await run("usage", "worker.j01n.json");
    expect(read.code, read.stderr).toBe(0);
    expect(read.json.rows.find((row: { participant: string }) => row.participant === "worker").snapshot).toMatchObject({ input_tokens: expected });
  });

  it("stops on bad input instead of guessing a zero report", async () => {
    const before = JSON.stringify(usageBoard);
    const cases: Array<{ args: string[]; matches: RegExp }> = [
      { args: ["usage", "report"], matches: /usage report needs at least one flag/ },
      { args: ["usage", "report", "1200"], matches: /takes "<flag> <value>" pairs only, got the argument "1200"/ },
      { args: ["usage", "report", "--tokens", "1200"], matches: /--tokens needs "<in,out>", got "1200"/ },
      { args: ["usage", "report", "--tokens", "1200,"], matches: /--tokens needs "<in,out>"/ },
      { args: ["usage", "report", "--tokens", "a,b"], matches: /--tokens needs a number, got "a"/ },
      { args: ["usage", "report", "--budget", "5"], matches: /unknown usage flag: --budget/ },
      { args: ["usage", "report", "--input-tokens"], matches: /--input-tokens needs a value/ },
      { args: ["usage", "report", "--input-tokens", "1", "--input-tokens", "2"], matches: /--input-tokens conflicts with another input-tokens flag/ },
      { args: ["usage", "report", "--active-ms", "5", "--active", "1"], matches: /--active conflicts with another active-ms flag/ },
      { args: ["usage", "report", "--input-tokens", "abc"], matches: /--input-tokens needs a number, got "abc"/ },
      { args: ["usage", "report", "--input-tokens", "-5"], matches: /input_tokens must be a whole number >= 0/ },
      { args: ["usage", "report", "--active", "1441"], matches: /active_ms must be <= 86400000/ },
      { args: ["usage", "reset"], matches: /unknown usage command: reset/ },
    ];
    for (const { args, matches } of cases) {
      const failed = await run(...args);
      expect(failed.code, `${args.join(" ")} -> ${failed.stderr}`).not.toBe(0);
      expect(failed.stderr).toMatch(matches);
    }
    expect(JSON.stringify(usageBoard)).toBe(before);
  });

  it("needs the room link when only a resume pointer is stored", async () => {
    // An active-room pointer with no stored join secret: a usage seal can be neither made nor opened.
    const resumeDir = mkdtempSync(join(tmpdir(), "j01n-cli-usage-resume-"));
    const url = "http://127.0.0.1:1/r/resume-1";
    mkdirSync(join(resumeDir, ".j01n-rooms"), { recursive: true, mode: 0o700 });
    writeFileSync(join(resumeDir, ".j01n-rooms", `${createHash("sha256").update(`${url}\0worker`).digest("hex")}.json`), JSON.stringify({ room_url: url, participant_id: "worker" }));
    try {
      await exec(process.execPath, [usageTsx, usageCli, "usage"], { cwd: resumeDir, env: { ...process.env, J01N_KEY_DIR: resumeDir } });
      expect.unreachable("usage without a join secret must fail");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr)).toMatch(/usage needs the room link or invitation/);
    }
  });
});
