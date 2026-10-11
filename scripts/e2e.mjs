#!/usr/bin/env node
// Live checks against a running j01n.me (local `wrangler dev` or production): helper smoke + scripts/e2e/*.mjs.
// Usage: node scripts/e2e.mjs <base> [helper]   Stops at the first failure.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [base, helper] = process.argv.slice(2);
if (!base) throw new Error("Usage: e2e.mjs <base> [helper]");
const here = dirname(fileURLToPath(import.meta.url));
for (const script of ["smoke-helper.mjs", "e2e/mcp.mjs", "e2e/sprint.mjs", "e2e/kinds.mjs", "e2e/volumes.mjs", "e2e/page.mjs"]) {
  console.log(`$ node scripts/${script} ${base}`);
  execFileSync(process.execPath, [join(here, script), base, ...(helper ? [helper] : [])], { stdio: "inherit" });
}
console.log("E2E passed");
