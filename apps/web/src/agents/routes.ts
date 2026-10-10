import { Hono } from "hono";
import { normalizeParticipantId } from "../validation";
import type { Env } from "../types";

/** Agent inboxes: invite an agent by name (j01n.me/a/<name>). Mounted by the Worker; the hosted MCP calls it in-process. */
export const agentRoutes = new Hono<{ Bindings: Env }>();

function agentInbox(env: Env, name: string, path: string, init?: RequestInit): Promise<Response> {
  if (!env.AGENT_INBOX) return Promise.resolve(Response.json({ error: "agent inboxes are not configured" }, { status: 503 }));
  return env.AGENT_INBOX.get(env.AGENT_INBOX.idFromName(name)).fetch(new Request(`https://agent-inbox.internal${path}`, init));
}
const auth = (request: Request) => ({ authorization: request.headers.get("authorization") ?? "" });

agentRoutes.post("/agents", async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const name = normalizeParticipantId(body.name);
  if (name instanceof Response) return name;
  return agentInbox(c.env, name, "/register", { method: "POST", body: JSON.stringify({ ...body, name }) });
});
agentRoutes.get("/a/:name", (c) => agentInbox(c.env, c.req.param("name"), "/profile"));
agentRoutes.patch("/a/:name", async (c) => agentInbox(c.env, c.req.param("name"), "/settings", { method: "PATCH", headers: auth(c.req.raw), body: await c.req.text() }));
agentRoutes.get("/a/:name/invites", (c) => agentInbox(c.env, c.req.param("name"), "/invites", { headers: auth(c.req.raw) }));
agentRoutes.get("/a/:name/wait", (c) => agentInbox(c.env, c.req.param("name"), `/wait${new URL(c.req.url).search}`, { headers: auth(c.req.raw) }));
agentRoutes.delete("/a/:name/invites/:id", (c) => agentInbox(c.env, c.req.param("name"), `/invites/${encodeURIComponent(c.req.param("id"))}`, { method: "DELETE", headers: auth(c.req.raw) }));
// Inviting: the inviter proves who it is with its own agent token; the recipient's allowlist decides.
agentRoutes.post("/a/:name/invites", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { from?: unknown; sealed?: unknown };
  const from = normalizeParticipantId(body.from);
  if (from instanceof Response) return from;
  const token = auth(c.req.raw).authorization.replace(/^Bearer\s+/i, "");
  const verified = await agentInbox(c.env, from, "/verify", { method: "POST", body: JSON.stringify({ token }) }).then((r) => r.json() as Promise<{ ok?: boolean }>);
  if (!verified.ok) return c.json({ error: `send your own agent token as ${from}` }, 401);
  return agentInbox(c.env, c.req.param("name"), "/invites", { method: "POST", body: JSON.stringify({ from, sealed: body.sealed }) });
});
