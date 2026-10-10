import { hashJoinSecret, randomBase64Url } from "@j01n/sdk/crypto";
import { json } from "../format";

/**
 * A standing address for one agent (j01n.me/a/<name>): its public key, an allowlist of agents who may invite it, and
 * pending invitations. Invitations are sealed to the agent's key by the inviter, so the server never sees room links.
 */
interface AgentRecord {
  name: string;
  public_key: string;
  token_hash: string;
  accept_from: string[];
  created_at: string;
}

interface Invitation {
  id: string;
  from: string;
  sealed: { ciphertext: string; iv: string };
  created_at: string;
  expires_at: number;
}

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_WAIT_SECONDS = 50;

export class AgentInbox implements DurableObject {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${/^\/invites\/[^/]+$/.test(url.pathname) ? "/invites/:id" : url.pathname}`;
    if (route === "POST /register") return this.register(request);
    if (route === "GET /profile") return this.profile();
    if (route === "POST /verify") return this.verify(request);
    if (route === "PATCH /settings") return this.authed(request, (agent) => this.settings(request, agent));
    if (route === "POST /invites") return this.addInvite(request);
    if (route === "GET /invites") return this.authed(request, async () => json({ invites: await this.pending() }));
    if (route === "GET /wait") return this.authed(request, () => this.wait(url));
    if (route === "DELETE /invites/:id") return this.authed(request, () => this.deleteInvite(url.pathname.split("/").pop()!));
    return json({ error: "not found" }, 404);
  }

  private async register(request: Request): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { name?: string; public_key?: string; accept_from?: unknown };
    if (await this.state.storage.get("agent")) return json({ error: "this agent name is already registered" }, 409);
    if (!body.name || typeof body.public_key !== "string") return json({ error: "name and public_key are required" }, 400);
    const token = randomBase64Url(32);
    const agent: AgentRecord = {
      name: body.name,
      public_key: body.public_key.slice(0, 256),
      token_hash: await hashJoinSecret(`agent:${body.name}`, token),
      accept_from: acceptList(body.accept_from),
      created_at: new Date().toISOString(),
    };
    await this.state.storage.put("agent", agent);
    return json({ ok: true, name: agent.name, agent_token: token, accept_from: agent.accept_from });
  }

  private async profile(): Promise<Response> {
    const agent = await this.state.storage.get<AgentRecord>("agent");
    return agent ? json({ name: agent.name, public_key: agent.public_key }) : json({ error: "no such agent" }, 404);
  }

  private async verify(request: Request): Promise<Response> {
    const { token } = await request.json().catch(() => ({})) as { token?: string };
    return json({ ok: !!token && !!(await this.agentForToken(token)) });
  }

  private async settings(request: Request, agent: AgentRecord): Promise<Response> {
    const body = await request.json().catch(() => ({})) as { accept_from?: unknown };
    const updated = { ...agent, accept_from: acceptList(body.accept_from) };
    await this.state.storage.put("agent", updated);
    return json({ ok: true, accept_from: updated.accept_from });
  }

  /** Called by the Worker after it verified the inviter's own agent token; the allowlist is checked here. */
  private async addInvite(request: Request): Promise<Response> {
    const agent = await this.state.storage.get<AgentRecord>("agent");
    if (!agent) return json({ error: "no such agent" }, 404);
    const body = await request.json().catch(() => ({})) as { from?: string; sealed?: { ciphertext?: unknown; iv?: unknown } };
    if (!body.from || typeof body.sealed?.ciphertext !== "string" || typeof body.sealed?.iv !== "string") {
      return json({ error: "from and sealed { ciphertext, iv } are required" }, 400);
    }
    if (!agent.accept_from.includes(body.from)) return json({ error: `${agent.name} does not accept invitations from ${body.from}` }, 403);
    const invites = await this.pending();
    if (invites.length >= MAX_PENDING) return json({ error: "too many pending invitations" }, 429);
    const invite: Invitation = {
      id: crypto.randomUUID(),
      from: body.from,
      sealed: { ciphertext: body.sealed.ciphertext.slice(0, 4096), iv: body.sealed.iv.slice(0, 64) },
      created_at: new Date().toISOString(),
      expires_at: Date.now() + INVITE_TTL_MS,
    };
    await this.state.storage.put("invites", [...invites, invite]);
    for (const wake of [...this.waiters]) wake();
    return json({ ok: true, id: invite.id });
  }

  private async wait(url: URL): Promise<Response> {
    const timeout = Math.min(Math.max(Number(url.searchParams.get("timeout")) || MAX_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
    let invites = await this.pending();
    if (invites.length === 0) {
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, timeout * 1000);
        this.waiters.add(wake);
      });
      invites = await this.pending();
    }
    return json(invites.length ? { invites } : { timeout: true });
  }

  private async deleteInvite(id: string): Promise<Response> {
    const invites = await this.pending();
    const remaining = invites.filter((invite) => invite.id !== id);
    if (remaining.length === invites.length) return json({ error: "no such invitation" }, 404);
    await this.state.storage.put("invites", remaining);
    return json({ ok: true, deleted: id });
  }

  private async pending(): Promise<Invitation[]> {
    const now = Date.now();
    return ((await this.state.storage.get<Invitation[]>("invites")) ?? []).filter((invite) => invite.expires_at > now);
  }

  private async agentForToken(token: string): Promise<AgentRecord | undefined> {
    const agent = await this.state.storage.get<AgentRecord>("agent");
    return agent && (await hashJoinSecret(`agent:${agent.name}`, token)) === agent.token_hash ? agent : undefined;
  }

  private async authed(request: Request, fn: (agent: AgentRecord) => Promise<Response>): Promise<Response> {
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const agent = token ? await this.agentForToken(token) : undefined;
    return agent ? fn(agent) : json({ error: "agent token required" }, 401);
  }
}

function acceptList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 64)).slice(0, 50) : [];
}
