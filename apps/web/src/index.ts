import { Hono } from "hono";
import type { Context } from "hono";
import { clientPage } from "./client-assets";
import { claudeCodeMarkdown, cliMarkdown, mcpMarkdown, orchestrationMarkdown, piMarkdown, sdkMarkdown, securityMarkdown } from "./markdown-assets";
import { clientScript } from "@j01n/helper/client-script";
import { localCryptoPy, localCryptoSh, localCryptoTs } from "@j01n/helper/local-crypto-assets";
import { detectFormat, respondNegotiated } from "./format";
import { homeMarkdown, homePage, roomPageHtml, renderRoomAsMarkdown, roomPageMarkdownNoToken } from "./html";
import { RendezvousSession } from "./rendezvous";
import { RoomRegistry, sweepStaleRooms } from "./room/registry";
import { promoPage } from "./promo-page";
import { securityPage } from "./security";
import { skillExampleMarkdown, skillMarkdown } from "@j01n/skill";
import { skillExamplePage, skillPage } from "./skill-pages";
import { handleCreateRoom } from "./invite";
import { handleMcpRequest } from "./mcp-handler";
import { isValidRoomId } from "./validation";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  respondNegotiated(c.req.raw, homePage, homeMarkdown),
);

app.get("/security", (c) => respondNegotiated(c.req.raw, securityPage, () => securityMarkdown));

app.get("/security/SECURITY.md", (c) =>
  c.body(securityMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SECURITY.md"',
  }),
);

app.get("/skill", (c) => c.html(skillPage()));

app.get("/promo", (c) => c.html(promoPage));

app.get("/skill/examples/*", (c) => {
  const rawSlug = new URL(c.req.url).pathname.split("/").pop() ?? "";
  const wantsMarkdown = rawSlug.endsWith(".md");
  const slug = wantsMarkdown ? rawSlug.slice(0, -3) : rawSlug;

  if (wantsMarkdown) {
    const markdown = skillExampleMarkdown(slug);
    if (!markdown) return c.text("not found", 404);
    return c.body(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `inline; filename="${slug}.md"`,
    });
  }

  const page = skillExamplePage(slug);
  if (!page) return c.text("not found", 404);
  return c.html(page);
});

app.get("/client", (c) => c.html(clientPage()));

app.get("/client/SDK.md", (c) =>
  c.body(sdkMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="SDK.md"',
  }),
);

app.get("/client/PI.md", (c) =>
  c.body(piMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="PI.md"',
  }),
);

app.get("/client/CLI.md", (c) =>
  c.body(cliMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="CLI.md"',
  }),
);

app.get("/client/CLAUDE_CODE.md", (c) =>
  c.body(claudeCodeMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="CLAUDE_CODE.md"',
  }),
);

app.get("/client/ORCHESTRATION.md", (c) =>
  c.body(orchestrationMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="ORCHESTRATION.md"',
  }),
);

app.get("/client/MCP.md", (c) =>
  c.body(mcpMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'inline; filename="MCP.md"',
  }),
);

app.get("/client/mcp.json", (c) =>
  c.json(
    {
      mcpServers: {
        "j01n-me": {
          type: "http",
          url: "https://j01n.me/mcp",
        },
      },
    },
    200,
    { "content-disposition": 'attachment; filename=".mcp.json"' },
  ),
);

const clientFiles = [
  { path: "/client/j01n.js", body: clientScript, type: "application/javascript; charset=utf-8", filename: "j01n.js" },
  { path: "/client/crypto.ts", body: localCryptoTs, type: "text/plain; charset=utf-8", filename: "j01n-crypto.ts" },
  { path: "/client/crypto.py", body: localCryptoPy, type: "text/x-python; charset=utf-8", filename: "j01n_crypto.py" },
  { path: "/client/crypto.sh", body: localCryptoSh, type: "text/x-shellscript; charset=utf-8", filename: "j01n-crypto.sh" },
] as const;

for (const file of clientFiles) {
  app.get(file.path, (c) =>
    c.body(file.body, 200, {
      "content-type": file.type,
      "content-disposition": `inline; filename="${file.filename}"`,
    }),
  );
}

app.get("/skill/SKILL.md", (c) =>
  c.body(skillMarkdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="SKILL.md"',
  }),
);

app.post("/rooms", handleCreateRoom);
app.post("/invites", handleCreateRoom);

// Hosted MCP endpoint — POST for MCP calls, GET for SSE listening (with
// Mcp-Session-Id) or documentation (without), DELETE to terminate a session.
app.post("/mcp", (c) => handleMcpRequest(c.req.raw, c.env, { waitUntil: (p) => c.executionCtx.waitUntil(p) }));
app.delete("/mcp", (c) => handleMcpRequest(c.req.raw, c.env));
app.get("/room/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  if (!roomId || !isValidRoomId(roomId)) return c.text("not found", 404);

  const fmt = detectFormat(c.req.raw);
  if (fmt === "html") {
    return c.html(roomPageHtml(roomId));
  }

  // Non-HTML: try to authenticate and return room data as markdown
  const auth = c.req.header("authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const participantId = c.req.header("x-participant-id") ?? new URL(c.req.url).searchParams.get("participant_id") ?? undefined;
  if (!token) {
    return new Response(roomPageMarkdownNoToken(roomId), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }

  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (participantId) headers.set("x-participant-id", participantId);
  const exportReq = new Request(`https://rendezvous.internal/r/${encodeURIComponent(roomId)}/export`, { headers });
  const exportRes = await stub.fetch(exportReq);
  if (!exportRes.ok) {
    return new Response(`# Room\n\nFailed to load room data.\n`, {
      status: exportRes.status,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  const data: Record<string, unknown> = await exportRes.json();
  return new Response(renderRoomAsMarkdown(data), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
});

app.get("/mcp", (c) => handleMcpRequest(c.req.raw, c.env));

// Both routes are needed: Hono's `*` wildcard matches sub-paths but not the
// bare root path. The first catches the root, the second catches sub-paths.
const routeRoom = (c: Context<{ Bindings: Env }>) => {
  const roomId = c.req.param("roomId");
  if (!roomId || !isValidRoomId(roomId)) return c.text("not found", 404);
  const raw = c.req.raw;
  if (!raw) return c.text("internal error", 500);
  const id = c.env.RENDEZVOUS.idFromName(roomId);
  const stub = c.env.RENDEZVOUS.get(id);
  return stub.fetch(raw);
};
app.all("/r/:roomId", routeRoom);
app.all("/r/:roomId/*", routeRoom);

app.notFound((c) => c.text("not found", 404));

async function scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
  await sweepStaleRooms(env);
}

(app as unknown as { scheduled: typeof scheduled }).scheduled = scheduled;

export default app;
export { RendezvousSession, RoomRegistry };
