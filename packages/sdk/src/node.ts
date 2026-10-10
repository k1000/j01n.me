import { execFileSync } from "node:child_process";
import { createHmac, hkdfSync } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Workspace } from "./crypto";

function git(cwd: string, ...args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; }
  catch { return undefined; }
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
