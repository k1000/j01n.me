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

/** Split only the calling pane; leave user focus in place and private identity files off shared/exFAT workspaces. */
/** Split the calling pane; the new pane starts in `cwd` (default: this directory, e.g. a separate worktree for a peer). */
export function splitHerdrPane(identityDir: string, baseUrl: string, env: Record<string, string | undefined> = process.env, run: RunHerdr = execFileSync, cwd = process.cwd()): string {
  if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) throw new Error("spawn_room_peer requires a Herdr-managed pane");
  const layout = JSON.parse(run("herdr", ["pane", "layout", "--pane", env.HERDR_PANE_ID], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] })) as {
    result?: { layout?: { panes?: Array<{ pane_id: string; rect: { width: number; height: number } }> } };
  };
  const rect = layout.result?.layout?.panes?.find((pane) => pane.pane_id === env.HERDR_PANE_ID)?.rect;
  if (!rect) throw new Error("cannot locate the calling Herdr pane");
  const direction = rect.width >= rect.height * 1.8 ? "right" : "down";
  const output = JSON.parse(run("herdr", ["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--env", `J01N_AGENT_DIR=${identityDir}`, "--env", `BASE_URL=${baseUrl}`, "--no-focus"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] })) as {
    result?: { pane?: { pane_id: string; workspace_id: string } };
  };
  if (!output.result?.pane?.pane_id || output.result.pane.workspace_id !== env.HERDR_WORKSPACE_ID) throw new Error("Herdr did not return a pane in the current workspace");
  return output.result.pane.pane_id;
}

export function startHerdrAgent(paneId: string, name: string, run: RunHerdr = execFileSync): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error("agent name must be a unique Herdr name ([a-z][a-z0-9_-]{0,31})");
  run("herdr", ["agent", "start", name, "--kind", "pi", "--pane", paneId], { encoding: "utf8", timeout: 40000, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Submit a prompt without `--wait`: Herdr's wait fails with agent_prompt_stalled unless the agent starts working within
 * 5 s, and a freshly started Pi takes longer. Callers wait for the outcome they need (a file, a room join) instead.
 */
export function promptHerdrAgent(paneId: string, message: string, run: RunHerdr = execFileSync): void {
  run("herdr", ["agent", "prompt", paneId, message], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}
