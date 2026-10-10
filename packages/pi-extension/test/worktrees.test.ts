import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPeerWorktree, removeMergedPeerWorktrees } from "../spawn-herdr";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("managed branch worktrees", () => {
  const cwd = process.cwd();
  let repo: string;
  let root: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "j01n-worktree-root-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(repo, "package.json"), '{"name":"test","private":true}');
    writeFileSync(join(repo, ".gitignore"), ".installed\n");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\ntest "$1" = install && test "$2" = --frozen-lockfile && test -f pnpm-workspace.yaml && printf ok > .installed\n', { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    vi.stubEnv("J01N_WORKTREE_ROOT", join(root, "managed"));
    process.chdir(repo);
  });
  afterEach(() => { process.chdir(cwd); vi.unstubAllEnvs(); });

  it("creates the requested branch under the internal managed root, restores workspace yaml and installs frozen", () => {
    const path = createPeerWorktree("feature/peer");
    expect(path).toBe(join(realpathSync(root), "managed", "repo", "feature", "peer"));
    expect(git(path, "branch", "--show-current")).toBe("feature/peer");
    expect(readFileSync(join(path, "pnpm-workspace.yaml"), "utf8")).toBe(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"));
    expect(existsSync(join(path, ".installed"))).toBe(true);
  });

  it("restores the source workspace yaml after pnpm rewrites it, without leaving a dirty checkout", () => {
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\ntest "$1" = install && test "$2" = --frozen-lockfile && cp pnpm-workspace.yaml .installed && printf "packages: []\\n" > pnpm-workspace.yaml\n', { mode: 0o755 });
    const path = createPeerWorktree("rewritten");
    const original = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
    expect(readFileSync(join(path, ".installed"), "utf8")).toBe(original);
    expect(readFileSync(join(path, "pnpm-workspace.yaml"), "utf8")).toBe(original);
    expect(git(path, "status", "--porcelain")).toBe("");
  });

  it("also restores the workspace yaml after a failed frozen install", () => {
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf "packages: []\\n" > pnpm-workspace.yaml\nexit 1\n', { mode: 0o755 });
    const path = join(realpathSync(root), "managed", "repo", "failed");
    expect(() => createPeerWorktree("failed")).toThrow("frozen install failed");
    expect(readFileSync(join(path, "pnpm-workspace.yaml"), "utf8")).toBe(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"));
  });

  it("exposes cleanup as /j01n worktrees --remove-merged (no room required)", async () => {
    const { runj01n } = await import("../commands");
    expect(JSON.parse(await runj01n(["worktrees", "--remove-merged"]))).toEqual({ removed: [], skipped: [] });
    await expect(runj01n(["worktrees"])).rejects.toThrow("--remove-merged");
  });

  it("rejects external storage, symlink escape, branch traversal and existing checkout before creating a worktree", () => {
    vi.stubEnv("J01N_WORKTREE_ROOT", "/Volumes/T5 EVO/worktrees");
    expect(() => createPeerWorktree("feature")).toThrow("/Volumes");
    vi.stubEnv("J01N_WORKTREE_ROOT", join(root, "link"));
    symlinkSync("/Volumes", join(root, "link"));
    expect(() => createPeerWorktree("feature")).toThrow("/Volumes");
    vi.stubEnv("J01N_WORKTREE_ROOT", join(root, "managed"));
    expect(() => createPeerWorktree("../escape")).toThrow("invalid worktree branch");
    createPeerWorktree("safe");
    expect(() => createPeerWorktree("safe")).toThrow("already exists");
  });

  it("removes an unpublished feature branch after its commit is published through main", () => {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    git(repo, "remote", "add", "origin", origin);
    const path = createPeerWorktree("feature");
    writeFileSync(join(path, "package.json"), '{"name":"merged"}');
    git(path, "add", ".");
    git(path, "commit", "-m", "feature");
    git(repo, "merge", "--ff-only", "feature");
    git(repo, "push", "-u", "origin", "main");
    expect(removeMergedPeerWorktrees()).toEqual({ removed: [path], skipped: [] });
  });

  it("only removes clean merged managed checkouts with upstream and reachable origin; leaves dirty or unpushed ones", () => {
    const origin = join(root, "origin.git");
    execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    const clean = createPeerWorktree("clean");
    const dirty = createPeerWorktree("dirty");
    const unpushed = createPeerWorktree("unpushed");
    git(repo, "push", "-u", "origin", "clean", "dirty", "unpushed");
    writeFileSync(join(dirty, "package.json"), '{"name":"dirty"}');
    writeFileSync(join(unpushed, "package.json"), '{"name":"unpushed"}');
    git(unpushed, "add", ".");
    git(unpushed, "commit", "-m", "local work");
    git(repo, "merge", "--ff-only", "unpushed");
    expect(removeMergedPeerWorktrees()).toEqual({ removed: [clean], skipped: [dirty, unpushed] });
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(unpushed)).toBe(true);
  });
});
