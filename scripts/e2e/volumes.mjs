// An agent working on /Volumes keeps no key files there; invite + listen --as joins with a friendly name.
// Usage: J01N_E2E_VOLUME_DIR=<writable dir on /Volumes> node scripts/e2e/volumes.mjs <base> [helper]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const base = process.argv[2];
const helper = process.argv[3] ?? fileURLToPath(new URL("../../packages/helper/client/j01n.js", import.meta.url));
const volumesParent = process.env.J01N_E2E_VOLUME_DIR;
if (!volumesParent) { console.log("VOLUMES FLOW skipped (set J01N_E2E_VOLUME_DIR to a writable dir on /Volumes)"); process.exit(0); }
const host = mkdtempSync(join(tmpdir(), "vol-host-"));
const home = mkdtempSync(join(tmpdir(), "vol-home-"));
const guest = mkdtempSync(join(volumesParent, "j01n-keytest-"));
const tag = Math.random().toString(36).slice(2, 8);
const run = (cwd, args, extra = {}) => JSON.parse(execFileSync("node", [helper, ...args], { cwd, env: { ...process.env, BASE_URL: base, ...extra }, encoding: "utf8" }));
const asGuest = (args) => run(guest, args, { HOME: home });
try {
  const room = run(host, ["create", base, JSON.stringify({ host_id: "ines" })]);
  run(host, ["join", room.invite_link, "ines", "--no-workspace"]);
  asGuest(["register", `vol-${tag}`, `inv-${tag}`]);
  run(host, ["register", `inv-${tag}`]);
  run(host, ["invite", `inv-${tag}`, `vol-${tag}`, room.invite_link]);
  const joined = asGuest(["listen", `vol-${tag}`, "--as", "maya", "--display-name", "Maya", "--role", "builder", "--no-workspace"]);
  const maya = run(host, ["team"]).team.find((p) => p.id === "maya");
  const left = readdirSync(guest).filter((n) => n.startsWith(".j01n"));
  const roomsDir = join(home, ".config", "j01n", "rooms");
  const saved = existsSync(roomsDir) ? readdirSync(join(roomsDir, readdirSync(roomsDir)[0])) : [];
  const ok = joined.participant_id === "maya" && maya?.display_name === "Maya" && maya?.role === "builder" && left.length === 0 &&
    saved.some((n) => n.startsWith(".j01n-agent-")) && saved.some((n) => /^\.j01n-_r_.*-maya\.json$/.test(n)) && saved.includes(".j01n-rooms");
  console.log(ok ? "VOLUMES FLOW OK" : "VOLUMES FLOW FAILED " + JSON.stringify({ id: joined.participant_id, maya, left, saved }));
  if (!ok) process.exitCode = 1;
} finally { for (const dir of [guest, host, home]) rmSync(dir, { recursive: true, force: true }); }
