import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePiModel, type PeerStartup } from "./herdr";

type Harness = "pi" | "claude";
const EXAMPLE = fileURLToPath(new URL("./peer-spawn.example.json", import.meta.url));
const slug = /^[a-z][a-z0-9_-]{0,31}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} setting: ${key}`);
}

export function peerConfigPath(env: Record<string, string | undefined> = process.env): string {
  const path = env.J01N_PEER_CONFIG ?? join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "j01n", "peer-spawn.json");
  if (!isAbsolute(path)) throw new Error("J01N_PEER_CONFIG / XDG_CONFIG_HOME must resolve to an absolute path");
  return path;
}

function skillPath(value: string, configPath: string): string {
  const builtin = /^builtin:([a-z][a-z0-9_-]{0,31})$/.exec(value);
  const path = builtin ? fileURLToPath(new URL(`./skills/${builtin[1]}/SKILL.md`, import.meta.url))
    : value.startsWith("~/") ? join(homedir(), value.slice(2))
      : resolve(dirname(configPath), value);
  try {
    const actual = realpathSync(path);
    if (statSync(actual).isFile()) return actual;
  } catch { /* missing or inaccessible */ }
  throw new Error(`peer skill is unavailable: ${value} (configured in ${configPath})`);
}

function loadout(value: unknown, configPath: string, label: string, harness: Harness): PeerStartup {
  const entry = object(value, label);
  keys(entry, ["model", "provider", "skills", "tools"], label);
  if (entry.model !== undefined && typeof entry.model !== "string") throw new Error(`${label}.model must be a string`);
  validatePiModel(entry.model);
  if (entry.provider !== undefined && (typeof entry.provider !== "string" || !/^[a-z][a-z0-9_-]*$/.test(entry.provider))) throw new Error(`${label}.provider must be a lowercase provider name`);
  if (!Array.isArray(entry.skills) || !entry.skills.length || !entry.skills.every((v) => typeof v === "string" && v.length)) throw new Error(`${label}.skills must list one or more skill paths`);
  if (!Array.isArray(entry.tools) || !entry.tools.length || !entry.tools.every((v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(v))) throw new Error(`${label}.tools must list safe tool names`);
  if (!entry.tools.includes(harness === "pi" ? "j01n" : "Bash")) throw new Error(`${label}.tools must include ${harness === "pi" ? "j01n" : "Bash"} for room registration and join`);
  const skills = entry.skills.map((value: string) => skillPath(value, configPath));
  const skillNames = skills.map((path) => {
    const contents = readFileSync(path, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
    const name = frontmatter?.[1].match(/^name:\s*["']?([a-z][a-z0-9_-]*)["']?\s*$/m)?.[1];
    if (!name) throw new Error(`peer skill lacks a valid frontmatter name: ${path}`);
    return name;
  });
  if (new Set(skillNames).size !== skillNames.length) throw new Error(`${label}.skills contains duplicate skill names`);
  return { harness, model: entry.model, provider: entry.provider, skills, skillNames, tools: entry.tools };
}

export function resolvePeerSelection(role?: string, harness?: Harness, env: Record<string, string | undefined> = process.env): { role: string; harness: Harness; startup: PeerStartup; configPath: string } {
  const configPath = peerConfigPath(env);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`peer spawn config missing: ${configPath}; copy ${EXAMPLE} there and edit it`);
    throw new Error(`invalid peer spawn JSON: ${configPath}`);
  }
  const config = object(raw, "peer spawn config");
  keys(config, ["defaultRole", "defaultHarness", "roles"], "peer spawn config");
  const roles = object(config.roles, "roles");
  if (typeof config.defaultRole !== "string" || !slug.test(config.defaultRole) || !(config.defaultRole in roles)) throw new Error("defaultRole must name a configured role");
  if (config.defaultHarness !== "pi" && config.defaultHarness !== "claude") throw new Error("defaultHarness must be pi or claude");
  for (const [name, value] of Object.entries(roles)) {
    if (!slug.test(name) || name === "owner" || name === "host") throw new Error(`reserved or invalid peer role: ${name}`);
    const options = object(value, `role ${name}`);
    keys(options, ["pi", "claude"], `role ${name}`);
    if (!Object.keys(options).length) throw new Error(`role ${name} needs a pi or claude loadout`);
  }
  const selectedRole = role ?? config.defaultRole;
  const selectedHarness = harness ?? config.defaultHarness;
  if (!slug.test(selectedRole) || selectedRole === "owner" || selectedRole === "host" || !(selectedRole in roles)) throw new Error(`unknown or reserved peer role: ${selectedRole}`);
  const options = object(roles[selectedRole], `role ${selectedRole}`);
  if (!(selectedHarness in options)) throw new Error(`${selectedRole}/${selectedHarness} is not configured in ${configPath}`);
  return { role: selectedRole, harness: selectedHarness, startup: loadout(options[selectedHarness], configPath, `${selectedRole}/${selectedHarness}`, selectedHarness), configPath };
}

export function resolvePeerRole(role: string, env: Record<string, string | undefined> = process.env, harness: Harness = "pi"): PeerStartup {
  return resolvePeerSelection(role, harness, env).startup;
}
