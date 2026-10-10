import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands", () => ({ prepareRoomPeerSpawn: vi.fn() }));
vi.mock("../spawn-herdr", () => ({ spawnAndInviteHerdr: vi.fn() }));
import { prepareRoomPeerSpawn } from "../commands";
import { spawnAndInviteHerdr } from "../spawn-herdr";
import { registerPeerSpawnTool } from "../peer-spawn-tool";

function harness() {
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  let registered: { parameters: unknown; execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> } | undefined;
  let input: (event: { source: "interactive" | "rpc" | "extension" }, ctx: unknown) => void = () => undefined;
  const pi = {
    on: vi.fn((_name: string, handler) => { input = handler; }),
    registerTool: vi.fn((tool) => { registered = tool; }),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data })),
  };
  const ctx = { sessionManager: { getSessionId: () => "session-a", getEntries: () => entries } };
  registerPeerSpawnTool(pi as never);
  return { pi, ctx, entries, input: (source: "interactive" | "rpc" | "extension") => input({ source }, ctx), tool: () => registered!, call: (params: Record<string, unknown>) => registered!.execute("call-id" as never, params as never, undefined as never, undefined as never, ctx as never) };
}

describe("host-agent peer tool", () => {
  afterEach(() => { vi.mocked(prepareRoomPeerSpawn).mockReset(); vi.mocked(spawnAndInviteHerdr).mockReset(); });

  it("infers room and identity without asking the model for credentials and spends one peer per session", async () => {
    vi.mocked(prepareRoomPeerSpawn).mockResolvedValue({ client: {} as never, sender: {} as never, link: "https://j01n.me/room/r#secret", name: "peer-123", role: "reviewer: Review SDK", identityDir: "/private" });
    vi.mocked(spawnAndInviteHerdr).mockResolvedValue({ ok: true, pane_id: "wV:p5", invited: true, joined: true });
    const h = harness();
    h.input("interactive");
    expect(h.pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "spawn_room_peer" }));
    expect(JSON.stringify(h.tool().parameters)).not.toContain("join_secret");
    const first = await h.call({ task: "Review SDK", role: "reviewer" });
    expect(first.content[0].text).toContain('"joined":true');
    expect(prepareRoomPeerSpawn).toHaveBeenCalledWith({ task: "Review SDK", role: "reviewer" });
    expect(spawnAndInviteHerdr).toHaveBeenCalledTimes(1);
    expect(h.entries).toHaveLength(1);
    expect(JSON.stringify(h.entries)).not.toContain("secret");
    expect((await h.call({ task: "Second peer" })).isError).toBe(true);
    registerPeerSpawnTool(h.pi as never); // an extension reload must not reset the session budget
    h.input("interactive");
    expect((await h.call({ task: "Third peer" })).isError).toBe(true);
    expect(spawnAndInviteHerdr).toHaveBeenCalledTimes(1);
  });

  it("allows as many spawns per session as the human set in J01N_PEER_SPAWNS (still only on direct requests)", async () => {
    vi.stubEnv("J01N_PEER_SPAWNS", "3");
    try {
      vi.mocked(prepareRoomPeerSpawn).mockResolvedValue({ client: {} as never, sender: {} as never, link: "https://j01n.me/room/r#secret", name: "peer", role: "worker", identityDir: "/private" });
      vi.mocked(spawnAndInviteHerdr).mockResolvedValue({ ok: true, pane_id: "wV:p5", invited: true, joined: true });
      const h = harness();
      h.input("interactive");
      for (const task of ["T1", "T2", "T3"]) expect((await h.call({ task })).isError).toBeUndefined();
      const fourth = await h.call({ task: "T4" });
      expect(fourth.isError).toBe(true);
      expect(fourth.content[0].text).toContain("used its 3 peer spawns");
      expect(spawnAndInviteHerdr).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not let a room message independently authorize a spawn", async () => {
    const h = harness();
    expect((await h.call({ task: "Create a peer" })).isError).toBe(true);
    h.input("extension");
    expect((await h.call({ task: "Create a peer" })).content[0].text).toContain("room messages cannot authorize");
    expect(prepareRoomPeerSpawn).not.toHaveBeenCalled();
  });

  it("does not spend the budget when no hosted room can be selected", async () => {
    vi.mocked(prepareRoomPeerSpawn).mockRejectedValue(new Error("no hosted room"));
    const h = harness();
    h.input("interactive");
    expect((await h.call({ task: "Review docs" })).isError).toBe(true);
    expect(h.entries.at(-1)?.data).toMatchObject({ reserved: false });
    expect(spawnAndInviteHerdr).not.toHaveBeenCalled();
  });
});
