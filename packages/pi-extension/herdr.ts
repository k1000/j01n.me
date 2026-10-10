import { execFileSync } from "node:child_process";

type RunHerdr = (command: string, args: string[], options: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "pipe"] }) => string;

export interface HerdrPeer {
  pane_id: string;
  agent: string;
  agent_status: string;
}

/** Only the caller's workspace is in scope; pane IDs disambiguate repeated agent labels. */
export function listHerdrPeers(env: Record<string, string | undefined> = process.env, run: RunHerdr = execFileSync): HerdrPeer[] {
  if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) {
    throw new Error("herdr_agents and invite_herdr require running inside a Herdr-managed pane");
  }
  const output = JSON.parse(run("herdr", ["agent", "list"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })) as {
    result?: { agents?: Array<HerdrPeer & { workspace_id: string }> };
  };
  if (!Array.isArray(output.result?.agents)) throw new Error("Herdr did not return an agent list");
  return output.result.agents
    .filter((peer) => peer.workspace_id === env.HERDR_WORKSPACE_ID && peer.pane_id !== env.HERDR_PANE_ID && typeof peer.pane_id === "string" && typeof peer.agent === "string")
    .map(({ pane_id, agent, agent_status }) => ({ pane_id, agent, agent_status }));
}

/** This prompt never contains the room link or join secret; the inbox carries the sealed invite. */
export function notifyHerdrPeer(paneId: string, message: string): void {
  execFileSync("herdr", ["agent", "prompt", paneId, message], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}
