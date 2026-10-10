#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = process.argv.slice(2);
const peer = flags.includes("--peer");
const smokeIndex = flags.indexOf("--smoke");
if (flags.some((flag, index) => flag === "--peer" && index !== flags.lastIndexOf(flag)) ||
    (smokeIndex !== -1 && (!flags[smokeIndex + 1] || flags[smokeIndex + 1].startsWith("--"))) ||
    flags.length !== (peer ? 1 : 0) + (smokeIndex !== -1 ? 2 : 0)) {
  throw new Error("Usage: check-contract.mjs [--peer] [--smoke <base>]");
}

function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function walk(dir, predicate) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate);
    else if (entry.isFile()) predicate(path);
  }
}

function checkDependencies() {
  const packagesDir = join(root, "packages");
  const appsDir = join(root, "apps");
  const inside = (path, dir) => path === dir || path.startsWith(dir + sep);
  const appNames = new Set(readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(appsDir, entry.name, "package.json"), "utf8")).name));
  for (const manifest of [join(root, "package.json"), ...[packagesDir, appsDir].flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name, "package.json"))
  )]) {
    const json = JSON.parse(readFileSync(manifest, "utf8"));
    if (inside(manifest, packagesDir)) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(json[field] ?? {})) {
          if (appNames.has(name)) throw new Error(`${relative(root, manifest)}: package must not depend on app ${name}`);
        }
      }
    }
    function visit(value) {
      if (typeof value === "string" && value.startsWith("workspace:")) {
        throw new Error(`${relative(root, manifest)}: workspace: spec breaks npm install`);
      }
      if (value && typeof value === "object") Object.values(value).forEach(visit);
    }
    visit(json);
  }
  walk(packagesDir, (file) => {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) return;
    const owner = relative(packagesDir, file).split(sep)[0];
    const source = readFileSync(file, "utf8");
    // Static imports/exports, side-effect imports, dynamic imports and require calls.
    const imports = /\b(?:import|export)\s+(?:[^"';]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(imports)) {
      const spec = match[1] ?? match[2];
      const target = spec.startsWith(".") ? resolve(dirname(file), spec) : null;
      if ((target && inside(target, appsDir)) || spec.startsWith("apps/") || spec.startsWith("@/apps/") ||
          [...appNames].some((name) => spec === name || spec.startsWith(name + "/"))) {
        throw new Error(`${relative(root, file)}: package must not import apps/* (${spec})`);
      }
      if (target && inside(target, packagesDir) && relative(packagesDir, target).split(sep)[0] !== owner &&
          relative(packagesDir, target).split(sep)[1] === "src") {
        throw new Error(`${relative(root, file)}: use a package export, not a relative import into another package src (${spec})`);
      }
    }
  });
  console.log("Dependency direction and npm-compatible manifests: ok");
}

checkDependencies();
run("npx", ["tsc", "--noEmit"]);
run("npx", ["vitest", "run"]);
if (peer) console.log("Peer mode: generated-file checks skipped (integrator owns generated files)");
else {
  run(process.execPath, ["scripts/generate-client-script.mjs", "--check"]);
  run(process.execPath, ["scripts/generate-assets.mjs", "--check"]);
}

const temp = mkdtempSync(join(tmpdir(), "j01n-contract-"));
try {
  const copy = join(temp, "repo");
  mkdirSync(copy);
  run("git", ["archive", "HEAD", "-o", join(temp, "snapshot.tar")]);
  run("tar", ["-xf", join(temp, "snapshot.tar"), "-C", copy]);
  // Pi installs git packages with npm by default...
  run("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], copy);
  // ...or with bun when Pi's npmCommand is ["bun"] (it then runs plain `install`).
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0) {
    const bunCopy = join(temp, "repo-bun");
    mkdirSync(bunCopy);
    run("tar", ["-xf", join(temp, "snapshot.tar"), "-C", bunCopy]);
    run("bun", ["install"], bunCopy);
  } else {
    console.log("bun not installed: skipped the bun install check");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (smokeIndex !== -1) run(process.execPath, ["scripts/smoke-helper.mjs", flags[smokeIndex + 1]]);
console.log("Contract check passed");
