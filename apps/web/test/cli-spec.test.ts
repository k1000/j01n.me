import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openRoomSeal } from "@j01n/sdk";

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
