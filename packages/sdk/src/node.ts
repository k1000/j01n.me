import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workspace } from "./crypto";

function git(cwd: string, ...args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
}

/**
 * Where room key files and agent identities are saved: J01N_KEY_DIR when set, else the current directory ("."),
 * except on external volumes (/Volumes, e.g. exFAT without permissions): a private per-directory internal folder.
 */
export function localStateDir(cwd = process.cwd()): string {
  if (process.env.J01N_KEY_DIR) {
    mkdirSync(process.env.J01N_KEY_DIR, { recursive: true, mode: 0o700 });
    return process.env.J01N_KEY_DIR;
  }
  const path = realpathSync(cwd);
  if (path !== "/Volumes" && !path.startsWith("/Volumes/")) return ".";
  const dir = join(homedir(), ".config", "j01n", "rooms", createHash("sha256").update(path).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Node-only workspace discovery; the location URL never leaves this process. */
export function detectWorkspace(joinSecret: string, roomId: string, cwd = process.cwd(), host = hostname()): { workspace: Workspace; checkout: string } {
  const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel") || resolve(cwd));
  const url = pathToFileURL(root);
  url.hostname = host;
  const key = hkdfSync("sha256", joinSecret, roomId, "j01n.me checkout v1", 32);
  const checkout = createHmac("sha256", Buffer.from(key)).update(url.href).digest("base64url");
  const repo = git(cwd, "remote", "get-url", "origin")?.replace(/\/\/[^@/]+@/, "//");
  const branch = git(cwd, "branch", "--show-current");
  return { workspace: { path: root, host, ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) }, checkout };
}
