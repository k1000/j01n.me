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
import { DEFAULT_EXTEND_MS } from "../src/constants";

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

// ── CLI extend: the host keeps a room alive from the helper, not only from the web page (t2) ──
// The real cli.ts runs against a fake room that owns the TTL, so these pin who may call /extend, what body it
// receives (the default stays a server decision) and that the printed expiry is the one the room answered with.
describe("CLI extend command", () => {
  const extendRoomId = "extend-1";
  const extendSecret = "test-room-secret-0123456789";
  const tokens: Record<string, string> = { host: "host-token-1", peer: "peer-token-1" };
  // One directory per participant: two active rooms in one directory is a failure the CLI must not paper over.
  const hostDir = mkdtempSync(join(tmpdir(), "j01n-cli-extend-host-"));
  const peerDir = mkdtempSync(join(tmpdir(), "j01n-cli-extend-peer-"));
  const extendCli = fileURLToPath(new URL("../../../packages/helper/src/cli.ts", import.meta.url));
  const extendTsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  let extendServer: ReturnType<typeof createServer>;
  let extendPort: number;
  let expiresAt = 0;
  /** What GET /status claims; POST /extend always checks against the real host, so a stale view still fails. */
  let statusHostId = "host";
  let extendBodies: unknown[] = [];
  const roomUrl = () => `http://127.0.0.1:${extendPort}/r/${extendRoomId}`;
  const roomLink = () => `http://127.0.0.1:${extendPort}/room/${extendRoomId}#${extendSecret}`;

  /** Run the CLI in a directory; a non-zero exit comes back as { code, stderr } instead of throwing. */
  const runIn = (dir: string) => async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> => {
    try {
      const result = await exec(process.execPath, [extendTsx, extendCli, ...args], { cwd: dir, env: { ...process.env, J01N_KEY_DIR: dir } });
      return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", json: undefined };
    }
  };
  const host = runIn(hostDir);
  const peer = runIn(peerDir);

  const route = async (req: { url?: string; method?: string; headers?: Record<string, string | string[] | undefined> }, res: { statusCode: number; end: (body: string) => void }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = req.url || "";
    const path = url.split("?")[0];
    const reply = (value: unknown) => res.end(JSON.stringify(value));
    const token = String(req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
    const asked = (id: string) => ({ ok: true, cursor: 0, participant_token: tokens[id], peers: [] });

    if (req.method === "POST" && path === "/rooms") {
      expiresAt = Date.now() + 600_000;
      const api = (suffix: string) => `${roomUrl()}/${suffix}`;
      return reply({
        intro: "intro", next_step: "join", room_id: extendRoomId,
        room: { name: "extend", purpose: "extend", host_id: "host", max_participants: 8 },
        join_secret: extendSecret, room_url: roomUrl(),
        api: { join: api("participants/{id}"), send: roomUrl(), read: roomUrl(), read_all: `${roomUrl()}?view=all`, events: api("events"), board: api("board"), participants: api("participants"), status: api("status"), extend: api("extend"), export: api("export"), leave: api("participants/{id}"), kick: api("participants/{id}"), close: roomUrl() },
        skill: "skill", expires_at: new Date(expiresAt).toISOString(),
      });
    }
    if (path === `/r/${extendRoomId}/status`) return reply({ room: { room_id: extendRoomId, host_id: statusHostId, expires_at: new Date(expiresAt).toISOString() }, participants: [] });
    if (path === `/r/${extendRoomId}/extend` && req.method === "POST") {
      extendBodies.push(body);
      // The room, not the helper, decides who may extend and by how long a default.
      if (token !== tokens.host) { res.statusCode = 403; return reply({ error: "only host can extend TTL" }); }
      const requested = (body as { extend_ms?: unknown })?.extend_ms;
      const extendMs = typeof requested === "number" && Number.isFinite(requested) ? Math.trunc(requested) : DEFAULT_EXTEND_MS;
      expiresAt += extendMs;
      return reply({ ok: true, extended_ms: extendMs, expires_at: new Date(expiresAt).toISOString() });
    }
    if (path === `/r/${extendRoomId}/participants`) return reply({ participants: [{ id: "host" }, { id: "peer" }] });
    if (path.startsWith(`/r/${extendRoomId}/participants/`)) {
      const id = decodeURIComponent(path.slice(`/r/${extendRoomId}/participants/`.length));
      if (tokens[id]) return reply(asked(id));
    }
    if (path === `/r/${extendRoomId}/board`) return reply({ board: {}, board_schema: null });
    if (path === `/r/${extendRoomId}/asks`) return reply({ asks: [] });
    if (path === `/r/${extendRoomId}` && req.method === "POST") return reply({ ok: true, id: "message-1", seq: 1 });
    if (path === `/r/${extendRoomId}`) return reply({ cursor: 0, messages: [] });
    res.statusCode = 404;
    res.end(`not found: ${req.method} ${path}`);
  };

  beforeAll(async () => {
    extendServer = createServer((req, res) => { void route(req, res); });
    await new Promise<void>((done) => extendServer.listen(0, "127.0.0.1", done));
    extendPort = (extendServer.address() as { port: number }).port;
    const created = await host("create", `http://127.0.0.1:${extendPort}`, JSON.stringify({ host_id: "host", room_name: "extend" }));
    expect(created.code, created.stderr).toBe(0);
    writeFileSync(join(hostDir, "invite.json"), created.stdout);
    writeFileSync(join(peerDir, "invite.json"), created.stdout);
    const joinedHost = await host("join", "invite.json", "host");
    expect(joinedHost.code, joinedHost.stderr).toBe(0);
    // The participant profile form carries only a token: extend must still authenticate with it.
    writeFileSync(join(hostDir, "host.j01n.json"), JSON.stringify({ access: roomUrl(), participant_id: "host", participant_token: tokens.host }));
    const joinedPeer = await peer("join", "invite.json", "peer");
    expect(joinedPeer.code, joinedPeer.stderr).toBe(0);
  });

  afterAll(async () => {
    if (extendServer?.listening) await new Promise<void>((done) => extendServer.close(() => done()));
  });

  it("extends by the server default when the host gives no minutes", async () => {
    extendBodies = [];
    const before = expiresAt;
    const result = await host("extend");
    expect(result.code, result.stderr).toBe(0);
    // The helper invents no number: an empty request makes the room answer with its own DEFAULT_EXTEND_MS.
    expect(extendBodies).toEqual([{}]);
    expect(result.json).toEqual({ ok: true, expires_at: new Date(before + DEFAULT_EXTEND_MS).toISOString() });
  });

  it("turns the minutes argument into the extend_ms the room applies", async () => {
    extendBodies = [];
    const before = expiresAt;
    const result = await host("extend", "12");
    expect(result.code, result.stderr).toBe(0);
    expect(extendBodies).toEqual([{ extend_ms: 12 * 60_000 }]);
    expect(Date.parse(String(result.json.expires_at))).toBe(before + 12 * 60_000);
  });

  it("takes the active room pointer, the profile and the room link forms", async () => {
    extendBodies = [];
    const byProfile = await host("extend", "host.j01n.json", "3");
    expect(byProfile.code, byProfile.stderr).toBe(0);
    const byLink = await host("extend", roomLink(), "host", "4");
    expect(byLink.code, byLink.stderr).toBe(0);
    expect(extendBodies).toEqual([{ extend_ms: 3 * 60_000 }, { extend_ms: 4 * 60_000 }]);
  });

  it("refuses a non-host before asking the room to extend", async () => {
    extendBodies = [];
    const before = expiresAt;
    const fromPointer = await peer("extend");
    expect(fromPointer.code).not.toBe(0);
    expect(fromPointer.stdout).toBe("");
    expect(fromPointer.stderr).toMatch(/extend is host only/);
    const byLink = await peer("extend", roomLink(), "peer", "30");
    expect(byLink.code).not.toBe(0);
    expect(byLink.stderr).toMatch(/extend is host only/);
    expect(extendBodies).toEqual([]);
    expect(expiresAt).toBe(before);
  });

  it("fails cleanly when the room itself refuses a stale host view", async () => {
    extendBodies = [];
    const before = expiresAt;
    statusHostId = "peer";
    try {
      const result = await peer("extend");
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/403.*only host can extend TTL/);
      expect(extendBodies).toHaveLength(1);
      expect(expiresAt).toBe(before);
    } finally { statusHostId = "host"; }
  });

  it("stops on a bad argument instead of guessing a default", async () => {
    extendBodies = [];
    const before = expiresAt;
    const cases: Array<{ args: string[]; matches: RegExp }> = [
      { args: ["extend", "abc"], matches: /extend minutes needs a positive number, got "abc"/ },
      { args: ["extend", "0"], matches: /extend minutes needs a positive number/ },
      { args: ["extend", "-5"], matches: /extend minutes needs a positive number/ },
      { args: ["extend", "5", "7"], matches: /extend needs: \[minutes\]/ },
      { args: ["extend", "--minutes", "5"], matches: /extend needs: \[minutes\]/ },
    ];
    for (const { args, matches } of cases) {
      const failed = await host(...args);
      expect(failed.code, `${args.join(" ")} -> ${failed.stderr}`).not.toBe(0);
      expect(failed.stderr).toMatch(matches);
    }
    expect(extendBodies).toEqual([]);
    expect(expiresAt).toBe(before);
  });

  it("lists extend in the command usage", async () => {
    const unknown = await host("extend-not-a-command");
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/Usage: [^\n]*\bextend\b/);
  });
});

// ── CLI report: one-command run record for the champion loop (t4) ──
// The real cli.ts runs against a mock room that owns tasks, usage, asks and verdict messages,
// so these pin the record shape (family, room, repo, workers, tasks, usage, open_asks, verdicts),
// that no credential leaks into the JSON, and that --out writes the file.
import { sealUsage } from "@j01n/sdk";

describe("CLI report command", () => {
  const reportRoomId = "report-1";
  const reportSecret = "test-room-secret-0123456789";
  const reportToken = "report-participant-token";
  const reportDir = mkdtempSync(join(tmpdir(), "j01n-cli-report-"));
  const reportCli = fileURLToPath(new URL("../../../packages/helper/src/cli.ts", import.meta.url));
  const reportTsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  let reportServer: ReturnType<typeof createServer>;
  let reportPort: number;
  let reportBoard: Record<string, BoardEntry> = {};
  let reportMessages: Array<{ id: string; seq: number; from: string; to: string; intent: string; body: unknown; created_at: string }> = [];
  const roomUrl = () => `http://127.0.0.1:${reportPort}/r/${reportRoomId}`;

  /** Run the CLI; a non-zero exit comes back as { code, stderr } instead of throwing. */
  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> => {
    try {
      const result = await exec(process.execPath, [reportTsx, reportCli, ...args], { cwd: reportDir, env: { ...process.env, J01N_KEY_DIR: reportDir } });
      return { code: 0, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", json: undefined };
    }
  };

  const route = async (req: { url?: string; method?: string }, res: { statusCode: number; end: (body: string) => void }) => {
    const url = req.url || "";
    const path = url.split("?")[0];
    const reply = (value: unknown) => res.end(JSON.stringify(value));

    if (req.method === "POST" && path === "/rooms") {
      const api = (suffix: string) => `${roomUrl()}/${suffix}`;
      return reply({
        intro: "intro", next_step: "join", room_id: reportRoomId,
        room: { name: "report", purpose: "report", host_id: "host", max_participants: 8 },
        join_secret: reportSecret, room_url: roomUrl(),
        api: { join: api("participants/{id}"), send: roomUrl(), read: roomUrl(), read_all: `${roomUrl()}?view=all`, events: api("events"), board: api("board"), participants: api("participants"), status: api("status"), extend: api("extend"), export: api("export"), leave: api("participants/{id}"), kick: api("participants/{id}"), close: roomUrl() },
        skill: "skill", expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === `/r/${reportRoomId}/participants/host`) return reply({ ok: true, cursor: 0, participant_token: reportToken, peers: [] });
    if (path === `/r/${reportRoomId}/participants`) return reply({ participants: [{ id: "host" }, { id: "worker-1" }, { id: "worker-2" }] });
    if (path === `/r/${reportRoomId}/board` && req.method === "GET") return reply({ board: reportBoard, board_schema: null });
    if (path === `/r/${reportRoomId}/asks`) return reply({ asks: [{ ask_id: "ask-1", seq: 10, from: "worker-1", due_at: new Date(Date.now() + 60_000).toISOString(), overdue: false, message: { id: "m10", seq: 10, from: "worker-1", to: "host", intent: "msg", body: { text: "which scope?" }, created_at: new Date().toISOString(), reply_to: null, priority: "normal" } }] });
    if ((path === `/r/${reportRoomId}` || path === `/r/${reportRoomId}/`) && req.method === "GET") return reply({ cursor: 0, messages: reportMessages });
    if ((path === `/r/${reportRoomId}` || path === `/r/${reportRoomId}/`) && req.method === "POST") return reply({ ok: true, id: "message-1", seq: 1 });
    res.statusCode = 404;
    res.end("not found");
  };

  beforeAll(async () => {
    reportServer = createServer((req, res) => { void route(req, res); });
    await new Promise<void>((done) => reportServer.listen(0, "127.0.0.1", done));
    reportPort = (reportServer.address() as { port: number }).port;
    const created = await run("create", `http://127.0.0.1:${reportPort}`, JSON.stringify({ host_id: "host", room_name: "report" }));
    expect(created.code, created.stderr).toBe(0);
    writeFileSync(join(reportDir, "invite.json"), created.stdout);
    const joinedRoom = await run("join", "invite.json", "host");
    expect(joinedRoom.code, joinedRoom.stderr).toBe(0);
    // Seed board with tasks: one done (with evidence + contract), one claimed, one blocked
    reportBoard = {
      "task.t1": { value: { title: "Build", files: ["src/build.ts"], depends_on: [], status: "done", owner: "worker-1", summary: "built it", evidence: { commits: ["abc123"], tests: "passed", contract: "pnpm check:contract --peer passed" } }, version: 1 },
      "task.t2": { value: { title: "Test", files: ["src/test.ts"], depends_on: [], status: "claimed", owner: "worker-2" }, version: 1 },
      "task.t3": { value: { title: "Deploy", files: ["src/deploy.ts"], depends_on: ["t1"], status: "blocked", owner: "host", blocked_reason: "waiting for t1" }, version: 1 },
    };
    // Seed usage for one participant (sealed with room key)
    const usageSnapshot = { participant: "worker-1", reports: 1, updated_at: new Date().toISOString(), active_ms: 60_000, input_tokens: 1000, output_tokens: 500, cost_usd: 0.1, model: "qwen3.8-flash" };
    const sealedUsage = await sealUsage(usageSnapshot, reportSecret, reportRoomId);
    reportBoard["usage.worker-1"] = { value: sealedUsage, version: 1 };
    // Seed messages: one compare.verdict
    reportMessages = [
      { id: "msg-1", seq: 1, from: "worker-2", to: "all", intent: "compare.verdict", body: { of: "t1", winner: "A", reason: "faster" }, created_at: new Date().toISOString() },
    ];
  });

  afterAll(async () => {
    if (reportServer?.listening) await new Promise<void>((done) => reportServer.close(() => done()));
  });

  it("composes a stable record shape with tasks, usage, asks and verdicts", async () => {
    const result = await run("report");
    expect(result.code, result.stderr).toBe(0);
    const record = result.json;
    expect(record.family).toMatch(/:feature$/);
    expect(record.room).toBe(reportRoomId);
    expect(typeof record.repo).toBe("string");
    expect(record.workers).toBe(3);
    expect(record.tasks).toEqual({ total: 3, done: 1, blocked: 1, all_have_evidence: false, all_contract_phrased: false });
    expect(record.usage.rows).toHaveLength(3);
    const worker1Row = record.usage.rows.find((r: { participant: string }) => r.participant === "worker-1");
    expect(worker1Row).toBeDefined();
    expect(worker1Row.snapshot).toMatchObject({ active_ms: 60_000, input_tokens: 1000 });
    expect(record.usage.totals).toMatchObject({ participants: 1 });
    expect(record.open_asks).toBe(1);
    expect(record.verdicts).toEqual([{ seq: 1, by: "worker-2", of: "t1", winner: "A", reason: "faster" }]);
    expect(typeof record.generated_at).toBe("string");
  });

  it("never prints participant tokens or room secrets in the record", async () => {
    const result = await run("report");
    expect(result.code, result.stderr).toBe(0);
    const json = result.stdout;
    expect(json).not.toContain(reportSecret);
    expect(json).not.toContain(reportToken);
    // Sealed ciphertext (jsk1:) must not appear; usage rows are decrypted snapshots
    expect(json).not.toContain("jsk1:");
  });

  it("writes the record to a file with --out", async () => {
    const outPath = join(reportDir, "run-record.json");
    const result = await run("report", "--out", outPath);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ ok: true, out: outPath, room: reportRoomId });
    const fileContent = readFileSync(outPath, "utf8");
    const record = JSON.parse(fileContent);
    expect(record.family).toMatch(/:feature$/);
    expect(record.room).toBe(reportRoomId);
    expect(record.tasks.total).toBe(3);
    expect(fileContent).not.toContain(reportSecret);
    expect(fileContent).not.toContain(reportToken);
  });

  it("rejects unknown flags and missing --out value", async () => {
    const cases: Array<{ args: string[]; matches: RegExp }> = [
      { args: ["report", "--unknown"], matches: /report needs: \[--out <file>\]/ },
      { args: ["report", "--out"], matches: /--out needs a file path/ },
      { args: ["report", "--out", "--flag"], matches: /--out needs a file path/ },
      { args: ["report", "--out", "a.json", "--out", "b.json"], matches: /report takes one --out path/ },
    ];
    for (const { args, matches } of cases) {
      const failed = await run(...args);
      expect(failed.code, `${args.join(" ")} -> ${failed.stderr}`).not.toBe(0);
      expect(failed.stderr).toMatch(matches);
    }
  });

  it("lists report in the command usage", async () => {
    const unknown = await run("report-not-a-command");
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toMatch(/Usage: [^\n]*\breport\b/);
  });
});
