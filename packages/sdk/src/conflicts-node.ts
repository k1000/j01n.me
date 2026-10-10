import { execFileSync } from "node:child_process";
import { listTasks } from "./tasks";
import type { RoomClient } from "./room-client";

export interface ConflictPair { branches: [string, string]; files: string[] }
export interface ConflictReport { branches: string[]; comparisons: ConflictPair[]; conflicts: ConflictPair[] }

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Inspect local task branches without changing the index or any worktree. */
export async function checkConflicts(client: RoomClient, root: string, finishedBranch?: string): Promise<ConflictReport> {
  const repo = (() => { try { return git(root, "remote", "get-url", "origin").replace(/\/\/[^@/]+@/, "//"); } catch { return git(root, "rev-parse", "--show-toplevel"); } })();
  const team = await client.team();
  const branches = new Set<string>();
  for (const task of await listTasks(client)) {
    const participant = team.find((p) => p.id === task.owner);
    if (participant?.workspace?.repo === repo && participant.workspace.branch) branches.add(participant.workspace.branch);
    else if (task.worktree) {
      try {
        if (git(task.worktree, "remote", "get-url", "origin").replace(/\/\/[^@/]+@/, "//") === repo) branches.add(git(task.worktree, "branch", "--show-current"));
      } catch { /* a task's worktree might not exist on this machine */ }
    }
  }
  if (finishedBranch) branches.add(finishedBranch);
  const existing = [...branches].filter((branch) => {
    try { git(root, "rev-parse", "--verify", `refs/heads/${branch}`); return true; } catch { return false; }
  }).sort();
  const main = ["main", "origin/main"].find((branch) => {
    try { git(root, "rev-parse", "--verify", branch === "main" ? "refs/heads/main" : "refs/remotes/origin/main"); return true; } catch { return false; }
  });
  if (!main) throw new Error("conflicts needs a local main or origin/main ref");
  const comparisons: ConflictPair[] = [];
  for (let i = 0; i < existing.length; i++) {
    for (const other of [main, ...existing.slice(i + 1)]) {
      if (other === existing[i] || (finishedBranch && existing[i] !== finishedBranch && other !== finishedBranch)) continue;
      const pair: [string, string] = [existing[i], other];
      let output: string;
      let conflicted = false;
      try { output = git(root, "merge-tree", "--write-tree", ...pair); }
      catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        if (e.status !== 1) throw new Error(`merge-tree ${pair.join(" vs ")}: ${e.stderr || String(error)}`);
        conflicted = true;
        output = e.stdout || "";
      }
      const files = conflicted ? [...new Set([
        ...[...output.matchAll(/^\d{6} [0-9a-f]+ [123]\t(.+)$/gm)].map((match) => match[1]),
        ...[...output.matchAll(/^CONFLICT .*? in (.+)$/gm)].map((match) => match[1]),
      ])].sort() : [];
      comparisons.push({ branches: pair, files });
    }
  }
  return { branches: existing, comparisons, conflicts: comparisons.filter((pair) => pair.files.length > 0) };
}
