#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const webSources = {
  homeHeroMarkdown: "apps/web/src/home-hero.md",
  homeBodyMarkdown: "apps/web/src/home-body.md",
  inviteTemplate: "apps/web/src/invite-template.md",
  cliMarkdown: "apps/web/src/cli.md",
  claudeCodeMarkdown: "apps/web/src/claude-code.md",
  mcpMarkdown: "apps/web/src/mcp.md",
  piMarkdown: "apps/web/src/pi.md",
  sdkMarkdown: "apps/web/src/sdk.md",
  orchestrationMarkdown: "apps/web/src/orchestration.md",
  securityMarkdown: "apps/web/src/security.md",
};
const exampleSources = {
  "kanban-board": "packages/skill/examples/kanban-board.md",
  "task-list-board": "packages/skill/examples/task-list-board.md",
  "ownership-and-blockers": "packages/skill/examples/ownership-and-blockers.md",
};

async function markdown(path) {
  return JSON.stringify(await readFile(resolve(root, path), "utf8"));
}

const webLines = ["// Generated from Markdown assets for Cloudflare Worker bundling."];
for (const [name, path] of Object.entries(webSources)) {
  webLines.push(`export const ${name}: string = ${await markdown(path)};`);
}

const skillLines = [
  `export const skillMarkdown: string = ${await markdown("packages/skill/skill.md")};`,
  "",
  "const boardExamples: Record<string, string> = {",
];
for (const [slug, path] of Object.entries(exampleSources)) {
  skillLines.push(`  ${JSON.stringify(slug)}: ${await markdown(path)},`);
}
skillLines.push(
  "};",
  "",
  "export function skillExampleMarkdown(slug: string): string | undefined {",
  "  return boardExamples[slug];",
  "}",
  "",
  "export function skillExampleTitle(slug: string): string | undefined {",
  '  return boardExamples[slug]?.split("\\n", 1)[0]?.replace(/^#\\s*/, "");',
  "}",
);

let stale = false;
for (const [path, output] of [
  ["apps/web/src/markdown-assets.ts", webLines.join("\n") + "\n"],
  ["packages/skill/src/skill.ts", skillLines.join("\n") + "\n"],
]) {
  const target = resolve(root, path);
  if (checkOnly) {
    if (await readFile(target, "utf8").catch(() => "") !== output) {
      console.error(`${path} is out of date. Run node scripts/generate-assets.mjs.`);
      stale = true;
    }
  } else {
    await writeFile(target, output);
    console.log(`generated ${path}`);
  }
}
if (stale) process.exitCode = 1;
else if (checkOnly) console.log("Markdown assets are up to date");
