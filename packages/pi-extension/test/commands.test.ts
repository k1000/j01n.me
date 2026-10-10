import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOM = "https://j01n.me/r/room-1";
const calls: Array<{ method: string; url: string; auth: string | null }> = [];
let boardResponse: Response | undefined;

describe("pi-extension sessions", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    calls.length = 0;
    boardResponse = undefined;
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-pi-")));
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (method === "GET" && String(url).endsWith("/wait")) return Response.json({ timeout: true, cursor: 0 });
      if (method === "GET" && String(url).endsWith("/board")) return boardResponse ?? Response.json({ board: {}, board_schema: null });
      if (method === "GET" && String(url).includes("/r/")) return Response.json({ cursor: 0, messages: [] });
      return Response.json({ ok: true, seq: 1, participant: {} });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("returns the kickoff value and the whole board on join (owner decision 2026-10-10)", async () => {
    boardResponse = Response.json({ board: {
      kickoff: { value: { task: "Review proposals" }, updated_by: "host", updated_at: "2026-01-01" },
      private_notes: { value: "not part of kickoff", updated_by: "host", updated_at: "2026-01-01" },
    }, board_schema: null });
    const { runj01n } = await import("../commands");
    const result = JSON.parse(await runj01n(["join", ROOM, "secret", "pi-agent"]));
    expect(result.kickoff).toEqual({ task: "Review proposals" });
    // A newly invited agent receives all board content, not only the kickoff.
    expect(result.board.private_notes.value).toBe("not part of kickoff");
    expect(calls).toContainEqual(expect.objectContaining({ method: "GET", url: `${ROOM}/board`, auth: "Bearer tok-1" }));
  });

  it("returns no kickoff for an empty board without failing the join", async () => {
    const { runj01n } = await import("../commands");
    expect(JSON.parse(await runj01n(["join", ROOM, "secret", "pi-agent"])).kickoff).toBeNull();
  });

  it("keeps a successful join usable when the optional kickoff fetch fails", async () => {
    boardResponse = Response.json({ error: "temporarily unavailable" }, { status: 503 });
    const { runj01n } = await import("../commands");
    const result = JSON.parse(await runj01n(["join", ROOM, "secret", "pi-agent"]));
    expect(result).toMatchObject({ ok: true, kickoff: null, kickoff_error: expect.any(String) });
    expect(JSON.parse(readFileSync(".j01n-_r_room-1-pi-agent.json", "utf8")).participantToken).toBe("tok-1");
  });

  it("uses the sole room for status without repeating credentials", async () => {
    const commands = await import("../commands");
    await commands.runj01n(["join", "https://j01n.me/room/room-1#secret", "pi-agent"]);

    vi.resetModules();
    calls.length = 0;
    const later = await import("../commands");
    await later.runj01n(["status", "busy", "working"]);

    expect(calls).toEqual([expect.objectContaining({ method: "PATCH", url: `${ROOM}/participants/pi-agent`, auth: "Bearer tok-1" })]);
  });

  it("uses the sole joined room for short send and wait across processes without persisting the invite secret", async () => {
    const first = await import("../commands");
    await first.runj01n(["join", "https://j01n.me/room/room-1#secret", "pi-agent"]);
    const rooms = readdirSync(".j01n-rooms");
    expect(rooms).toHaveLength(1);
    const registry = readFileSync(join(".j01n-rooms", rooms[0]), "utf8");
    expect(registry).not.toContain("secret");
    expect(registry).not.toContain("tok-1");
    expect(JSON.parse(registry)).toEqual({ room_url: ROOM, participant_id: "pi-agent" });
    expect(statSync(join(".j01n-rooms", rooms[0])).mode & 0o777).toBe(0o600);
    expect(statSync(".j01n-rooms").mode & 0o777).toBe(0o700);

    vi.resetModules();
    calls.length = 0;
    const second = await import("../commands");
    expect(JSON.parse(await second.runj01n(["send", "all", "hi there"]))).toMatchObject({ ok: true });
    expect(JSON.parse(await second.runj01n(["wait"]))).toEqual({ timeout: true });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.auth === "Bearer tok-1")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/r/room-1/wait") && c.auth === "Bearer tok-1")).toBe(true);
  });

  it("requires an explicit room when more than one has been joined", async () => {
    const extension = await import("../commands");
    await extension.runj01n(["join", ROOM, "secret", "pi-agent"]);
    await extension.runj01n(["join", "https://j01n.me/r/room-2", "secret-2", "pi-agent"]);
    await expect(extension.runj01n(["send", "all", "hi"])).rejects.toThrow("multiple rooms");
    await expect(extension.runj01n(["wait"])).rejects.toThrow("multiple rooms");
    expect(JSON.parse(await extension.runj01n(["wait", ROOM, "secret", "pi-agent"]))).toEqual({ timeout: true });
    calls.length = 0;
    await extension.runj01n(["send", "https://j01n.me/room/room-1#secret", "pi-agent", "all", "explicit room"]);
    expect(calls.some((call) => call.method === "POST" && call.url === ROOM)).toBe(true);
    expect(calls.some((call) => call.url.includes("room-2"))).toBe(false);
    await extension.runj01n(["leave", "https://j01n.me/r/room-2", "secret-2", "pi-agent"]);
    expect(JSON.parse(await extension.runj01n(["wait"]))).toEqual({ timeout: true });
  });

  it("rejects short commands before a room has been joined", async () => {
    const extension = await import("../commands");
    await expect(extension.runj01n(["wait"])).rejects.toThrow("no active room");
    await expect(extension.runj01n(["send", "all", "hello"])).rejects.toThrow("no active room");
  });

  it("fails closed if the saved key no longer matches the selected room", async () => {
    const first = await import("../commands");
    await first.runj01n(["join", ROOM, "secret", "pi-agent"]);
    const file = ".j01n-_r_room-1-pi-agent.json";
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, roomUrl: "https://evil.example/r/room-1" }));
    vi.resetModules();
    calls.length = 0;
    const second = await import("../commands");
    await expect(second.runj01n(["send", "all", "hi"])).rejects.toThrow("saved session is missing or belongs to another room");
    expect(calls).toEqual([]);
  });

  it("join returns the sealed kickoff when the board has none", async () => {
    const { sealKickoff } = await import("@j01n/sdk/crypto");
    const sealed = await sealKickoff({ text: "sealed hello" }, "secret", "room-1");
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (String(url).endsWith("/board")) return Response.json({ board: {} });
      if (String(url).includes("/participants")) return Response.json({ participants: [] });
      if (method === "GET") return Response.json({ cursor: 3, messages: [{ id: "k", seq: 3, from: "host", to: "all", intent: "kickoff", body: sealed }] });
      return Response.json({ ok: true });
    });
    const commands = await import("../commands");
    const out = JSON.parse(await commands.runj01n(["join", "https://j01n.me/room/room-1#secret", "pi-agent"]));
    expect(out.kickoff).toEqual({ text: "sealed hello" });
  });

  it("resumes from the saved key file in a new process instead of re-joining", async () => {
    const first = await import("../commands");
    await first.runj01n(["join", ROOM, "secret", "pi-agent"]);
    const saved = JSON.parse(readFileSync(".j01n-_r_room-1-pi-agent.json", "utf8"));
    expect(saved.participantToken).toBe("tok-1");
    expect(saved.privateJwk).toBeTruthy();

    vi.resetModules(); // simulate a fresh Pi process: in-memory sessions are gone
    calls.length = 0;
    const second = await import("../commands");
    await second.runj01n(["status", ROOM, "secret", "pi-agent", "busy", "smoke test"]);

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ method: "PATCH", auth: "Bearer tok-1" })]);
    expect(JSON.parse(readFileSync(".j01n-_r_room-1-pi-agent.json", "utf8")).publicJwk).toEqual(saved.publicJwk);
  });
});
