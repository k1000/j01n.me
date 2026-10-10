import { describe, expect, it, vi } from "vitest";
import { listHerdrPeers } from "../herdr";

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

  it("does not inspect Herdr outside its own managed pane", () => {
    const run = vi.fn();
    expect(() => listHerdrPeers({}, run)).toThrow("inside a Herdr-managed pane");
    expect(run).not.toHaveBeenCalled();
  });
});
