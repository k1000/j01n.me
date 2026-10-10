import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentity, RoomClient } from "@j01n/sdk";

vi.mock("../herdr", () => ({ listHerdrRepoAgents: vi.fn(), promptHerdrAgent: vi.fn() }));
vi.mock("@j01n/sdk", () => ({ inviteAgent: vi.fn() }));
vi.mock("../commands", () => ({ activeRoomClients: vi.fn(), prepareRoomPeerSpawn: vi.fn() }));
import { inviteAgent } from "@j01n/sdk";
import { listHerdrRepoAgents, promptHerdrAgent } from "../herdr";
import { activeRoomClients } from "../commands";
import { inviteRepoAgents, isExternalStorage, repoInviteCandidates, registerRepoInviteTool } from "../repo-invite";

const link = "https://j01n.me/room/demo#private-join-secret";
const sender = { name: "host-123", base: "https://j01n.me" } as AgentIdentity;
const host = { id: "asha", workspace: { path: "/other", repo: "repo", branch: "main", host: "machine" } };
const status = { room: { host_id: "asha", max_participants: 10 }, participants: [{ id: "asha" }], closed: false, expires_at: "2099-01-01T00:00:00Z" };
const peer = (pane_id: string, cwd: string, name: string, agent_status = "idle") => ({ pane_id, cwd, name, agent: "pi", agent_status, workspace_id: "w2" });

let client: Pick<RoomClient, "status" | "team" | "participantId">;
let root: string;
let other: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "j01n-repo-invite-"));
  execFileSync("git", ["init", "-q", root]);
  other = mkdtempSync(join(tmpdir(), "j01n-other-invite-"));
  execFileSync("git", ["init", "-q", other]);
  client = { participantId: "asha", status: vi.fn(async () => status), team: vi.fn(async () => [host]) } as unknown as typeof client;
  vi.mocked(listHerdrRepoAgents).mockReset().mockReturnValue([peer("w2:p1", root, "maya-11111111"), peer("w2:p2", other, "leo-22222222")]);
  vi.mocked(promptHerdrAgent).mockReset();
  vi.mocked(inviteAgent).mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({}, { status: String(url).includes("-12345678") ? 404 : 200 })));
  vi.spyOn(crypto, "randomUUID").mockReturnValue("12345678-aaaa-bbbb-cccc-aaaaaaaaaaaa");
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("repo agent invitations", () => {
  it("finds all workspaces in the same git common dir, excluding joined agent and other repos", async () => {
    const nested = join(root, "nested");
    mkdirSync(nested);
    vi.mocked(listHerdrRepoAgents).mockReturnValue([
      peer("w2:p1", nested, "maya-11111111"), peer("w2:p2", other, "leo-22222222"), peer("w2:p3", root, "arjun-33333333"),
    ]);
    client.team = vi.fn(async () => [host, { id: "arjun", workspace: { path: root } }]) as unknown as typeof client.team;
    expect((await repoInviteCandidates(client, root)).map((item) => item.pane_id)).toEqual(["w2:p1"]);
    expect(await inviteRepoAgents(client, sender, link, true, root)).toMatchObject({ candidates: [{ pane_id: "w2:p1" }] });
    expect(promptHerdrAgent).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes other worktrees sharing a git common directory", async () => {
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-qm", "initial"]);
    const worktree = join(mkdtempSync(join(tmpdir(), "j01n-worktree-parent-")), "checkout");
    execFileSync("git", ["-C", root, "worktree", "add", "-qb", "test-worktree", worktree]);
    vi.mocked(listHerdrRepoAgents).mockReturnValue([peer("w2:p1", worktree, "maya")]);
    expect((await repoInviteCandidates(client, root)).map((item) => item.cwd)).toEqual([worktree]);
  });

  it("requires joined host before touching any Herdr pane", async () => {
    client.participantId = "guest";
    await expect(inviteRepoAgents(client, sender, link, false, root)).rejects.toThrow("host");
    expect(listHerdrRepoAgents).not.toHaveBeenCalled();
  });

  it("resolves symlinks before deciding whether CLI identities would be written on external storage", () => {
    const link = join(mkdtempSync(join(tmpdir(), "j01n-storage-check-")), "external");
    symlinkSync("/Volumes", link);
    expect(isExternalStorage(root)).toBe(false);
    expect(isExternalStorage(link)).toBe(true);
  });

  it("uses the downloaded Node CLI helper for non-Pi agents, not an uninstalled j01n binary", async () => {
    vi.mocked(listHerdrRepoAgents).mockReturnValue([{ ...peer("w2:p1", root, "claude-agent"), agent: "claude" }]);
    let registered = false;
    vi.mocked(promptHerdrAgent).mockImplementation(() => { registered = true; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: registered ? 200 : 404 })));
    expect(await inviteRepoAgents(client, sender, link, false, root)).toMatchObject({ results: [{ status: "invited" }] });
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).toContain("node .j01n/j01n.js register claude-agent-12345678 host-123");
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).toContain("https://j01n.me/cli.md");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("node .j01n/j01n.js listen claude-agent-12345678 to join");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).not.toContain("--as");
    expect(JSON.stringify(vi.mocked(promptHerdrAgent).mock.calls)).not.toContain("private-join-secret");
  });

  it("does not ask a peer to claim an already registered address", async () => {
    vi.mocked(crypto.randomUUID).mockReturnValueOnce("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").mockReturnValueOnce("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    let registered = false;
    vi.mocked(promptHerdrAgent).mockImplementation(() => { registered = true; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json({}, {
      status: String(url).endsWith("-aaaaaaaa") || registered ? 200 : 404,
    })));
    expect(await inviteRepoAgents(client, sender, link, false, root)).toMatchObject({ results: [{ address: "maya-11111111-bbbbbbbb", status: "invited" }] });
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).not.toContain("-aaaaaaaa");
  });

  it("does not send invitations beyond the room capacity", async () => {
    client.status = vi.fn(async () => ({ ...status, room: { ...status.room, max_participants: 1 } })) as unknown as typeof client.status;
    expect(await inviteRepoAgents(client, sender, link, false, root)).toMatchObject({ results: [{ status: "failed" }] });
    expect(promptHerdrAgent).not.toHaveBeenCalled();
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("registers a fresh address, queues the sealed invitation, and prompts to listen without exposing the link", async () => {
    let registered = false;
    vi.mocked(promptHerdrAgent).mockImplementation((_pane, message) => { if (message.includes(" register ")) registered = true; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: registered ? 200 : 404 })));
    const result = await inviteRepoAgents(client, sender, link, false, root);
    expect(result).toMatchObject({ results: [{ pane: "w2:p1", status: "invited", address: "maya-11111111-12345678" }] });
    expect(inviteAgent).toHaveBeenCalledWith(sender, "maya-11111111-12345678", link);
    expect(vi.mocked(promptHerdrAgent).mock.calls[0][1]).toContain("register maya-11111111-12345678 host-123");
    expect(vi.mocked(promptHerdrAgent).mock.calls[1][1]).toContain("listen maya-11111111-12345678 --as maya-11111111");
    expect(JSON.stringify(result) + JSON.stringify(vi.mocked(promptHerdrAgent).mock.calls)).not.toContain("private-join-secret");
  });

  it("reports busy after 60 seconds without registering or sending anything", async () => {
    vi.useFakeTimers();
    vi.mocked(listHerdrRepoAgents).mockReturnValue([peer("w2:p1", root, "maya", "working")]);
    const result = inviteRepoAgents(client, sender, link, false, root);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ results: [{ status: "busy" }] });
    expect(promptHerdrAgent).not.toHaveBeenCalled();
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("reports not_registered after 180 seconds; never sends an invite", async () => {
    vi.useFakeTimers();
    const result = inviteRepoAgents(client, sender, link, false, root);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await result).toMatchObject({ results: [{ status: "not_registered" }] });
    expect(inviteAgent).not.toHaveBeenCalled();
  });

  it("refuses room-sourced calls and permits direct human-delegated dry runs", async () => {
    let input: (event: { source: "interactive" | "extension" }, ctx: unknown) => void = () => {};
    let execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> = async () => ({ content: [] });
    const context = { sessionManager: { getSessionId: () => "session-1" } };
    const pi = {
      on: (_event: string, handler: typeof input) => { input = handler; },
      registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; },
    };
    registerRepoInviteTool(pi as never);
    input({ source: "extension" }, context);
    expect((await execute("call", { dryRun: true }, undefined, undefined, context)).isError).toBe(true);
    expect(activeRoomClients).not.toHaveBeenCalled();
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "w2:p0");
    vi.stubEnv("HERDR_WORKSPACE_ID", "w2");
    vi.mocked(activeRoomClients).mockResolvedValue([{ ...client, invite: { room_id: "demo", join_secret: "secret" } }] as unknown as RoomClient[]);
    input({ source: "interactive" }, context);
    expect((await execute("call", { dryRun: true, roomId: "demo" }, undefined, undefined, context)).content[0].text).toContain("candidates");
    expect(promptHerdrAgent).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("does not leak secret-bearing SDK errors into per-agent results", async () => {
    vi.mocked(inviteAgent).mockRejectedValue(new Error(link));
    let registered = false;
    vi.mocked(promptHerdrAgent).mockImplementation(() => { registered = true; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: registered ? 200 : 404 })));
    const result = await inviteRepoAgents(client, sender, link, false, root);
    expect(result).toMatchObject({ results: [{ status: "failed" }] });
    expect(JSON.stringify(result)).not.toContain(link);
  });
});
