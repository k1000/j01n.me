import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@j01n/sdk", async (original) => ({ ...await original<typeof import("@j01n/sdk")>(), waitForInvites: vi.fn(), deleteInvite: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn(() => JSON.stringify({ participant_id: "maya", participant_token: "private-token", key_file: "/private/key" })) }));

const argv = process.argv;
const exitCode = process.exitCode;
let dir: string;
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("standalone CLI listen for a spawned Claude peer", () => {
  it("keeps a mismatched sealed invite pending without starting a join", async () => {
    dir = mkdtempSync(join(tmpdir(), "j01n-claude-cli-"));
    writeFileSync(join(dir, ".j01n-agent-reviewer.json"), JSON.stringify({ name: "reviewer", base: "https://j01n.me", agentToken: "private-token" }));
    vi.stubEnv("J01N_KEY_DIR", dir);
    vi.stubEnv("J01N_PEER_ROLE", "reviewer");
    vi.stubEnv("J01N_PEER_ROOM_ID", "demo");
    vi.stubEnv("J01N_HARNESS", "claude");
    vi.stubEnv("J01N_PEER_SKILLS", "my-reviewer");
    const sdk = await import("@j01n/sdk");
    const run = await import("node:child_process");
    vi.mocked(sdk.waitForInvites).mockResolvedValue([{ id: "i2", from: "host", room_link: "https://j01n.me/room/other#private-secret", created_at: "now" }]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.argv = [process.execPath, "cli.ts", "listen", "reviewer"];
    await import("../src/cli");
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("invitation is for a different room"));
    expect(sdk.deleteInvite).not.toHaveBeenCalled();
    expect(run.execFileSync).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private-secret");
  });

  it("pins the participant and role, drops forged join flags, and checks the room before consuming the invite", async () => {
    dir = mkdtempSync(join(tmpdir(), "j01n-claude-cli-"));
    writeFileSync(join(dir, ".j01n-agent-reviewer.json"), JSON.stringify({ name: "reviewer", base: "https://j01n.me", agentToken: "private-token" }));
    vi.stubEnv("J01N_KEY_DIR", dir);
    vi.stubEnv("J01N_PEER_PARTICIPANT_ID", "maya");
    vi.stubEnv("J01N_PEER_ROLE", "reviewer");
    vi.stubEnv("J01N_PEER_ROOM_ID", "demo");
    vi.stubEnv("J01N_HARNESS", "claude");
    vi.stubEnv("J01N_PEER_SKILLS", "my-reviewer");
    const sdk = await import("@j01n/sdk");
    const run = await import("node:child_process");
    vi.mocked(sdk.waitForInvites).mockResolvedValue([{ id: "i1", from: "host", room_link: "https://j01n.me/room/demo#private-secret", created_at: "now" }]);
    vi.mocked(sdk.deleteInvite).mockResolvedValue();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = [process.execPath, "cli.ts", "listen", "reviewer", "--as", "intruder", "--role", "owner", "--skills", "fake", "--model", "wrong", "--provider", "wrong", "--harness", "wrong"];
    await import("../src/cli");
    await vi.waitFor(() => expect(run.execFileSync).toHaveBeenCalled());
    const args = vi.mocked(run.execFileSync).mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(["join", "--role", "reviewer", "--skills", "my-reviewer"]));
    expect(JSON.stringify(args)).not.toMatch(/private-secret|private-token/);
    expect(vi.mocked(run.execFileSync).mock.calls[0][2]).toMatchObject({ env: { ROOM_URL: "https://j01n.me/r/demo", JOIN_SECRET: "private-secret", ME: "maya", PARTICIPANT_TOKEN: "", J01N_HARNESS: "claude" } });
    expect(args).not.toContain("intruder");
    expect(args).not.toContain("owner");
    expect(args).not.toContain("fake");
    expect(args).not.toContain("wrong");
    expect(sdk.deleteInvite).toHaveBeenCalledWith(expect.anything(), "i1");
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private-secret|private-token/);
  });
});
