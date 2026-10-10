import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDK_CLIENT_PROTOCOL } from "@j01n/sdk";

const ROOM = "https://j01n.me/r/room-1";
const calls: Array<{ method: string; url: string; auth: string | null; body?: string }> = [];
let boardResponse: Response | undefined;
let teamParticipants: unknown[] | undefined;

describe("pi-extension sessions", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    calls.length = 0;
    boardResponse = undefined;
    teamParticipants = undefined;
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-pi-")));
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization"), ...(init?.body ? { body: String(init.body) } : {}) });
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (method === "GET" && String(url).endsWith("/wait")) return Response.json({ timeout: true, cursor: 0 });
      if (method === "GET" && String(url).endsWith("/board")) return boardResponse ?? Response.json({ board: {}, board_schema: null });
      if (method === "GET" && String(url).endsWith("/participants")) return Response.json({ participants: teamParticipants ?? [] });
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

  it("host hands the host role to another participant of the current room", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent"]);
    await runj01n(["host", "claude-code"]);
    expect(calls).toContainEqual(expect.objectContaining({ method: "POST", url: `${ROOM}/host`, auth: "Bearer tok-1" }));
  });

  it("join announces capabilities and a sealed workspace (never the plaintext path); --no-workspace skips it", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent", "--capabilities", "code,shell,vision"]);
    const profile = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(profile.capabilities).toEqual(["code", "shell", "vision"]);
    expect(profile.workspace).toMatch(/^jsk1:/);
    expect(JSON.stringify(calls)).not.toContain(process.cwd());

    calls.length = 0;
    await runj01n(["join", ROOM, "secret", "pi-agent", "--no-workspace"]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("join announces --model and --provider; an identical row is not announced again", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent", "--model", "claude-sonnet-4-5", "--provider", "anthropic", "--no-workspace"]);
    const profile = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!);
    expect(profile.model).toBe("claude-sonnet-4-5");
    expect(profile.provider).toBe("anthropic");

    // The room row already carries the same model/provider: dedupe skips the write.
    teamParticipants = [{ id: "pi-agent", state: "free", status: "s", last_seen_at: new Date().toISOString(), model: "claude-sonnet-4-5", provider: "anthropic" }];
    calls.length = 0;
    await runj01n(["join", ROOM, "secret", "pi-agent", "--model", "claude-sonnet-4-5", "--provider", "anthropic", "--no-workspace"]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("profile changes capabilities and workspace during the session, also after a restart (secret saved at join)", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent", "--no-workspace"]);
    calls.length = 0;
    await runj01n(["profile", "--capabilities", "code,browser"]);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ capabilities: ["code", "browser"] });

    calls.length = 0;
    await runj01n(["profile", "--no-workspace"]);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ workspace: null });

    // Same Pi session: the joined client still holds the room secret, so the workspace can be re-announced.
    calls.length = 0;
    await runj01n(["profile", "--workspace"]);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).workspace).toMatch(/^jsk1:/);

    // After a restart the room secret comes from the private key file saved at join.
    vi.resetModules();
    const restarted = await import("../commands");
    calls.length = 0;
    await restarted.runj01n(["profile", "--workspace"]);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).workspace).toMatch(/^jsk1:/);

    // A key file from before the secret was saved: the room link is needed to seal the workspace.
    const keyFile = readdirSync(".").find((f) => f.startsWith(".j01n-") && f.endsWith("-pi-agent.json"))!;
    const { joinSecret: _saved, ...withoutSecret } = JSON.parse(readFileSync(keyFile, "utf8"));
    writeFileSync(keyFile, JSON.stringify(withoutSecret));
    vi.resetModules();
    const old = await import("../commands");
    await expect(old.runj01n(["profile", "--workspace"])).rejects.toThrow("needs the room link");
  });

  it("re-joining from the same place does not announce the workspace again (no chat noise, no wake-ups)", async () => {
    const { sealWorkspace } = await import("@j01n/sdk");
    const sealed = await sealWorkspace({ path: process.cwd() }, "secret", "room-1");
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => String(url).endsWith("/participants")
      ? Promise.resolve(Response.json({ participants: [{ id: "pi-agent", workspace: sealed }] }))
      : base(url, init));
    const { runj01n } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "pi-agent"]);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
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

  it("doctor reports the SDK protocol, update notice and open-question count", async () => {
    const baseFetch = globalThis.fetch;
    let asksAuth: string | null = null;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/participants") && (init?.method ?? "GET") === "GET") {
        return Response.json({ participants: [{ id: "pi-agent" }] }, { headers: { "x-j01n-client-update": "Update the Pi extension" } });
      }
      if (String(url).endsWith("/asks")) {
        asksAuth = new Headers(init?.headers).get("authorization");
        return Response.json({ asks: [{ ask_id: "question-1", seq: 1, from: "host", due_at: null, overdue: false,
          message: { id: "question-1", seq: 1, from: "host", to: "pi-agent", intent: "notify", body: { text: "Ready?" } } }] });
      }
      return baseFetch(url, init);
    });

    const { runj01n } = await import("../commands");
    const result = JSON.parse(await runj01n(["doctor", ROOM, "secret", "pi-agent"]));
    expect(result).toMatchObject({ client_protocol: SDK_CLIENT_PROTOCOL, client_update: "Update the Pi extension", open_questions: 1 });
    expect(result.extension).toMatchObject({ reload_required: expect.any(Boolean), duplicate_install: expect.any(Boolean), warnings: expect.any(Array) });
    expect(result.extension).toHaveProperty("loaded_commit");
    expect(asksAuth).toBe("Bearer tok-1");
  });

  it.each(["http", "network"])("doctor keeps other diagnostics when /asks has a %s error", async (failure) => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/participants") && (init?.method ?? "GET") === "GET") {
        return Response.json({ participants: [{ id: "pi-agent" }] });
      }
      if (String(url).endsWith("/asks")) {
        if (failure === "network") throw new TypeError("network unavailable");
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return baseFetch(url, init);
    });

    const { runj01n } = await import("../commands");
    const result = JSON.parse(await runj01n(["doctor", ROOM, "secret", "pi-agent"]));
    expect(result).toMatchObject({ ok: true, joined: true, client_protocol: SDK_CLIENT_PROTOCOL,
      open_questions: null, open_questions_error: expect.any(String) });
    expect(result.open_questions_error).toContain(failure === "http" ? "404" : "network");
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

describe("pi-extension agent inbox", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("register keeps the identity private; listen opens an invite, removes it and joins the room", async () => {
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-pi-agent-")));
    vi.stubEnv("BASE_URL", "https://j01n.me");
    vi.stubEnv("J01N_AGENT_DIR", ""); // identities in the test directory, even when run from a spawned pane
    const keys = new Map<string, string>();
    let invites: Array<{ id: string; from: string; created_at: string; sealed: unknown }> = [];
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      seen.push(`${method} ${path}`);
      if (method === "POST" && path === "/agents") { keys.set(body.name, body.public_key); return Response.json({ agent_token: `tok-${body.name}` }); }
      if (method === "GET" && /^\/a\/[^/]+$/.test(path)) return Response.json({ public_key: keys.get(path.split("/")[2]) });
      if (method === "POST" && path.endsWith("/invites")) { invites.push({ id: "inv-1", from: body.from, created_at: "now", sealed: body.sealed }); return Response.json({ id: "inv-1" }); }
      if (method === "GET" && path.endsWith("/wait") && path.startsWith("/a/")) return Response.json({ invites });
      if (method === "DELETE") { invites = []; return Response.json({ ok: true }); }
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
      if (method === "GET" && path.endsWith("/board")) return Response.json({ board: {}, board_schema: null });
      return Response.json({ ok: true, seq: 1, cursor: 0, messages: [], participant: {} });
    });
    const { runj01n } = await import("../commands");
    await runj01n(["register", "claude-code"]);
    expect(JSON.parse(await runj01n(["register", "pi-agent", "claude-code"])).accept_from).toEqual(["claude-code"]);
    expect(statSync(".j01n-agent-pi-agent.json").mode & 0o777).toBe(0o600);

    await runj01n(["invite", "claude-code", "pi-agent", "https://j01n.me/room/room-1#very-secret-join-secret"]);
    expect(JSON.stringify(invites)).not.toContain("very-secret-join-secret");
    const result = JSON.parse(await runj01n(["listen", "pi-agent", "1", "--capabilities", "code,shell", "--no-workspace"]));
    expect(result).toMatchObject({ invited_by: "claude-code", ok: true, participant_id: "pi-agent" });
    expect(seen).toContain("DELETE /a/pi-agent/invites/inv-1");
    expect(seen).toContain("PUT /r/room-1/participants/pi-agent");
    // Join flags pass through listen: capabilities announced, no workspace.
    expect(seen).toContain("PATCH /r/room-1/participants/pi-agent");
  });
});
