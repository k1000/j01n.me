import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@j01n/sdk", () => ({ inviteAgent: vi.fn() }));
vi.mock("../commands", () => ({ prepareRoomPeerSpawn: vi.fn() }));
import { inviteAgent } from "@j01n/sdk";
import { prepareRoomPeerSpawn } from "../commands";
import { registerIntegratorTool } from "../integrator";

const link = "https://j01n.me/r/demo#private-secret";
const sender = { name: "host-stable", base: "https://j01n.me" };
const status = { room: { host_id: "host", max_participants: 3 }, participants: [{ id: "host" }], closed: false, expires_at: "2099-01-01T00:00:00Z" };
const client = { participantId: "host", status: vi.fn(async () => status) };
const context = { sessionManager: { getSessionId: () => "session-1" } };
let input: (event: { source: "interactive" | "rpc" | "extension" }, ctx: typeof context) => void;
let execute: (...args: any[]) => Promise<{ isError?: boolean; content: Array<{ text: string }>; details: unknown }>;

beforeEach(() => {
  client.participantId = "host";
  client.status.mockResolvedValue(status);
  vi.mocked(inviteAgent).mockReset();
  vi.mocked(prepareRoomPeerSpawn).mockReset().mockResolvedValue({ client, sender, link } as never);
  registerIntegratorTool({
    on: (_name: string, handler: typeof input) => { input = handler; },
    registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; },
  } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const call = (name = "integrator-inbox", ctx = context) => execute("call", { name }, undefined, undefined, ctx);

describe("invite_integrator", () => {
  it("requires current-session direct human delegation, not a room message", async () => {
    expect((await call()).isError).toBe(true);
    input({ source: "extension" }, context);
    expect((await call()).isError).toBe(true);
    input({ source: "interactive" }, context);
    expect((await call("integrator-inbox", { sessionManager: { getSessionId: () => "another" } })).isError).toBe(true);
    expect(prepareRoomPeerSpawn).not.toHaveBeenCalled();
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("queues a sealed invitation without disclosing the link and reports the host-only owner promotion", async () => {
    input({ source: "rpc" }, context);
    const result = await call();
    expect(inviteAgent).toHaveBeenCalledWith(sender, "integrator-inbox", link);
    expect(result.details).toEqual({ name: "integrator-inbox", queued: true });
    expect(result.content[0].text).toContain("/j01n profile <id> --role owner");
    expect(result.content[0].text).toContain("listen integrator-inbox --as <id>");
    expect(JSON.stringify(result)).not.toContain(link);
  });

  it("rejects invalid inbox names and unavailable rooms without sending an invite", async () => {
    input({ source: "interactive" }, context);
    expect((await call("bad name")).isError).toBe(true);
    expect(prepareRoomPeerSpawn).not.toHaveBeenCalled();
    client.participantId = "guest";
    expect((await call()).isError).toBe(true);
    client.participantId = "host";
    client.status.mockResolvedValueOnce({ ...status, closed: true });
    expect((await call()).isError).toBe(true);
    client.status.mockResolvedValueOnce({ ...status, participants: [{ id: "host" }, { id: "one" }, { id: "two" }] });
    expect((await call()).isError).toBe(true);
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("refuses a fallback sender when the configured inbox is unavailable", async () => {
    vi.stubEnv("J01N_HOST_INBOX", "host-expected");
    input({ source: "interactive" }, context);
    expect((await call()).isError).toBe(true);
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("never includes secret-bearing SDK errors in tool output", async () => {
    input({ source: "interactive" }, context);
    vi.mocked(inviteAgent).mockRejectedValue(new Error(link));
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(link);
  });
});
