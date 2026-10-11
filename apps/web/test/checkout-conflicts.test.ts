import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWorkspace, localStateDir } from "@j01n/sdk/node";
import { checkConflicts } from "@j01n/sdk/conflicts-node";
import type { RoomClient } from "@j01n/sdk";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function twoWorktrees() {
  const root = mkdtempSync(join(tmpdir(), "j01n-checkouts-")); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, "init"); git(repo, "symbolic-ref", "HEAD", "refs/heads/main"); // init -b needs git>=2.28
  git(repo, "config", "user.email", "test@example.invalid"); git(repo, "config", "user.name", "Test");
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

  it("legacy fallback: marker-looking file content is not a conflict; real overlap still is", async () => {
    const { repo, a, b } = twoWorktrees();
    // seed a 20-line file; both edit DISTINCT far-apart lines -> clean auto-merge, no markers
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    writeFileSync(join(repo, "clean.txt"), lines.join("\n") + "\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "seed");
    git(a, "pull", "--rebase", "--quiet", repo, "main"); git(b, "pull", "--rebase", "--quiet", repo, "main");
    writeFileSync(join(a, "clean.txt"), ["line0a", ...lines.slice(1)].join("\n") + "\n");
    // a also adds code containing literal marker strings — the old substring detector matched these in diffs
    writeFileSync(join(a, "detector.ts"), "const m = /^<<<<<<< \\.our$/m.test(s) && /^>>>>>>> \\.their$/m.test(s);\n");
    git(a, "add", "."); git(a, "commit", "-qm", "a");
    writeFileSync(join(b, "clean.txt"), [...lines.slice(0, 19), "line19b"].join("\n") + "\n");
    git(b, "add", "."); git(b, "commit", "-qm", "b");
    const board = {
      "task.T1": { value: { title: "A", files: ["clean.txt"], depends_on: [], status: "claimed", owner: "a" } },
      "task.T2": { value: { title: "B", files: ["clean.txt"], depends_on: [], status: "claimed", owner: "b" } },
    };
    const client = { async board() { return { board }; }, team: async () => [
      { id: "a", workspace: detectWorkspace("secret", "room", a).workspace },
      { id: "b", workspace: detectWorkspace("secret", "room", b).workspace },
    ] } as unknown as RoomClient;
    expect((await checkConflicts(client, repo)).conflicts).toEqual([]);
    // sanity: a REAL same-line overlap is reported by whichever merge-tree mode this git has
    writeFileSync(join(b, "clean.txt"), ["line0a2", ...lines.slice(1), "line19b"].join("\n") + "\n");
    git(b, "commit", "-qam", "overlap");
    expect((await checkConflicts(client, repo)).conflicts).toEqual([{ branches: ["feature/a", "feature/b"], files: ["clean.txt"] }]);
  });

  it("keeps key files in the directory, except on /Volumes where a private internal folder is used", () => {
    const dir = mkdtempSync(join(tmpdir(), "j01n-state-")); dirs.push(dir);
    expect(localStateDir(dir)).toBe(".");
    process.env.J01N_KEY_DIR = join(dir, "keys");
    try { expect(localStateDir("/")).toBe(join(dir, "keys")); expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700); }
    finally { delete process.env.J01N_KEY_DIR; }
    if (!existsSync("/Volumes")) return;
    const home = mkdtempSync(join(tmpdir(), "j01n-home-")); dirs.push(home);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const state = localStateDir("/Volumes");
      expect(state.startsWith(join(home, ".config", "j01n", "rooms") + "/")).toBe(true);
      expect(statSync(state).mode & 0o777).toBe(0o700);
      expect(localStateDir("/Volumes")).toBe(state);
    } finally { process.env.HOME = previous; }
  });
});
