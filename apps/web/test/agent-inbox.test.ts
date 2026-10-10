import { describe, expect, it, vi } from "vitest";
import { inviteAgent, registerAgent, waitForInvites } from "@j01n/sdk/agents";
import app from "../src/index";
import { AgentInbox } from "../src/agents/agent-inbox";
import { createMockState } from "./room/helpers";

/** A fake Durable Object namespace: one real AgentInbox per name, as in production. */
function agentEnv() {
  const inboxes = new Map<string, AgentInbox>();
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      if (!inboxes.has(name)) inboxes.set(name, new AgentInbox(createMockState(), {}));
      return inboxes.get(name)!;
    },
  };
  return { AGENT_INBOX: ns } as never;
}

async function call(env: never, method: string, path: string, body?: unknown, token?: string) {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const sealed = { ciphertext: "c1", iv: "i1" };

describe("agent inboxes", () => {
  it("registers a name once and publishes only its public key", async () => {
    const env = agentEnv();
    const first = await call(env, "POST", "/agents", { name: "pi-agent", public_key: "PK", accept_from: ["claude-code"] });
    expect(first.status).toBe(200);
    expect(typeof first.body.agent_token).toBe("string");
    expect((await call(env, "POST", "/agents", { name: "pi-agent", public_key: "PK2" })).status).toBe(409);
    expect((await call(env, "GET", "/a/pi-agent")).body).toEqual({ name: "pi-agent", public_key: "PK" });
  });

  it("accepts invitations only from allowlisted agents proving who they are", async () => {
    const env = agentEnv();
    const pi = (await call(env, "POST", "/agents", { name: "pi-agent", public_key: "PK", accept_from: ["claude-code"] })).body.agent_token as string;
    const claude = (await call(env, "POST", "/agents", { name: "claude-code", public_key: "CK" })).body.agent_token as string;
    const stranger = (await call(env, "POST", "/agents", { name: "stranger", public_key: "SK" })).body.agent_token as string;

    expect((await call(env, "POST", "/a/pi-agent/invites", { from: "claude-code", sealed }, stranger)).status).toBe(401);
    expect((await call(env, "POST", "/a/pi-agent/invites", { from: "stranger", sealed }, stranger)).status).toBe(403);
    expect((await call(env, "POST", "/a/pi-agent/invites", { from: "claude-code", sealed }, claude)).status).toBe(200);

    const inbox = await call(env, "GET", "/a/pi-agent/invites", undefined, pi);
    expect((inbox.body.invites as Array<{ from: string; sealed: unknown }>).map((i) => [i.from, i.sealed])).toEqual([["claude-code", sealed]]);
    expect((await call(env, "GET", "/a/pi-agent/invites", undefined, claude)).status).toBe(401);
  });

  it("wait returns pending invitations at once, or wakes when one arrives, and invitations can be removed", async () => {
    const env = agentEnv();
    const pi = (await call(env, "POST", "/agents", { name: "pi-agent", public_key: "PK", accept_from: ["claude-code"] })).body.agent_token as string;
    const claude = (await call(env, "POST", "/agents", { name: "claude-code", public_key: "CK" })).body.agent_token as string;

    expect((await call(env, "GET", "/a/pi-agent/wait?timeout=1", undefined, pi)).body).toEqual({ timeout: true });
    const waiting = call(env, "GET", "/a/pi-agent/wait?timeout=5", undefined, pi);
    await new Promise((r) => setTimeout(r, 50));
    await call(env, "POST", "/a/pi-agent/invites", { from: "claude-code", sealed }, claude);
    const woke = (await waiting).body.invites as Array<{ id: string }>;
    expect(woke).toHaveLength(1);

    expect((await call(env, "DELETE", `/a/pi-agent/invites/${woke[0].id}`, undefined, pi)).status).toBe(200);
    expect((await call(env, "GET", "/a/pi-agent/invites", undefined, pi)).body.invites).toEqual([]);
  });

  it("SDK: an agent invites another by name; the link is sealed and opens only for the recipient", async () => {
    const env = agentEnv();
    const stored: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.body) stored.push(String(init.body));
      return app.request(new URL(url).pathname + new URL(url).search, init, env);
    });
    try {
      const claude = await registerAgent("https://j01n.me", "claude-code", []);
      const pi = await registerAgent("https://j01n.me", "pi-agent", ["claude-code"]);
      const link = "https://j01n.me/room/abc#very-secret-join-secret";
      await inviteAgent(claude, "pi-agent", link);

      const invites = await waitForInvites(pi, 1);
      expect(invites.map((i) => [i.from, i.room_link])).toEqual([["claude-code", link]]);
      expect(stored.some((body) => body.includes("very-secret-join-secret"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
