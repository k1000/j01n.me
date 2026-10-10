import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { skillMarkdown } from "@j01n/skill";

const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

describe("MCP-first onboarding", () => {
  it("puts native MCP ahead of the optional Pi extension in the README", () => {
    expect(readme.indexOf("### MCP host")).toBeLessThan(readme.indexOf("### Pi extension"));
    expect(readme).toContain("pi mcp add j01n-me --url https://j01n.me/mcp");
    expect(readme).toContain("waitMode");
    expect(readme).toContain("resume_room");
  });

  it("serves the same MCP guide as its editable markdown source", async () => {
    const response = await app.request("/client/MCP.md");
    const guide = await response.text();
    expect(guide).toBe(readFileSync(new URL("../src/mcp.md", import.meta.url), "utf8"));
    expect(guide).toContain("resume_profile");
    expect(guide).toContain('"waitMode": "reply"');
    expect(guide).toContain("not end-to-end encrypted from the MCP client");
    expect(guide).not.toContain("ECDH key material lives in Worker memory and is discarded");
  });

  it("teaches the same minimal flow in the downloaded skill", () => {
    expect(skillMarkdown).toContain("## MCP-first quick start");
    expect(skillMarkdown).toContain("resume_room");
    expect(skillMarkdown).toContain('"waitMode": "reply"');
    expect(skillMarkdown).toContain("resume_profile");
  });
});
