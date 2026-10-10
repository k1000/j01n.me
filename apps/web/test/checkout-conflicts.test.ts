import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWorkspace } from "@j01n/sdk/node";
import { checkConflicts } from "@j01n/sdk/conflicts-node";
import type { RoomClient } from "@j01n/sdk";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function twoWorktrees() {
  const root = mkdtempSync(join(tmpdir(), "j01n-checkouts-")); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "test@example.invalid"); git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
  writeFileSync(join(repo, "shared.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const a = join(root, "a"), b = join(root, "b");
  git(repo, "worktree", "add", "-b", "feature/a", a); git(repo, "worktree", "add", "-b", "feature/b", b);
  return { repo, a, b };
}

describe("checkout identity and real merge conflicts", () => {
  it("HMAC is stable per machine/worktree/room but never exposes the location URL", () => {
    const { repo, a, b } = twoWorktrees();
    const id = (cwd: string, room = "room-1", host = "machine-a") => detectWorkspace("join-secret", room, cwd, host);
    expect(id(a).checkout).toBe(id(a).checkout);
    expect(id(a).checkout).not.toBe(id(b).checkout);
    expect(id(a).checkout).not.toBe(id(a, "room-2").checkout);
    expect(id(a).checkout).not.toBe(id(a, "room-1", "machine-b").checkout);
    expect(id(a).workspace).toMatchObject({ path: realpathSync(a), branch: "feature/a", host: "machine-a" });
    expect(id(a).checkout).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id(a).checkout).not.toContain(repo);
  });

  it("two worktrees may edit independently but merge-tree reports their conflicting file and main comparison", async () => {
    const { repo, a, b } = twoWorktrees();
    for (const [cwd, value] of [[a, "alpha\n"], [b, "beta\n"]]) {
      writeFileSync(join(cwd, "shared.txt"), value);
      git(cwd, "add", "."); git(cwd, "commit", "-m", "change");
    }
    const board = {
      "task.T1": { value: { title: "A", files: ["shared.txt"], depends_on: [], status: "claimed", owner: "a" } },
      "task.T2": { value: { title: "B", files: ["shared.txt"], depends_on: [], status: "claimed", owner: "b" } },
    };
    const client = {
      async board() { return { board }; },
      async team() { return [
        { id: "a", workspace: detectWorkspace("secret", "room", a).workspace },
        { id: "b", workspace: detectWorkspace("secret", "room", b).workspace },
      ]; },
    } as unknown as RoomClient;
    const report = await checkConflicts(client, repo);
    expect(report.conflicts).toEqual([{ branches: ["feature/a", "feature/b"], files: ["shared.txt"] }]);
    expect(report.comparisons).toHaveLength(3);
    expect((await checkConflicts(client, repo, "feature/a")).conflicts).toEqual(report.conflicts);
  });
});
