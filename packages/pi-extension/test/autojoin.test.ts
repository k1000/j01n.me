import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOM = "https://j01n.me/r/room-1";
const LINK = "https://j01n.me/room/room-1#very-secret-join-secret";

interface FakeRoom {
  calls: string[];
  profiles: Array<Record<string, unknown>>;
  /** participant ids currently joined in the room */
  joined: Set<string>;
  /** rows returned by /asks */
  asks: Array<{ ask_id: string; seq: number; from: string; due_at: string; overdue: boolean; message: unknown }>; 
  /** invitations waiting in each agent inbox */
  invites: Array<{ id: string; from: string; created_at: string; sealed: unknown }>;
  /** false stands for an expired or deleted room: every room call answers 404 */
  alive: boolean;
}

let room: FakeRoom;

/** The whole j01n.me service, sealed content included, as one fetch stub. */
function serve(): typeof fetch {
  const agentKeys = new Map<string, string>();
  const handler = async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const target = new URL(String(url));
    const path = target.pathname;
    room.calls.push(`${method} ${path}${target.search}`);
    if (method === "POST" && path === "/agents") {
      const body = JSON.parse(String(init?.body)) as { name: string; public_key: string };
      agentKeys.set(body.name, body.public_key);
      return Response.json({ agent_token: `tok-${body.name}` });
    }
    if (method === "GET" && /^\/a\/[^/]+$/.test(path)) return Response.json({ public_key: agentKeys.get(path.split("/")[2]) });
    if (method === "POST" && /^\/a\/[^/]+\/invites$/.test(path)) {
      room.invites.push({ id: "inv-1", from: JSON.parse(String(init?.body)).from, created_at: "now", sealed: JSON.parse(String(init?.body)).sealed });
      return Response.json({ id: "inv-1" });
    }
    if (method === "GET" && path.endsWith("/wait")) return Response.json(room.invites.length ? { invites: room.invites } : { timeout: true });
    if (method === "DELETE" && /^\/a\/[^/]+\/invites\//.test(path)) {
      room.invites = [];
      return Response.json({ ok: true });
    }
    if (path.startsWith("/r/") && !room.alive) return Response.json({ error: "room not found" }, { status: 404 });
    if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-1" });
    if (method === "PATCH") {
      room.profiles.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, participant: {} });
    }
    if (path.endsWith("/asks")) return Response.json({ asks: room.asks });
    if (path.endsWith("/board")) return Response.json({ board: {}, board_schema: null });
    if (path.endsWith("/participants")) return Response.json({ participants: [...room.joined].map((id) => ({ id })) });
    if (method === "GET" && path.startsWith("/r/")) return Response.json({ cursor: 0, messages: [] });
    if (method === "POST") return Response.json({ ok: true, seq: 1 });
    return Response.json({ ok: true });
  };
  return handler as unknown as typeof fetch;
}

/** A PUT join marks that participant as present in the room. */
function trackJoins() {
  const base = serve();
  return async (url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") room.joined.add(new URL(String(url)).pathname.split("/").pop()!);
    return base(url, init);
  };
}

/** Every ambient model variable is pinned away: a test must never announce the model running vitest. */
function pinEnv() {
  vi.stubEnv("BASE_URL", "https://j01n.me");
  vi.stubEnv("J01N_AGENT_DIR", ""); // identities live in the test directory, even from a spawned pane
  for (const name of ["PI_MODEL", "PI_PROVIDER", "ANTHROPIC_MODEL", "OPENAI_MODEL", "J01N_MODEL", "J01N_PROVIDER",
    "J01N_WORKER_CAPABILITIES", "J01N_PEER_ROLE", "J01N_PEER_SKILLS", "J01N_PEER_PARTICIPANT_ID", "J01N_PEER_ROOM_ID",
    "J01N_KEY_DIR", "J01N_AUTOJOIN", "ROOM_URL", "JOIN_SECRET", "ME"]) vi.stubEnv(name, "");
}

async function seedAgent(name: string) {
  const { runj01n } = await import("../commands");
  await runj01n(["register", name]);
}

const ask = (id: string, from: string) => ({
  ask_id: id, seq: 1, from, due_at: new Date(Date.now() + 60_000).toISOString(), overdue: false,
  message: { id: `msg-${id}`, seq: 1, from, to: "all", intent: "ask", kind: "question", body: { text: `open question ${id}` }, created_at: new Date().toISOString() },
});

describe("autojoinRoom", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    room = { calls: [], profiles: [], joined: new Set(), asks: [], invites: [], alive: true };
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-autojoin-")));
    pinEnv();
    vi.stubGlobal("fetch", trackJoins());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("resumes the one room profile of this directory and counts open questions", async () => {
    const { runj01n, autojoinRoom } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "worker-4", "--no-workspace"]);
    room.calls = [];
    room.asks = [ask("a", "hermes-bot"), ask("b", "host")];

    expect(await autojoinRoom()).toEqual({ via: "resume", room_id: "room-1", participant_id: "worker-4", open_questions: 2 });
    // A resume never re-joins: no PUT for the participant, only reads.
    expect(room.calls.some((call) => call.startsWith("PUT"))).toBe(false);
    expect(room.calls).toContain("GET /r/room-1/participants");
    expect(room.calls).toContain("GET /r/room-1/asks");
  });

  it("stays silent when the saved profile no longer reaches a room (expired, left)", async () => {
    const { runj01n, autojoinRoom } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "worker-4", "--no-workspace"]);
    room.joined.delete("worker-4"); // the room answers, but we are not in it any more
    expect(await autojoinRoom()).toBeUndefined();

    room.alive = false; // the room itself is gone
    expect(await autojoinRoom()).toBeUndefined();
  });

  it("refuses to guess while several rooms are active in this directory", async () => {
    const { runj01n, autojoinRoom } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "worker-4", "--no-workspace"]);
    await runj01n(["join", "https://j01n.me/r/room-2", "secret", "worker-4", "--no-workspace"]);
    room.calls = [];
    expect(await autojoinRoom()).toBeUndefined();
    expect(room.calls).toEqual([]);
  });

  it("opens the one seeded inbox with a single bounded listen and joins", async () => {
    const { autojoinRoom, AUTOJOIN_LISTEN_SECONDS } = await import("../commands");
    await seedAgent("hermes-bot");
    await seedAgent("worker-4");
    const { runj01n } = await import("../commands");
    await runj01n(["invite", "hermes-bot", "worker-4", LINK]);
    rmSync(".j01n-agent-hermes-bot.json"); // a worker worktree holds only its own seed
    room.calls = [];

    const joined = await autojoinRoom();
    expect(joined).toMatchObject({ via: "listen", room_id: "room-1", participant_id: "worker-4", open_questions: 0 });
    expect(room.calls).toContain(`GET /a/worker-4/wait?timeout=${AUTOJOIN_LISTEN_SECONDS}`);
    expect(room.calls).toContain("DELETE /a/worker-4/invites/inv-1");
    expect(room.calls).toContain("PUT /r/room-1/participants/worker-4");
    // The invitation is spent: a second boot cannot consume another one.
    expect(room.invites).toEqual([]);
  });

  it("does nothing when the seeded inbox has no invitation yet (one bounded wait, no retry loop)", async () => {
    const { autojoinRoom } = await import("../commands");
    await seedAgent("worker-4");
    room.calls = [];
    expect(await autojoinRoom()).toBeUndefined();
    expect(room.calls.filter((call) => call.includes("/wait"))).toHaveLength(1);
    expect(room.calls.some((call) => call.startsWith("PUT"))).toBe(false);
  });

  it("announces the runner's capabilities, and no model when the session reports none", async () => {
    // PI_MODEL and friends stay pinned empty (pinEnv): a test must never announce the model running vitest.
    vi.stubEnv("J01N_WORKER_CAPABILITIES", "code,files");
    const { autojoinRoom } = await import("../commands");
    await seedAgent("hermes-bot");
    await seedAgent("worker-4");
    const { runj01n } = await import("../commands");
    await runj01n(["invite", "hermes-bot", "worker-4", LINK]);
    rmSync(".j01n-agent-hermes-bot.json");

    expect(await autojoinRoom()).toMatchObject({ via: "listen", participant_id: "worker-4" });
    expect(room.profiles).toContainEqual(expect.objectContaining({ capabilities: ["code", "files"], harness: "pi" }));
    expect(room.profiles.some((profile) => profile.model || profile.provider)).toBe(false);
  });

  it("leaves a directory without any j01n state completely alone", async () => {
    const { autojoinRoom } = await import("../commands");
    expect(await autojoinRoom()).toBeUndefined();
    expect(readdirSync(".")).toEqual([]);
    expect(room.calls).toEqual([]);
  });

  it("keeps a spawned peer inside its own room identity", async () => {
    vi.stubEnv("J01N_PEER_PARTICIPANT_ID", "ravi");
    vi.stubEnv("J01N_PEER_ROOM_ID", "room-1");
    const { runj01n, autojoinRoom } = await import("../commands");
    await seedAgent("worker-4"); // a foreign seed in a shared checkout must not be opened by a peer
    await runj01n(["join", ROOM, "secret", "ravi", "--no-workspace"]);
    room.calls = [];
    expect(await autojoinRoom()).toMatchObject({ via: "resume", participant_id: "ravi", open_questions: 0 });
    expect(room.calls.some((call) => call.includes("/a/worker-4/"))).toBe(false);
  });

  it("is switched off by J01N_AUTOJOIN=off", async () => {
    vi.stubEnv("J01N_AUTOJOIN", "off");
    const { runj01n, autojoinRoom } = await import("../commands");
    await runj01n(["join", ROOM, "secret", "worker-4", "--no-workspace"]);
    expect(await autojoinRoom()).toBeUndefined();
  });
});

describe("autojoinNote", () => {
  it("is one short line without a room link, a secret or message content", async () => {
    const { autojoinNote } = await import("../commands");
    expect(autojoinNote({ via: "resume", room_id: "room-1", participant_id: "worker-4", open_questions: 0 })).toBe("j01n: joined room-1 as worker-4; 0 open questions");
    expect(autojoinNote({ via: "listen", room_id: "room-1", participant_id: "worker-4", open_questions: 1 })).toBe("j01n: joined room-1 as worker-4; 1 open question");
    const line = autojoinNote({ via: "listen", room_id: "room-1", participant_id: "worker-4", open_questions: 3 });
    expect(line).not.toMatch(/http|#|secret|token/);
  });
});

describe("Pi session start auto-join", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    room = { calls: [], profiles: [], joined: new Set(), asks: [], invites: [], alive: true };
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-boot-")));
    pinEnv();
    vi.stubGlobal("fetch", trackJoins());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

  /** The extension's session_start handlers, in registration order. */
  async function boot(harness: { sendMessage: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }, handlers: Map<string, Handler[]>, hasUI: boolean) {
    const extension = (await import("../index")).default;
    extension({
      on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerCommand: () => undefined,
      registerTool: () => undefined,
      sendMessage: harness.sendMessage,
    } as unknown as ExtensionAPI);
    const start = handlers.get("session_start")!;
    const ctx = { hasUI, ui: { notify: harness.notify }, model: undefined };
    for (const handler of [start[0], start[1]]) await handler({ type: "session_start", reason: "startup" }, ctx);
    return start;
  }

  it("joins a seeded identity before the first model turn and notes it once", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "hermes-bot"]);
    await runj01n(["register", "worker-4"]);
    await runj01n(["invite", "hermes-bot", "worker-4", LINK]);
    rmSync(".j01n-agent-hermes-bot.json");

    const sendMessage = vi.fn();
    const notify = vi.fn();
    const handlers = new Map<string, Handler[]>();
    await boot({ sendMessage, notify }, handlers, true);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const message = sendMessage.mock.calls[0][0] as { customType: string; content: string; display: boolean };
    expect(message.content).toBe("j01n: joined room-1 as worker-4; 0 open questions");
    expect(message.customType).toBe("j01n");
    expect(message.display).toBe(true);
    // Live mode resumes in the same boot: the joined room is one of the delivered rooms.
    expect(readdirSync(".")).toContain(".j01n-rooms");
    expect(handlers.get("session_start")!.length).toBeGreaterThan(2);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining(LINK), expect.anything());
  });

  it("leaves a headless run alone, then attempts one bounded join per process", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "worker-4"]); // a seeded inbox with no invitation waiting
    const sendMessage = vi.fn();
    const handlers = new Map<string, Handler[]>();
    await boot({ sendMessage, notify: vi.fn() }, handlers, false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(handlers.get("session_start")!.length).toBeGreaterThan(2);
    // headless (pi -p, json): not even one inbox read, so nothing slows the run down
    expect(room.calls.filter((call) => call.includes("/wait"))).toHaveLength(0);

    const interactive = { hasUI: true, ui: { notify: vi.fn() } };
    const start = handlers.get("session_start")![1]!;
    await start({ type: "session_start", reason: "startup" }, interactive);
    expect(sendMessage).not.toHaveBeenCalled(); // no invitation and no room profile: silent
    const waits = room.calls.filter((call) => call.includes("/wait")).length;
    expect(waits).toBeGreaterThan(0);

    // A second session_start in the same process (new/resume/reload) makes no second attempt.
    await start({ type: "session_start", reason: "new" }, interactive);
    expect(room.calls.filter((call) => call.includes("/wait"))).toHaveLength(waits);
  });
});
