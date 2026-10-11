import { describe, expect, it, vi } from "vitest";
import { labelHerdrPane, listHerdrPeers, splitHerdrPane, startHerdrAgent, promptHerdrAgent } from "../herdr";

const agents = [
  { agent: "pi", agent_status: "working", pane_id: "wV:p4", workspace_id: "wV" },
  { agent: "pi", agent_status: "idle", pane_id: "wV:p3", workspace_id: "wV" },
  { agent: "claude", agent_status: "done", pane_id: "wV:p1", workspace_id: "wV" },
  { agent: "pi", agent_status: "idle", pane_id: "wH:p1", workspace_id: "wH" },
];
const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wV", HERDR_PANE_ID: "wV:p4" };

describe("Herdr peer discovery", () => {
  it("requires a managed pane and lists only other agents in its workspace", () => {
    const run = vi.fn(() => JSON.stringify({ result: { agents } }));
    expect(listHerdrPeers(env, run)).toEqual([
      { agent: "pi", agent_status: "idle", pane_id: "wV:p3" },
      { agent: "claude", agent_status: "done", pane_id: "wV:p1" },
    ]);
    expect(run).toHaveBeenCalledWith("herdr", ["agent", "list"], expect.objectContaining({ encoding: "utf8" }));
  });

  it("splits a narrow current pane downward without focus, preserving cwd and secure agent storage", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "wV:p4", rect: { width: 80, height: 70 } }] } } });
      return JSON.stringify({ result: { pane: { pane_id: "wV:p5", workspace_id: "wV" } } });
    });
    expect(splitHerdrPane("/Users/kamil/.local/share/j01n/agents", "https://j01n.me", env, run)).toBe("wV:p5");
    expect(calls[1]).toEqual(["pane", "split", "--current", "--direction", "down", "--cwd", process.cwd(), "--env", "J01N_AGENT_DIR=/Users/kamil/.local/share/j01n/agents", "--env", "BASE_URL=https://j01n.me", "--no-focus"]);
  });

  it("passes only trusted role identity, not room credentials, to a peer pane", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return args[1] === "layout" ? JSON.stringify({ result: { layout: { panes: [{ pane_id: "wV:p4", rect: { width: 100, height: 30 } }] } } })
        : JSON.stringify({ result: { pane: { pane_id: "wV:p5", workspace_id: "wV" } } });
    });
    splitHerdrPane("/private", "https://j01n.me", env, run, "/checkout", { role: "builder", roomId: "room-1", participantId: "ravi" });
    expect(calls[1]).toContain("J01N_PEER_ROLE=builder");
    expect(calls[1]).toContain("J01N_PEER_ROOM_ID=room-1");
    expect(calls[1]).toContain("J01N_PEER_PARTICIPANT_ID=ravi");
    expect(JSON.stringify(calls)).not.toContain("join_secret");
    calls.length = 0;
    splitHerdrPane("/private", "https://j01n.me", env, run, "/checkout", { role: "builder", roomId: "room-1", participantId: "ravi", harness: "claude", inbox: "ravi-inbox", model: "sonnet", provider: "anthropic", skillNames: ["j01n-builder"] });
    expect(calls[1]).toContain("J01N_KEY_DIR=/private/ravi-inbox");
    expect(calls[1]).toContain("J01N_MODEL=sonnet");
    expect(calls[1]).toContain("J01N_PROVIDER=anthropic");
    expect(calls[1]).toContain("J01N_HARNESS=claude");
    expect(calls[1]).toContain("J01N_PEER_SKILLS=j01n-builder");
  });

  it("starts only a named Pi agent and waits for each secret-free prompt", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => { calls.push(args); return "{}"; });
    startHerdrAgent("wV:p5", "reviewer", undefined, run);
    startHerdrAgent("wV:p6", "builder", { model: "anthropic/claude-sonnet-5:high", skills: ["/trusted/builder/SKILL.md"], tools: ["read", "bash", "edit", "write", "j01n"] }, run);
    startHerdrAgent("wV:p7", "planner", { skills: ["/trusted/planner/SKILL.md"], tools: ["read", "bash", "j01n"] }, run);
    promptHerdrAgent("wV:p5", "Register reviewer", run);
    expect(calls[0]).toEqual(["agent", "start", "reviewer", "--kind", "pi", "--pane", "wV:p5"]);
    expect(calls[1]).toEqual(["agent", "start", "builder", "--kind", "pi", "--pane", "wV:p6", "--", "--no-skills", "--no-mcp", "--skill", "/trusted/builder/SKILL.md", "--append-system-prompt", "/trusted/builder/SKILL.md", "--tools", "read,bash,edit,write,j01n", "--model", "anthropic/claude-sonnet-5:high"]);
    expect(calls[2]).toEqual(["agent", "start", "planner", "--kind", "pi", "--pane", "wV:p7", "--", "--no-skills", "--no-mcp", "--skill", "/trusted/planner/SKILL.md", "--append-system-prompt", "/trusted/planner/SKILL.md", "--tools", "read,bash,j01n"]);
    expect(calls[3]).toEqual(["agent", "prompt", "wV:p5", "Register reviewer"]);
    expect(() => startHerdrAgent("wV:p5", "bad name", undefined, run)).toThrow("agent name");
    expect(() => startHerdrAgent("wV:p5", "reviewer", { model: "--no-extensions", skills: ["/trusted/reviewer/SKILL.md"], tools: ["read"] }, run)).toThrow("model");
    expect(() => startHerdrAgent("wV:p5", "reviewer", { model: "bad model", skills: ["/trusted/reviewer/SKILL.md"], tools: ["read"] }, run)).toThrow("model");
    expect(calls).toHaveLength(4);
  });

  it("starts Claude with the role skill as an injected prompt and a restricted built-in tool list", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => { calls.push(args); return "{}"; });
    startHerdrAgent("wV:p5", "reviewer", { harness: "claude", model: "sonnet", skills: ["/trusted/reviewer/SKILL.md"], tools: ["Read", "Bash"] }, run);
    expect(run).toHaveBeenCalledWith("herdr", ["agent", "start", "reviewer", "--kind", "claude", "--pane", "wV:p5", "--", "--restricted", "--strict-mcp-config", "--tools", "Read,Bash", "--append-system-prompt-file", "/trusted/reviewer/SKILL.md", "--model", "sonnet"], expect.anything());
    startHerdrAgent("wV:p6", "builder", { harness: "claude", model: "sonnet", skills: ["/trusted/builder/SKILL.md"], tools: ["Read", "Bash", "Edit", "Write"], helperDir: "/trusted", helperCommand: "node '/trusted/j01n.js'" }, run);
    expect(calls[1]).toEqual(expect.arrayContaining(["--append-system-prompt", expect.stringContaining("node '/trusted/j01n.js'"), "--add-dir", "/trusted"]));
  });

  it("omits a model override when a Claude loadout uses the user's own default", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => { calls.push(args); return "{}"; });
    startHerdrAgent("wV:p6", "builder", { harness: "claude", skills: ["/trusted/builder/SKILL.md"], tools: ["Bash", "Read"] }, run);
    expect(calls[0]).not.toContain("--model");
    expect(calls[0]).toContain("claude");
  });

  it("labels a pane with the friendly name and ignores label failures", () => {
    const run = vi.fn(() => "{}");
    labelHerdrPane("wV:p5", "Maya", run);
    expect(run).toHaveBeenCalledWith("herdr", ["pane", "rename", "wV:p5", "Maya"], expect.anything());
    expect(() => labelHerdrPane("wV:p5", "Maya", vi.fn(() => { throw new Error("no herdr"); }))).not.toThrow();
  });

  it("does not inspect Herdr outside its own managed pane", () => {
    const run = vi.fn();
    expect(() => listHerdrPeers({}, run)).toThrow("inside a Herdr-managed pane");
    expect(run).not.toHaveBeenCalled();
  });
});
