import { execFileSync } from "node:child_process";
import { listTasks } from "./tasks";
import type { RoomClient } from "./room-client";

export interface ConflictPair { branches: [string, string]; files: string[] }
export interface ConflictReport { branches: string[]; comparisons: ConflictPair[]; conflicts: ConflictPair[] }

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Files actually conflicted in merge-tree output, any git version. */
export function conflictedFilesFromOutput(output: string): Set<string> {
  const files = new Set<string>();
  // git>=2.38 --write-tree stdout: conflicted stage entries (stage 1/2/3) and CONFLICT messages.
  for (const match of output.matchAll(/^\d{6} [0-9a-f]+ [123]\t(.+)$/gm)) files.add(match[1]);
  for (const match of output.matchAll(/^CONFLICT .*: Merge conflict in (.+)$/gm)) files.add(match[1]);
  // legacy merge-tree blocks: a "changed in both" (or "simple conflict") section counts as conflicted
  // only when it shows the full "+<<<<<<< .our / +>>>>>>> .their" marker pair, so marker-looking content
  // lines (e.g. detector code) never trigger; cleanly auto-merged files are not listed at all.
  let block: { file?: string; saw_our?: boolean; saw_their?: boolean } | null = null;
  const close = () => { if (block?.saw_our && block.saw_their && block.file) files.add(block.file); block = null; };
  for (const line of output.split("\n")) {
    if (line === "changed in both") { close(); block = {}; continue; }
    if (line === "simple conflict") { close(); block = { saw_our: true, saw_their: true }; continue; }
    if (block && /^(?:merged|added in (?:both|local|remote)|removed in (?:local|remote)|unchanged|missing (?:local|remote))$/.test(line)) { close(); continue; }
    if (!block) continue;
    const header = line.match(/^ {2}(?:base|our|their)\s+\d{6} [0-9a-f]+ (.+)$/);
    if (header && !block.file) block.file = header[1];
    // legacy prints real conflict markers as standalone added lines of the merged hunk
    // ("+<<<<<<< .our" ... "+>>>>>>> .their"). Requiring BOTH anchored lines in one block separates a
    // genuine conflict from file/diff content that merely mentions one marker string (e.g. detector code).
    else if (/^\+?<<<<<<< \.our$/.test(line)) block.saw_our = true;
    else if (/^\+?>>>>>>> \.their$/.test(line)) block.saw_their = true;
  }
  close();
  return files;
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
      try { output = git(root, "merge-tree", "--write-tree", ...pair); }
      catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        if (e.status === 1) output = e.stdout || "";
        else if (e.status === 128 || (e.stderr || "").includes("unknown rev")) {
          // git<2.38: --write-tree is unknown; legacy <base> <b1> <b2> exits 0 even when conflicted.
          const base = git(root, "merge-base", ...pair);
          output = git(root, "merge-tree", base, ...pair);
        }
        else throw new Error(`merge-tree ${pair.join(" vs ")}: ${e.stderr || String(error)}`);
      }
      const files = [...conflictedFilesFromOutput(output)].sort();
      comparisons.push({ branches: pair, files });
    }
  }
  return { branches: existing, comparisons, conflicts: comparisons.filter((pair) => pair.files.length > 0) };
}
