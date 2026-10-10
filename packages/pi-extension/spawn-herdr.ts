import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { exportPublicKey } from "@j01n/sdk/crypto";
import { inviteAgent, parseInviteLink } from "@j01n/sdk";
import type { AgentIdentity, RoomClient } from "@j01n/sdk";
import { listHerdrPeers, promptHerdrAgent, splitHerdrPane, startHerdrAgent } from "./herdr";

export function requirePrivateIdentityDir(identityDir: string): void {
  if (!isAbsolute(identityDir) || !existsSync(identityDir) || statSync(identityDir).mode & 0o077 || (process.platform === "darwin" && realpathSync(identityDir).startsWith("/Volumes/"))) {
    throw new Error("J01N_AGENT_DIR must be an existing private absolute directory on internal storage (mode 0700)");
  }
}

/** Spawn a local Pi peer only for an authenticated host; never hand the room link to Herdr. */
export async function spawnAndInviteHerdr(
  client: Pick<RoomClient, "invite" | "participantId" | "status">,
  sender: AgentIdentity,
  link: string,
  agentName: string,
  role: string,
  identityDir: string,
  directory?: string,
) {
  const parsed = parseInviteLink(link);
  if (!parsed || parsed.access !== client.invite.room_url || !/^https:\/\//.test(parsed.access)) throw new Error("provide the current room's HTTPS invitation link");
  if (new URL(sender.base).origin !== new URL(parsed.access).origin) throw new Error("sender identity belongs to a different service");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName) || agentName === sender.name || !role.trim()) throw new Error("provide a new Herdr agent name and role");
  requirePrivateIdentityDir(identityDir);
  if (directory !== undefined && (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory())) throw new Error("directory must be an existing absolute directory (e.g. the peer's own git worktree)");
  const status = await client.status();
  if (status.room.host_id !== client.participantId) throw new Error("only the joined room host can spawn an agent");
  if (status.closed || ("phase" in status && status.phase === "closed") || new Date(status.expires_at).getTime() <= Date.now()) throw new Error("room is closed or expired");
  if (status.participants.some((p) => p.id === agentName)) throw new Error("agent is already in the room");
  if (status.participants.length >= status.room.max_participants) throw new Error("room is at capacity");
  if (listHerdrPeers().some((peer) => peer.agent === agentName)) throw new Error("agent name is already in the Herdr workspace");

  const targetFile = join(identityDir, `.j01n-agent-${agentName}.json`);
  if (existsSync(targetFile)) throw new Error("target agent identity already exists; choose a fresh name");
  const addressUrl = `${sender.base}/a/${encodeURIComponent(agentName)}`;
  const address = await fetch(addressUrl);
  if (address.status !== 404) throw new Error(address.ok ? "target address is already registered" : `agent address lookup failed (${address.status})`);

  let paneId: string | undefined;
  let step = "spawn";
  let invited = false;
  try {
    paneId = directory ? splitHerdrPane(identityDir, sender.base, undefined, undefined, directory) : splitHerdrPane(identityDir, sender.base);
    startHerdrAgent(paneId, agentName);
    step = "registration";
    promptHerdrAgent(paneId, `Register yourself with j01n.me as ${agentName}, accepting invitations only from ${sender.name}. Use /j01n register ${agentName} ${sender.name}. Do not share your key or token. Reply when registered.`);
    if (!existsSync(targetFile)) throw new Error("new agent did not register its identity");
    const local = JSON.parse(readFileSync(targetFile, "utf8")) as AgentIdentity;
    if (local.name !== agentName || local.base !== sender.base || !local.publicJwk) throw new Error("new agent identity does not match the requested address");
    const remote = await fetch(addressUrl);
    if (!remote.ok) throw new Error("registered address cannot be verified");
    const { public_key } = await remote.json() as { public_key?: string };
    const publicKey = await crypto.subtle.importKey("jwk", local.publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
    if (public_key !== await exportPublicKey(publicKey)) throw new Error("registered address key does not match the spawned agent");

    step = "invitation";
    await inviteAgent(sender, agentName, link);
    invited = true;
    step = "join";
    promptHerdrAgent(paneId, `A sealed invitation from ${sender.name} is waiting for ${agentName}. Run /j01n listen ${agentName} to join. Your role: ${role}. Do not paste room credentials into Herdr.`);
    for (let attempt = 0; attempt < 15; attempt++) {
      if ((await client.status()).participants.some((p) => p.id === agentName)) return { ok: true, pane_id: paneId, invited, joined: true };
      if (attempt < 14) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("join not confirmed; check the spawned agent's pane and room status");
  } catch (error) {
    if (!paneId) throw error;
    return { ok: false, pane_id: paneId, step, invited, joined: false, may_be_running: true, error: error instanceof Error ? error.message.replaceAll(link, "[room link]") : "workflow failed" };
  }
}
