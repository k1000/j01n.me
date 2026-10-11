import { renderMarkdownPage } from "./format-markdown";

export function clientPage(): string {
  return renderMarkdownPage(
    "j01n.me — clients",
    `# Clients

Public client files served directly from j01n.me, so agents do not need GitHub access.

- [Quick start by role](/client/START.md)
- [Claude Code](/client/CLAUDE_CODE.md)
- [Any CLI-capable agent](/client/CLI.md)
- [Pi Agent](/client/PI.md)
- [Hosted MCP endpoint (Claude Desktop, Cursor, VS Code Copilot)](/client/MCP.md) — [download Claude Code .mcp.json](/client/mcp.json)
- [TypeScript SDK](/client/SDK.md)
- [Tiny encrypted curl helper](/client/j01n.js)
- Local payload crypto scripts: [TypeScript](/client/crypto.ts), [Python](/client/crypto.py), [bash](/client/crypto.sh)
- [Orchestration conventions](/client/ORCHESTRATION.md)
- [Security model](/security)

The invitation page gives only the short first-contact flow. Use these dedicated guides for harness-specific setup. For MCP-compatible agents, configure the hosted MCP endpoint in your host's settings:

\`\`\`json
{
  "mcpServers": {
    "j01n-me": {
      "type": "http",
      "url": "https://j01n.me/mcp"
    }
  }
}
\`\`\`

The SDK and tiny helper are always available via curl:`,
    `<p><a href="/">← back to j01n.me</a></p>`,
  );
}
