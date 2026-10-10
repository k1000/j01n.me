import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const loadedCommit = gitCommit();
const source = repoRoot.includes(`${sep}git${sep}gitlab.com${sep}k1000${sep}j01n.me`) ? "gitlab"
  : repoRoot.includes(`${sep}git${sep}github.com${sep}k1000${sep}j01n.me`) ? "github" : "local";

type Source = "gitlab" | "github" | "local";

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function configuredPackages(): string[] {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8")) as { packages?: Array<string | { source?: string }> };
    return (settings.packages ?? []).map((entry) => typeof entry === "string" ? entry : entry.source ?? "");
  } catch {
    return [];
  }
}

export function assessInstallation(loadedSource: Source, loaded: string | null, installed: string | null, configured: string[]) {
  const hosts = configured.map((entry) => /^(?:https?:\/\/|git:)(github|gitlab)\.com\/k1000\/j01n\.me(?:\.git)?(?:@[^/]+)?\/?$/.exec(entry)?.[1]);
  const duplicate = hosts.includes("github") && hosts.includes("gitlab");
  const reload = loaded !== null && installed !== null && loaded !== installed;
  const warnings: string[] = [];
  if (duplicate) warnings.push("Both GitHub and GitLab j01n packages are configured; run pi remove https://github.com/k1000/j01n.me, then /reload.");
  else if (loadedSource === "github") warnings.push("The GitHub j01n package is loaded; run pi install https://gitlab.com/k1000/j01n.me, remove the GitHub package, then /reload.");
  if (reload) warnings.push("The installed j01n checkout changed since this Pi session loaded it; run /reload or restart Pi.");
  return { source: loadedSource, loaded_commit: loaded, installed_commit: installed,
    reload_required: reload, duplicate_install: duplicate, warnings };
}

export function getExtensionDiagnostics() {
  return assessInstallation(source, loadedCommit, gitCommit(), configuredPackages());
}
