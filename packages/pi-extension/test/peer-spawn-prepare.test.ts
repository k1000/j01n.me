import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const link = "https://j01n.me/room/demo#secret-for-demo";
const status = { room: { room_id: "demo", host_id: "host", max_participants: 7 }, participants: [{ id: "host" }], closed: false, expires_at: "2099-01-01T00:00:00Z" };

describe("agent-led room peer preparation", () => {
  const cwd = process.cwd();
  const requests: string[] = [];
  let identityDir: string;
  beforeEach(() => {
    process.chdir(mkdtempSync(join(tmpdir(), "j01n-peer-prepare-")));
    identityDir = mkdtempSync(join(tmpdir(), "j01n-private-"));
    vi.stubEnv("J01N_AGENT_DIR", identityDir);
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_WORKSPACE_ID", "w");
    vi.stubEnv("HERDR_PANE_ID", "w:p1");
    requests.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "host-token" });
      if (method === "POST" && String(url).endsWith("/agents")) return Response.json({ agent_token: "agent-token" });
      if (String(url).endsWith("/status")) return Response.json(status);
      if (String(url).endsWith("/board")) return Response.json({ board: {}, board_schema: null });
      if (String(url).endsWith("/participants")) return Response.json({ participants: status.participants });
      return Response.json({ cursor: 0, messages: [] });
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); process.chdir(cwd); });

  it("does not expose a raw spawn command that bypasses the session budget", async () => {
    const { runj01n } = await import("../commands");
    await expect(runj01n(["spawn_herdr", "host", link, "reviewer", "Review docs"])).rejects.toThrow("unknown command");
  });

  it("selects the joined hosted room and auto-registers a private sender identity", async () => {
    const { runj01n, prepareRoomPeerSpawn } = await import("../commands");
    await runj01n(["join", link, "host", "--no-workspace"]);
    const prepared = await prepareRoomPeerSpawn({ task: "Review SDK", role: "reviewer", name: "reviewer" });
    expect(prepared).toMatchObject({ link, displayName: "reviewer", role: "reviewer", task: "Review SDK", identityDir });
    expect(prepared.name).toMatch(/^reviewer-[a-f0-9]{8}$/);
    expect(prepared.sender.name).toMatch(/^host-[0-9a-f]{16}$/);
    expect(prepared.client.participantId).toBe("host");
    expect(existsSync(join(identityDir, `.j01n-agent-${prepared.sender.name}.json`))).toBe(true);
    expect(JSON.stringify(prepared)).toContain("secret-for-demo"); // only internal; model-facing tool returns no link
    expect(requests.filter((r) => r.endsWith("/agents"))).toHaveLength(1);
    const again = await prepareRoomPeerSpawn({ task: "Another review" });
    expect(again.sender.name).toBe(prepared.sender.name);
    expect(requests.filter((r) => r.endsWith("/agents"))).toHaveLength(1);
  });

  it("chooses a free friendly name and rejects a duplicate requested name", async () => {
    const { runj01n, prepareRoomPeerSpawn } = await import("../commands");
    await runj01n(["join", link, "host", "--no-workspace"]);
    await expect(prepareRoomPeerSpawn({ task: "Help", name: "host" })).rejects.toThrow("already in the room");
    const prepared = await prepareRoomPeerSpawn({ task: "Help" });
    expect(prepared.displayName).toMatch(/^(Maya|Ravi|Lena|Omar|Ines|Kenji|Nora|Amira|Sofia|Tariq|Asha|Leo|Zara|Yuki|Nia|Arjun)$/);
    expect(prepared.name).toMatch(new RegExp(`^${prepared.displayName.toLowerCase()}-[a-f0-9]{8}$`));
  });

  it("reuses a fallback sender address if the preferred host address is taken", async () => {
    const baseFetch = globalThis.fetch;
    let first = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (first && init?.method === "POST" && String(url).endsWith("/agents")) {
        first = false;
        requests.push(`POST ${url}`);
        return Response.json({ error: "taken" }, { status: 409 });
      }
      return baseFetch(url, init);
    });
    const { runj01n, prepareRoomPeerSpawn } = await import("../commands");
    await runj01n(["join", link, "host", "--no-workspace"]);
    const firstAttempt = await prepareRoomPeerSpawn({ task: "Review SDK" });
    const again = await prepareRoomPeerSpawn({ task: "Review SDK" });
    expect(again.sender.name).toBe(firstAttempt.sender.name);
    expect(requests.filter((r) => r.endsWith("/agents"))).toHaveLength(2);
  });

  it("rejects missing or ambiguous rooms before registering an inbox", async () => {
    const { runj01n, prepareRoomPeerSpawn } = await import("../commands");
    await expect(prepareRoomPeerSpawn({ task: "Review docs" })).rejects.toThrow("no hosted room");
    await runj01n(["join", link, "host", "--no-workspace"]);
    await runj01n(["join", "https://j01n.me/room/other#other-secret", "host", "--no-workspace"]);
    await expect(prepareRoomPeerSpawn({ task: "Review docs" })).rejects.toThrow("multiple hosted rooms");
    expect((await prepareRoomPeerSpawn({ task: "Review docs", roomId: "demo" })).client.invite.room_id).toBe("demo");
  });

  it("rejects an identity directory on exFAT before registering an inbox", async () => {
    if (process.platform !== "darwin") return;
    const { runj01n, prepareRoomPeerSpawn } = await import("../commands");
    await runj01n(["join", link, "host", "--no-workspace"]);
    vi.stubEnv("J01N_AGENT_DIR", cwd);
    await expect(prepareRoomPeerSpawn({ task: "Review docs" })).rejects.toThrow("private absolute directory");
    expect(requests.filter((r) => r.endsWith("/agents"))).toHaveLength(0);
  });

  it("asks the agent to rejoin when an old saved profile lacks the room secret", async () => {
    const { runj01n } = await import("../commands");
    await runj01n(["join", link, "host", "--no-workspace"]);
    const keyFile = readdirSync(".").find((f) => f.startsWith(".j01n-") && f.endsWith("-host.json"))!;
    const { joinSecret: _secret, ...legacy } = JSON.parse(readFileSync(keyFile, "utf8"));
    writeFileSync(keyFile, JSON.stringify(legacy));
    vi.resetModules();
    const { prepareRoomPeerSpawn } = await import("../commands");
    await expect(prepareRoomPeerSpawn({ task: "Review docs" })).rejects.toThrow("rejoin");
  });
});
