import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../herdr", () => ({ listHerdrPeers: vi.fn(), notifyHerdrPeer: vi.fn() }));
import { listHerdrPeers, notifyHerdrPeer } from "../herdr";

const link = "https://j01n.me/room/demo#very-secret-join-secret";
const peers = [
  { pane_id: "wV:p1", agent: "claude", agent_status: "idle" },
  { pane_id: "wV:p3", agent: "pi", agent_status: "working" },
];

describe("invite_herdr", () => {
  const originalCwd = process.cwd();
  const keys = new Map<string, string>();
  const requests: Array<{ method: string; url: string; body: string }> = [];
  let deniedAddress: string | undefined;

  beforeEach(() => {
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-herdr-")));
    keys.clear();
    requests.length = 0;
    deniedAddress = undefined;
    vi.stubEnv("BASE_URL", "https://j01n.me");
    vi.mocked(listHerdrPeers).mockReset().mockReturnValue(peers);
    vi.mocked(notifyHerdrPeer).mockReset();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      requests.push({ method, url: String(url), body });
      if (method === "POST" && String(url).endsWith("/agents")) {
        const data = JSON.parse(body);
        keys.set(data.name, data.public_key);
        return Response.json({ agent_token: `token-${data.name}` });
      }
      if (method === "GET" && String(url).includes("/a/")) {
        const name = new URL(url).pathname.split("/").pop()!;
        return Response.json({ public_key: keys.get(name) });
      }
      if (method === "POST" && String(url).endsWith("/invites")) return String(url).includes(`/a/${deniedAddress}/`)
        ? Response.json({ error: "not allowlisted" }, { status: 403 })
        : Response.json({ id: "queued-1" });
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    process.chdir(originalCwd);
  });

  it("can store agent identities on private storage instead of the room's directory", async () => {
    const privateDir = join(mkdtempSync(join(tmpdir(), "j01n-private-")), "agents");
    vi.stubEnv("J01N_AGENT_DIR", privateDir);
    const { runj01n } = await import("../commands");
    await runj01n(["register", "sender"]);
    expect(existsSync(join(privateDir, ".j01n-agent-sender.json"))).toBe(true);
    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(existsSync(".j01n-agent-sender.json")).toBe(false);
    expect(JSON.parse(await runj01n(["herdr_agents"]))).toEqual({ agents: peers });
  });

  it("discovers peers without exposing room credentials", async () => {
    const { runj01n } = await import("../commands");
    expect(JSON.parse(await runj01n(["herdr_agents"]))).toEqual({ agents: peers });
    expect(requests).toEqual([]);
  });

  it("queues sealed invites for explicitly mapped panes, notifying only ready agents", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "sender"]);
    await runj01n(["register", "claude-address", "sender"]);
    await runj01n(["register", "pi-address", "sender"]);
    requests.length = 0;

    const result = JSON.parse(await runj01n(["invite_herdr", "sender", link, "wV:p1=claude-address", "wV:p3=pi-address"]));
    expect(result).toEqual({ ok: true, invited: [
      { pane_id: "wV:p1", address: "claude-address", queued: true, notified: true },
      { pane_id: "wV:p3", address: "pi-address", queued: true, notified: false },
    ] });
    expect(requests.filter((r) => r.url.endsWith("/invites"))).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain("very-secret-join-secret");
    expect(JSON.stringify(result)).not.toContain("very-secret-join-secret");
    expect(notifyHerdrPeer).toHaveBeenCalledTimes(1);
    expect(notifyHerdrPeer).toHaveBeenCalledWith("wV:p1", expect.stringContaining("claude-address"));
    expect(JSON.stringify(vi.mocked(notifyHerdrPeer).mock.calls)).not.toContain("very-secret-join-secret");
  });

  it("rejects unknown panes, duplicate addresses and malformed room links before sending", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "sender"]);
    requests.length = 0;
    for (const targets of [["wV:p9=other"], ["wV:p1=one", "wV:p3=one"], ["wV:p1=one", "wV:p1=two"]]) {
      await expect(runj01n(["invite_herdr", "sender", link, ...targets])).rejects.toThrow();
    }
    await expect(runj01n(["invite_herdr", "sender", "https://j01n.me/r/demo", "wV:p1=one"])).rejects.toThrow("room link");
    expect(requests).toEqual([]);
  });

  it("reports allowlist failures per recipient without hiding successfully submitted invites", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "sender"]);
    await runj01n(["register", "claude-address", "sender"]);
    await runj01n(["register", "pi-address", "sender"]);
    deniedAddress = "pi-address";
    const result = JSON.parse(await runj01n(["invite_herdr", "sender", link, "wV:p1=claude-address", "wV:p3=pi-address"]));
    expect(result.ok).toBe(false);
    expect(result.invited[0]).toMatchObject({ queued: true, notified: true });
    expect(result.invited[1]).toMatchObject({ queued: false, notified: false, error: expect.stringContaining("403") });
    expect(JSON.stringify(result)).not.toContain("very-secret-join-secret");
  });

  it("reports a queued invitation even when a Herdr notification fails", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["register", "sender"]);
    await runj01n(["register", "claude-address", "sender"]);
    vi.mocked(notifyHerdrPeer).mockImplementation(() => { throw new Error("agent unavailable"); });
    const result = JSON.parse(await runj01n(["invite_herdr", "sender", link, "wV:p1=claude-address"]));
    expect(result.invited).toEqual([{ pane_id: "wV:p1", address: "claude-address", queued: true, notified: false }]);
  });
});
