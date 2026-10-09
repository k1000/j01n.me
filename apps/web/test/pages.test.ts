import { describe, expect, it } from "vitest";
import { cliMarkdown, orchestrationMarkdown, piMarkdown, sdkMarkdown, securityMarkdown } from "../src/markdown-assets";
import app from "../src/index";
import { prefersMarkdown } from "../src/format";
import { homeMarkdown, homePage, roomPageHtml, roomPageMarkdownNoToken } from "../src/html";
import { securityPage } from "../src/security";
import { skillExampleMarkdown, skillMarkdown } from "@j01n/skill";
import { skillExamplePage, skillPage } from "../src/skill-pages";

describe("web UI scripts", () => {
  it("defines the saved-room helpers the home and room pages call", () => {
    for (const html of [homePage(), roomPageHtml("room-1")]) {
      for (const fn of ["persistInvite", "loadInvite", "removeInvite", "renderSavedRooms"]) {
        expect(html).toContain(`function ${fn}(`);
      }
    }
  });

  it("registers WebMCP tools only when the browser supports them", () => {
    const home = homePage();
    const room = roomPageHtml("room-1");
    expect(home).toContain('typeof mc.registerTool === "function"');
    expect(room).toContain('typeof mc.registerTool !== "function"');
    for (const name of ["create_room", "join_room"]) expect(home).toContain(`name: "${name}"`);
    for (const name of ["read_room", "send_message", "set_board_key", "update_status"]) expect(room).toContain(`name: "${name}"`);
    expect(room).toContain("untrustedContentHint: true");
  });
});

describe("promo page", () => {
  it("serves the standalone promo page at /promo", async () => {
    const res = await app.request("/promo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>j01n.me</title>");
    expect(html).toContain("Agents of all stacks, unite");
  });
});

describe("homePage", () => {
  it("presents the project and the end-to-end encryption promise", () => {
    const html = homePage();

    expect(html).toContain("ephemeral encrypted coordination service for AI agents");
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/security">End-to-end encryption via client-side ECDH + AES-256-GCM.</a>');
    expect(html).toContain("Agents from any project, platform, or skill set");
    expect(html).toContain("Rooms are temporary: no accounts, no persistent history");
    expect(html).not.toContain("Quick start");
    expect(html).toContain("HUMANS");
    expect(html).toContain("BOTS");
    expect(html).toContain('data-open-create-room');
    expect(html).toContain('id="create-room-dialog"');
    expect(html).toContain('name="max_participants"');
    expect(html).toContain('<option value="3">3</option>');
    expect(html).toContain('<option value="7" selected>7</option>');
    expect(html).toContain('<option value="11">11</option>');
    expect(html).toContain('name="invite_ttl_ms"');
    expect(html).toContain('<option value="600000">10 min</option>');
    expect(html).toContain('<option value="1800000" selected>30 min</option>');
    expect(html).toContain('<option value="3600000">1 h</option>');
    expect(html).toContain("Save this safely and use it to invite bots & humans.");
    expect(html).not.toContain("Choose the human gate when you want to start or enter a room directly.");
    expect(html).toContain("Option A: MCP host");
    expect(html).toContain("Option B: CLI helper");
    expect(html).not.toContain("If you were invited");
    expect(html).not.toContain("Trust model");
    expect(html).toContain('href="https://openclaw.ai/" target="_blank"');
    expect(html).toContain('href="https://www.anthropic.com/claude-code" target="_blank"');
    expect(html).toContain('href="https://openai.com/codex/" target="_blank"');
    expect(html).not.toContain("Client code");
    expect(html).toContain('<h2><span class="md-marker">##</span> Customizable orchestration board</h2>');
    expect(html).toContain("lightweight JSON coordination layer");
    expect(html).toContain('<h2><span class="md-marker">##</span> Features</h2>');
    expect(html).toContain(".md-marker");
    expect(html).toContain("--highlight: #fff1d7");
    expect(html).toContain("border-radius: 0");
    expect(html).toContain(".gate-tabs { display: flex; width: 100%;");
    expect(html).toContain("#gate-humans:checked ~ .gate-tabs");
    expect(html).toContain('<span class="md-bullet" aria-hidden="true">*</span>');
    expect(html).not.toContain('h2::before { content: "## ";');
    expect(html).toContain("<header><hgroup><h1><span>j01n</span><b>.</b><span>me</span></h1>");
    expect(html).toContain("<main>");
    expect(html).toContain("<article>");
    expect(html).toContain("<footer>");
    expect(html).not.toContain('class="tagline"');
    expect(html).not.toContain('class="hero-title"');
    expect(html).toContain("<meta name=\"description\"");
    expect(html).toContain("<meta property=\"og:title\"");
    expect(html).toContain("<meta name=\"twitter:card\" content=\"summary\"");
    expect(html).toContain("twitter.com/intent/tweet");
    expect(html).toContain("linkedin.com/sharing/share-offsite");
    expect(html).toContain("news.ycombinator.com/submitlink");
    expect(html).toContain("/skill");
    expect(html).toContain("/skill/SKILL.md");
    expect(html).not.toContain("/client/agent.py");
  });

  it("has markdown for agents", () => {
    const markdown = homeMarkdown();

    expect(markdown).toContain("# j01n.me");
    expect(markdown).toContain("Free, secure cross-project collaboration for heterogeneous AI agents");
    expect(markdown).toContain("[End-to-end encryption via client-side ECDH + AES-256-GCM.](/security)");
    expect(markdown).toContain("Agents from any project, platform, or skill set");
    expect(markdown).toContain("Rooms are temporary");
    expect(markdown).not.toContain("## Quick start");
    expect(markdown).toContain("### Option A: MCP host");
    expect(markdown).toContain('"access": "https://j01n.me/r/docs-review-x7k2"');
    expect(markdown).toContain("### Option B: CLI helper");
    expect(markdown).toContain("Hosted MCP endpoint");
    expect(markdown).toContain("## Customizable orchestration board");
    expect(markdown).toContain("lightweight JSON coordination layer");
    expect(markdown).toContain("## Integration options");
    expect(markdown).toContain("## Features");
    expect(markdown).not.toContain("## Ground rules");
    expect(markdown).toContain("[Tiny CLI helper](/client/j01n.js)");
    expect(markdown).toContain("[Hosted MCP endpoint](/client/MCP.md)");
    expect(markdown).toContain("[TypeScript SDK](/client/SDK.md)");
    expect(markdown).not.toContain("## Client code");
    expect(markdown).not.toContain("https://j01n.me/client/agent.py");
  });

  it("detects markdown-friendly agents", () => {
    expect(prefersMarkdown(new Request("https://j01n.me/", { headers: { accept: "text/markdown" } }))).toBe(true);
    expect(prefersMarkdown(new Request("https://j01n.me/?format=md"))).toBe(true);
    expect(prefersMarkdown(new Request("https://j01n.me/", { headers: { "user-agent": "curl/8.0" } }))).toBe(true);
    expect(prefersMarkdown(new Request("https://j01n.me/", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }))).toBe(false);
  });
});

describe("room page", () => {
  it("joins/read rooms without using host-only export", () => {
    const html = roomPageHtml("room-1");

    expect(html).toContain("/status");
    expect(html).toContain("/board");
    expect(html).toContain("?view=all&include_self=true");
    expect(html).not.toContain("/export");
  });

  it("documents full export as host-only", () => {
    const markdown = roomPageMarkdownNoToken("room-1");

    expect(markdown).toContain("identify your participant");
    expect(markdown).toContain("Raw full-room export is host-only");
    expect(markdown).toContain("x-participant-id: <host_id>");
  });
});

describe("skill page", () => {
  it("links to the downloadable skill", () => {
    expect(skillPage()).toContain("/skill/SKILL.md");
    expect(skillMarkdown).toContain("# j01n.me Agent Rendezvous");
    expect(skillMarkdown).toContain("heterogeneous agents");
    expect(skillMarkdown).toContain("Path A: MCP host");
    expect(skillMarkdown).toContain("Path B: Shell-capable agent");
    expect(skillMarkdown).toContain("npm install @j01n/sdk");
    expect(skillMarkdown).toContain("kanban");
    expect(skillMarkdown).toContain("milestone");
    expect(skillMarkdown).toContain("quick");
    expect(skillMarkdown).toContain("Board ACLs");
    expect(skillMarkdown).toContain("Keep messages concise");
    expect(skillMarkdown).toContain("reservation.claim");
    expect(skillMarkdown).toContain("concise. Link to artifacts");
    expect(skillMarkdown).toContain("Announce files before editing");
    expect(skillMarkdown).not.toContain("https://j01n.me/client/agent.py");
  });

  it("serves dedicated board example pages", async () => {
    expect(skillExamplePage("kanban-board")).toContain("Kanban board example");
    expect(skillExampleMarkdown("task-list-board")).toContain("Task list board example");
    expect(skillExampleMarkdown("ownership-and-blockers")).toContain("Ownership and blocker board example");

    const response = await app.request("/skill/examples/ownership-and-blockers");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("waiting for API example");
  });
});

describe("public client assets", () => {
  it("serves SDK docs content", () => {
    expect(sdkMarkdown).toContain("# j01n.me SDK / Client Usage");
    expect(sdkMarkdown).toContain("ORCHESTRATION.md");
    expect(sdkMarkdown).toContain("createRoomAndJoin");
    expect(sdkMarkdown).toContain("/client/j01n.js");
    expect(orchestrationMarkdown).toContain("reservation.claim");
    expect(orchestrationMarkdown).toContain("review.result");
    expect(sdkMarkdown).not.toContain("python examples/agent.py");
    expect(piMarkdown).toContain("# j01n.me Pi Agent guide");
    expect(cliMarkdown).toContain("# j01n.me CLI helper guide");
  });

  it("serves encrypted helper and local crypto scripts", async () => {
    const pi = await app.request("/client/PI.md");
    expect(pi.status).toBe(200);
    expect(await pi.text()).toContain("/j01n join");

    const cli = await app.request("/client/CLI.md");
    expect(cli.status).toBe(200);
    expect(await cli.text()).toContain("j01n.me CLI helper guide");

    const mcpConfig = await app.request("/client/mcp.json");
    expect(mcpConfig.status).toBe(200);
    expect(mcpConfig.headers.get("content-disposition")).toContain('filename=".mcp.json"');
    expect(await mcpConfig.json()).toMatchObject({ mcpServers: { "j01n-me": { type: "http", url: "https://j01n.me/mcp" } } });

    const helper = await app.request("/client/j01n.js");
    expect(helper.status).toBe(200);
    expect(await helper.text()).toContain("Commands: create, join, send, read, inbox, watch, doctor");

    const shell = await app.request("/client/crypto.sh");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("j01n local payload crypto");

    const python = await app.request("/client/crypto.py");
    expect(python.status).toBe(200);
    expect(await python.text()).toContain("j01n_crypto.py <enc|dec>");

    const typescript = await app.request("/client/crypto.ts");
    expect(typescript.status).toBe(200);
    expect(await typescript.text()).toContain("j01n-crypto.ts <enc|dec>");
  });
});

describe("security page", () => {
  it("renders securityMarkdown into a page with a back link", () => {
    const html = securityPage();
    expect(html).toContain("Security Model");
    expect(html).toContain('href="/"');
  });

  it("publishes a markdown form for agents", () => {
    expect(securityMarkdown).toContain("# j01n.me — Security Model");
    expect(securityMarkdown).toContain("Layer 4 — Message encryption (E2E)");
    expect(securityMarkdown).toContain("Threat model");
  });
});
