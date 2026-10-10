import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { exportPublicKey } from "@j01n/sdk/crypto";
import { inviteAgent, parseInviteLink } from "@j01n/sdk";
import type { AgentIdentity, RoomClient } from "@j01n/sdk";
import { listHerdrPeers, promptHerdrAgent, splitHerdrPane, startHerdrAgent } from "./herdr";

const OUTCOME_TIMEOUT_MS = 180_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function internalRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("J01N_WORKTREE_ROOT must be an absolute path on internal storage");
  const path = resolve(root);
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = resolve(realpathSync(ancestor), relative(ancestor, path));
  if ([path, physical].some((item) => item === "/Volumes" || item.startsWith("/Volumes/"))) throw new Error("worktrees on /Volumes (exFAT/external storage) are not allowed");
  return physical;
}

function worktreeRoot(): string {
  return internalRoot(process.env.J01N_WORKTREE_ROOT || join(homedir(), "Development", "_worktrees"));
}

/** A new branch receives its own checkout; no user files are moved or overwritten. */
export function createPeerWorktree(branch: string, source = process.cwd()): string {
  if (!branch || branch.split("/").some((part) => part === "." || part === ".." || !part) || branch.startsWith("-")) throw new Error("invalid worktree branch");
  const repo = git(source, "rev-parse", "--show-toplevel");
  git(repo, "check-ref-format", "--branch", branch);
  const target = join(worktreeRoot(), basename(repo), branch);
  if (existsSync(target)) throw new Error(`worktree path already exists: ${target}`);
  const workspaceFile = join(repo, "pnpm-workspace.yaml");
  const workspaceContents = existsSync(workspaceFile) ? readFileSync(workspaceFile) : undefined;
  const targetWorkspaceFile = join(target, "pnpm-workspace.yaml");
  mkdirSync(dirname(target), { recursive: true });
  if (!realpathSync(dirname(target)).startsWith(worktreeRoot() + "/")) throw new Error("worktree path escapes internal storage");
  git(repo, "worktree", "add", "-b", branch, target, "HEAD");
  if (workspaceContents && !existsSync(targetWorkspaceFile)) copyFileSync(workspaceFile, targetWorkspaceFile);
  try {
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: target, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`worktree ${target} was created but frozen install failed; inspect it before retrying`, { cause: error });
  } finally {
    // Only a checkout created above is eligible; restore the pre-install snapshot if pnpm rewrote it.
    if (workspaceContents && (!existsSync(targetWorkspaceFile) || !readFileSync(targetWorkspaceFile).equals(workspaceContents))) {
      writeFileSync(targetWorkspaceFile, workspaceContents);
    }
  }
  return target;
}

/** Only remove clean, tracked managed worktrees whose commits are in main and upstream. Never prune a unique branch. */
export function removeMergedPeerWorktrees(source = process.cwd()): { removed: string[]; skipped: string[] } {
  const repo = git(source, "rev-parse", "--show-toplevel");
  const managed = join(worktreeRoot(), basename(repo));
  let main: string;
  try { main = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); }
  catch { main = "main"; }
  const entries = git(repo, "worktree", "list", "--porcelain").split(/\n\n+/);
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const path = entry.match(/^worktree (.+)$/m)?.[1];
    const branch = entry.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!path || !branch || !resolve(path).startsWith(managed + "/")) continue;
    try {
      if (path === repo || !existsSync(path) || realpathSync(path) !== resolve(path) || git(path, "status", "--porcelain") || git(repo, "merge-base", "--is-ancestor", branch, main)) {
        skipped.push(path);
        continue;
      }
      // A published main or branch proves no work in this clean, merged checkout is unique.
      // Still inspect upstream divergence (when configured) before removing any checkout.
      try { git(repo, "log", "--format=%H", `${branch}@{u}..${branch}`); } catch { /* A branch can be merged and published without its own upstream. */ }
      const remoteHeads = git(repo, "ls-remote", "--heads", "origin").split("\n");
      const branchCommit = git(repo, "rev-parse", branch);
      const mainCommit = git(repo, "rev-parse", main);
      if (!remoteHeads.some((line) => line === `${branchCommit}\trefs/heads/${branch}` || line === `${mainCommit}\trefs/heads/main`)) throw new Error("branch is not confirmed on origin");
      git(repo, "worktree", "remove", path);
      removed.push(path);
    } catch {
      skipped.push(path);
    }
  }
  return { removed, skipped };
}

/** Poll until `check` holds (true) or the timeout passes (false). */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = OUTCOME_TIMEOUT_MS): Promise<boolean> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 1000))) {
    if (await check()) return true;
  }
  return check();
}

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
  branch?: string,
  displayName?: string,
  task?: string,
) {
  const parsed = parseInviteLink(link);
  if (!parsed || parsed.access !== client.invite.room_url || !/^https:\/\//.test(parsed.access)) throw new Error("provide the current room's HTTPS invitation link");
  if (new URL(sender.base).origin !== new URL(parsed.access).origin) throw new Error("sender identity belongs to a different service");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName) || agentName === sender.name || !role.trim()) throw new Error("provide a new Herdr agent name and role");
  requirePrivateIdentityDir(identityDir);
  if (branch && directory) throw new Error("choose branch or directory, not both");
  if (directory !== undefined && (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory())) throw new Error("directory must be an existing absolute directory (e.g. the peer's own git worktree)");
  const status = await client.status();
  if (status.room.host_id !== client.participantId) throw new Error("only the joined room host can spawn an agent");
  if (status.closed || ("phase" in status && status.phase === "closed") || new Date(status.expires_at).getTime() <= Date.now()) throw new Error("room is closed or expired");
  if (status.participants.some((p) => p.id === agentName || (displayName && p.id.toLowerCase() === displayName.toLowerCase()))) throw new Error("agent or friendly name is already in the room");
  if (status.participants.length >= status.room.max_participants) throw new Error("room is at capacity");
  if (listHerdrPeers().some((peer) => peer.agent === agentName)) throw new Error("agent name is already in the Herdr workspace");

  const targetFile = join(identityDir, `.j01n-agent-${agentName}.json`);
  if (existsSync(targetFile)) throw new Error("target agent identity already exists; choose a fresh name");
  const addressUrl = `${sender.base}/a/${encodeURIComponent(agentName)}`;
  const address = await fetch(addressUrl);
  if (address.status !== 404) throw new Error(address.ok ? "target address is already registered" : `agent address lookup failed (${address.status})`);

  const peerDirectory = branch ? createPeerWorktree(branch) : directory;
  let paneId: string | undefined;
  let step = "spawn";
  let invited = false;
  try {
    paneId = peerDirectory ? splitHerdrPane(identityDir, sender.base, undefined, undefined, peerDirectory) : splitHerdrPane(identityDir, sender.base);
    startHerdrAgent(paneId, agentName);
    step = "registration";
    promptHerdrAgent(paneId, `Register yourself with j01n.me as ${agentName}, accepting invitations only from ${sender.name}. Use /j01n register ${agentName} ${sender.name}. Do not share your key or token. Reply when registered.`);
    if (!await waitFor(() => existsSync(targetFile))) throw new Error("new agent did not register its identity");
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
    // Let the registration turn finish first, so the join prompt is not typed into a working agent.
    await waitFor(() => listHerdrPeers().find((peer) => peer.pane_id === paneId)?.agent_status !== "working", 60_000);
    const profileFlags = displayName ? ` --as ${displayName.toLowerCase()} --display-name ${displayName} --role ${JSON.stringify(role)}` : "";
    promptHerdrAgent(paneId, `A sealed invitation from ${sender.name} is waiting for ${agentName}. Run /j01n listen ${agentName} --capabilities code,shell,files${profileFlags} to join. Your role: ${role}.${task ? ` Task: ${task}.` : ""} Do not paste room credentials into Herdr.`);
    const participantId = displayName?.toLowerCase() || agentName;
    if (await waitFor(async () => (await client.status()).participants.some((p) => p.id === participantId))) return { ok: true, pane_id: paneId, invited, joined: true, ...(peerDirectory ? { directory: peerDirectory } : {}) };
    throw new Error("join not confirmed; check the spawned agent's pane and room status");
  } catch (error) {
    if (!paneId) throw error;
    return { ok: false, pane_id: paneId, step, invited, joined: false, may_be_running: true, error: error instanceof Error ? error.message.replaceAll(link, "[room link]") : "workflow failed" };
  }
}
