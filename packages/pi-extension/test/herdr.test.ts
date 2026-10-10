import { describe, expect, it, vi } from "vitest";
import { listHerdrPeers, splitHerdrPane, startHerdrAgent, promptHerdrAgent } from "../herdr";

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

  it("starts only a named Pi agent and waits for each secret-free prompt", () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => { calls.push(args); return "{}"; });
    startHerdrAgent("wV:p5", "reviewer", run);
    promptHerdrAgent("wV:p5", "Register reviewer", run);
    expect(calls[0]).toEqual(["agent", "start", "reviewer", "--kind", "pi", "--pane", "wV:p5"]);
    expect(calls[1]).toEqual(["agent", "prompt", "wV:p5", "Register reviewer", "--wait", "--timeout", "120000"]);
    expect(() => startHerdrAgent("wV:p5", "bad name", run)).toThrow("agent name");
  });

  it("does not inspect Herdr outside its own managed pane", () => {
    const run = vi.fn();
    expect(() => listHerdrPeers({}, run)).toThrow("inside a Herdr-managed pane");
    expect(run).not.toHaveBeenCalled();
  });
});
