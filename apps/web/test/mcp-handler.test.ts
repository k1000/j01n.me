import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler";
import { RoomEvents } from "../src/room/events";
import { RoomRegistry } from "../src/room/registry";
import { AgentInbox } from "../src/agents/agent-inbox";
import { createMockState } from "./room/helpers";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";

function rpc(method: string, params?: Record<string, unknown>, sessionId?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Request("https://j01n.me/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function initSession(): Promise<string> {
  const response = await handleMcpRequest(rpc("initialize"));
  return response.headers.get("mcp-session-id")!;
}

async function toolResultText<T = unknown>(response: Response): Promise<T> {
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0].text) as T;
}

const TEST_INVITE = JSON.stringify({ access: "https://j01n.me/r/test-room", join_secret: "secret" });

function getWithSession(sessionId: string): Request {
  return new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sessionId } });
}

function deleteSession(sessionId: string): Request {
  return new Request("https://j01n.me/mcp", { method: "DELETE", headers: { "mcp-session-id": sessionId } });
}

function makeRoomEnv(events: RoomEvents) {
  return {
    RENDEZVOUS: {
      idFromName: () => "id",
      get: () => ({
        fetch: async (url: string) => url.includes("__load_session") ? Response.json({ sessions: {} }) : events.subscribe("agent-a", false, 0),
      }),
    },
  } as never;
}

const NOOP_WAIT_UNTIL = { waitUntil: () => {} };
const NOOP_ENV = { RENDEZVOUS: {} } as never;

describe("hosted MCP handler", () => {
  it("rejects unsupported methods", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", { method: "PATCH" }));

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32000 } });
  });

  it("GET without a session returns documentation JSON", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp"));

    expect(response.status).toBe(200);
    const body = await response.json() as { protocol: string; configure: unknown };
    expect(body.protocol).toBe("MCP Streamable HTTP");
    expect(body.configure).toBeTruthy();
  });

  it("rejects invalid JSON", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 } });
  });

  it("handles initialize", async () => {
    const response = await handleMcpRequest(rpc("initialize"));
    const body = await response.json() as { result: { serverInfo: { name: string } } };

    expect(response.status).toBe(200);
    expect(body.result.serverInfo.name).toBe("j01n.me");
  });

  it("lists tools", async () => {
    const response = await handleMcpRequest(rpc("tools/list"));
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };

    expect(body.result.tools.map((tool) => tool.name)).toContain("create_room");
    expect(body.result.tools.map((tool) => tool.name)).toContain("send_message");
  });

  it("wraps tool call results as MCP content", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "get_room_info",
      arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/test-room", join_secret: "secret" }) },
    }), {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({ ok: true }),
        }),
      },
    } as never);
    const body = await toolResultText<{ ok: boolean }>(response);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("surfaces deleted room errors clearly from tool calls", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "get_room_info",
      arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/deleted-room", join_secret: "secret" }) },
    }), {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({
            error: "room not found",
            reason: "room does not exist or has been deleted",
            deleted: true,
          }, { status: 404 }),
        }),
      },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32603,
        message: "/status failed: 404 room not found: room does not exist or has been deleted",
      },
    });
  });

  it("returns a JSON-RPC error for unknown tools", async () => {
    const response = await handleMcpRequest(rpc("tools/call", { name: "missing_tool", arguments: {} }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("returns a JSON-RPC error for unknown methods", async () => {
    const response = await handleMcpRequest(rpc("missing/method"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32601 } });
  });

  it("accepts initialized notifications without a body", async () => {
    const response = await handleMcpRequest(rpc("notifications/initialized"));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("lists watch_room as an available tool", async () => {
    const response = await handleMcpRequest(rpc("tools/list"));
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };

    expect(body.result.tools.map((tool) => tool.name)).toContain("watch_room");
  });

  it("watch_room streams room events as MCP JSON-RPC notifications", async () => {
    const events = new RoomEvents();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "watch_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), makeRoomEnv(events));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      events.notifyMessage({
        id: "m1", seq: 5, from: "agent-b", to: "agent-a",
        reply_to: null, intent: "notify", priority: "normal",
        body: {}, created_at: new Date(0).toISOString(),
      }, 5);

      const chunk = decoder.decode((await reader.read()).value);
      expect(chunk).toContain("event: message");
      expect(chunk).toContain('"method":"notifications/j01n.me/message"');
      expect(chunk).toContain('"last_seq":5');
    } finally {
      await reader.cancel();
    }
  });

  it("initialize mints a Mcp-Session-Id header", async () => {
    const response = await handleMcpRequest(rpc("initialize"));

    expect(response.status).toBe(200);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("GET with Mcp-Session-Id opens a listening SSE stream", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(getWithSession(sessionId));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      const ready = decoder.decode((await reader.read()).value);
      expect(ready).toContain("notifications/j01n.me/listening");
      expect(ready).toContain(sessionId);
    } finally {
      await reader.cancel();
    }
  });

  it("allows replacing a listening stream for the same session", async () => {
    const sessionId = await initSession();
    const first = await handleMcpRequest(getWithSession(sessionId));
    const second = await handleMcpRequest(getWithSession(sessionId));

    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("text/event-stream");
    await first.body!.cancel();
    await second.body!.cancel();
  });

  it("subscribe_room forwards room events into the session's listening stream", async () => {
    const sessionId = await initSession();
    const listening = await handleMcpRequest(getWithSession(sessionId));
    const reader = listening.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // listening notification

    const events = new RoomEvents();
    const env = makeRoomEnv(events);

    const subResponse = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), env, NOOP_WAIT_UNTIL);
    const subResult = await toolResultText<{ ok: boolean; subscription_id: string }>(subResponse);
    expect(subResult.ok).toBe(true);
    expect(subResult.subscription_id).toMatch(/^[0-9a-f-]{36}$/);

    events.notifyMessage({
      id: "m1", seq: 7, from: "agent-b", to: "agent-a",
      reply_to: null, intent: "notify", priority: "normal",
      body: {}, created_at: new Date(0).toISOString(),
    }, 7);

    try {
      const frame = decoder.decode((await reader.read()).value);
      expect(frame).toContain("id: 1");
      expect(frame).toContain('"method":"notifications/j01n.me/message"');
      expect(frame).toContain('"last_seq":7');
    } finally {
      await reader.cancel();
    }
  });

  it("subscribe_room without an active listening stream errors", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), NOOP_ENV);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("no active listening stream") },
    });
  });

  it("subscribe_room without Mcp-Session-Id errors", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), NOOP_ENV);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("requires the Mcp-Session-Id header") },
    });
  });

  it("unsubscribe_room cancels an active subscription", async () => {
    const sessionId = await initSession();
    const listening = await handleMcpRequest(getWithSession(sessionId));
    const reader = listening.body!.getReader();
    await reader.read(); // listening notification

    const events = new RoomEvents();
    const env = makeRoomEnv(events);

    const subResponse = await handleMcpRequest(rpc("tools/call", {
      name: "subscribe_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }, sessionId), env, NOOP_WAIT_UNTIL);
    const subResult = await toolResultText<{ subscription_id: string }>(subResponse);

    const unsubResponse = await handleMcpRequest(rpc("tools/call", {
      name: "unsubscribe_room",
      arguments: { subscriptionId: subResult.subscription_id },
    }, sessionId), env);

    expect(await toolResultText(unsubResponse)).toMatchObject({ ok: true, found: true });
    await reader.cancel();
  });

  it("unsubscribe_room is idempotent for unknown subscriptions", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "unsubscribe_room",
      arguments: { subscriptionId: "does-not-exist" },
    }, sessionId), NOOP_ENV);

    expect(await toolResultText(response)).toMatchObject({ ok: true, found: false });
  });

  it("DELETE without Mcp-Session-Id is a 400", async () => {
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", { method: "DELETE" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("missing Mcp-Session-Id") },
    });
  });

  it("DELETE with Mcp-Session-Id tears down the session", async () => {
    const sessionId = await initSession();
    const response = await handleMcpRequest(deleteSession(sessionId));

    expect(response.status).toBe(204);

    const listening = await handleMcpRequest(getWithSession(sessionId));
    expect(listening.status).toBe(200);
    expect(listening.headers.get("content-type")).toBe("text/event-stream");
    await listening.body!.cancel();
  });

  it("watch_room surfaces upstream auth failures as a JSON-RPC error", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => new Response("forbidden", { status: 403 }) }),
      },
    } as never;

    const response = await handleMcpRequest(rpc("tools/call", {
      name: "watch_room",
      arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" },
    }), env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32603, message: expect.stringContaining("/events failed: 403") },
    });
  });

  it("read_messages decrypts a peer message after fetching peer keys as the reader", async () => {
    const invite = JSON.stringify({ access: "https://j01n.me/r/decrypt-room", join_secret: "secret" });
    const peer = await createSdkCryptoSession("peer");
    const peerKey = (await peer.announceKeyBody()).public_key;
    let hostKey = "";
    let messages: unknown[] = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/participants/host") && init?.method === "PUT") {
              hostKey = JSON.parse(init.body as string).public_key;
              return Response.json({ cursor: 0 });
            }
            if (path.endsWith("/participants")) {
              // Mirrors the server: room secret alone is not enough to list participants.
              if (!new Headers(init?.headers).get("x-participant-id")) return Response.json({ error: "participant token is required" }, { status: 403 });
              return Response.json({ participants: [{ id: "peer", public_key: peerKey }] });
            }
            if (init?.method === "GET" || !init?.method) return Response.json({ messages, cursor: messages.length });
            return Response.json({ ok: true });
          },
        }),
      },
    } as never;

    await handleMcpRequest(rpc("tools/call", { name: "join_room", arguments: { inviteJson: invite, participantId: "host" } }), env);
    await peer.processPeerKeys([{ id: "host", public_key: hostKey }]);
    messages = [{ id: "m1", seq: 1, from: "peer", to: "host", intent: "notify", body: await peer.encryptForSend({ text: "hi host" }, "host") }];

    const response = await handleMcpRequest(rpc("tools/call", {
      name: "read_messages",
      arguments: { inviteJson: invite, participantId: "host" },
    }), env);
    const result = await toolResultText<{ messages: Array<{ body: unknown }> }>(response);

    expect(result.messages[0].body).toEqual({ text: "hi host" });
  });

  it("passes an optional webhookUrl to the participant (\"off\" clears it, omitted = polling)", async () => {
    const bodies: Array<{ method?: string; body: Record<string, unknown> }> = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (new URL(url).pathname.includes("/participants/")) bodies.push({ method: init?.method, body: JSON.parse(init?.body as string) });
            if (init?.method === "GET" || !init?.method) return Response.json({ messages: [], participants: [], cursor: 0 });
            return Response.json({ ok: true, cursor: 0 });
          },
        }),
      },
    } as never;
    const invite = JSON.stringify({ access: "https://j01n.me/r/hook-room", join_secret: "secret" });

    await handleMcpRequest(rpc("tools/call", { name: "join_room", arguments: { inviteJson: invite, participantId: "a", webhookUrl: "https://a.example/hook" } }), env);
    await handleMcpRequest(rpc("tools/call", { name: "update_status", arguments: { inviteJson: invite, participantId: "a", state: "free", status: "x", webhookUrl: "off" } }), env);
    await handleMcpRequest(rpc("tools/call", { name: "join_room", arguments: { inviteJson: invite, participantId: "b" } }), env);

    expect(bodies.map((b) => [b.method, b.body.webhook_url])).toEqual([
      ["PUT", "https://a.example/hook"],
      ["PATCH", null],
      ["PUT", undefined],
    ]);
  });

  it("reads the board and room status as a participant", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (_url: string, init?: RequestInit) => {
            // Mirrors the server: the room secret alone cannot read /board or /status.
            if (!new Headers(init?.headers).get("x-participant-id")) return Response.json({ error: "participant token is required" }, { status: 403 });
            return Response.json({ ok: true, board: {} });
          },
        }),
      },
    } as never;
    const invite = JSON.stringify({ access: "https://j01n.me/r/read-room", join_secret: "secret" });

    for (const name of ["read_board", "get_room_info"]) {
      const result = await toolResultText<{ ok: boolean }>(await handleMcpRequest(rpc("tools/call", { name, arguments: { inviteJson: invite, participantId: "a" } }), env));
      expect(result.ok).toBe(true);
    }
  });

  it("waits for an event, takes a room link and plain text, and reads others' messages by default", async () => {
    const requests: Array<[string | undefined, string, unknown]> = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const u = new URL(url);
            requests.push([init?.method ?? "GET", u.pathname + u.search, init?.body ? JSON.parse(init.body as string) : undefined]);
            if (u.pathname.endsWith("/wait")) return Response.json({ event: "message", cursor: 3 });
            if (u.pathname.endsWith("/participants")) return Response.json({ participants: [] });
            return Response.json({ ok: true, cursor: 3, messages: [], seq: 4 });
          },
        }),
      },
    } as never;
    const link = "https://j01n.me/room/link-room#secret";
    const call = (name: string, args: Record<string, unknown>) =>
      handleMcpRequest(rpc("tools/call", { name, arguments: { inviteJson: link, participantId: "a", ...args } }), env).then((r) => toolResultText<Record<string, unknown>>(r));

    expect(await call("wait_for_event", { timeoutSeconds: 5 })).toMatchObject({ woke: "message", messages: [] });
    expect(requests.some(([, path]) => path === "/wait?timeout=5")).toBe(true);
    expect(requests.some(([method, path]) => method === "GET" && path === "/")).toBe(true);

    requests.length = 0;
    await call("send_message", { to: "all", body: "hello there" });
    const sent = requests.find(([method, path]) => method === "POST" && path === "/");
    expect(sent?.[2]).toMatchObject({ to: "all" });
    requests.length = 0;
    const replied = await call("send_message", { to: "all", body: "and wait", waitForReply: true });
    expect(replied).toMatchObject({ sent: { ok: true }, woke: "message" });
    expect(requests.findIndex(([method]) => method === "POST")).toBeLessThan(requests.findIndex(([, path]) => path.startsWith("/wait")));
  });

  it("remembers the joined room per MCP session so later calls can omit it", async () => {
    const sent: string[] = [];
    const env: Record<string, unknown> = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            const auth = new Headers(init?.headers).get("authorization");
            if (path.includes("__load_session")) return Response.json({ sessions: {} });
            if (path.includes("__save_session")) return Response.json({ ok: true });
            if (init?.method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-b" });
            if (auth !== "Bearer tok-b") return Response.json({ error: "participant token is required" }, { status: 403 });
            if (init?.method === "POST" && path === "/") sent.push(JSON.parse(init.body as string).intent);
            return Response.json({ ok: true, seq: 2, participants: [], messages: [], board: {} });
          },
        }),
      },
    };
    const registry = new RoomRegistry(createMockState(), env as never);
    env.ROOM_REGISTRY = { idFromName: () => "global", get: () => registry };
    const s1 = await initSession();
    const s2 = await initSession();
    const call = (sid: string, name: string, args: Record<string, unknown>) =>
      handleMcpRequest(rpc("tools/call", { name, arguments: args }, sid), env as never).then((r) => r.json() as Promise<{ result?: { content: Array<{ text: string }> }; error?: { message: string } }>);

    await call(s1, "join_room", { inviteJson: "https://j01n.me/room/session-room#secret", participantId: "b" });
    const ok = await call(s1, "send_message", { to: "all", body: "no room arguments" });
    const other = await call(s2, "send_message", { to: "all", body: "different session" });

    expect(ok.error?.message).toBeUndefined();
    expect(sent).toEqual(["key.exchange", "notify"]);
    expect(other.error?.message).toContain("pass inviteJson");

    const listed = await (await handleMcpRequest(rpc("tools/list"))).json() as { result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> } };
    const schema = (name: string) => listed.result.tools.find((t) => t.name === name)!.inputSchema.required;
    expect(schema("send_message")).not.toContain("inviteJson");
    expect(schema("join_room")).toContain("inviteJson");
  });

  it("join_room announces its key with the new participant token", async () => {
    const announcedWith: string[] = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            const auth = new Headers(init?.headers).get("authorization");
            if (path.includes("__load_session")) return Response.json({ sessions: {} });
            if (path.includes("__save_session")) return Response.json({ ok: true });
            if (init?.method === "PUT") return Response.json({ ok: true, cursor: 0, participant_token: "tok-b" });
            // Mirrors the server: after joining, only the participant token is accepted.
            if (auth !== "Bearer tok-b") return Response.json({ error: "participant token is required" }, { status: 403 });
            if (init?.method === "POST") announcedWith.push(auth);
            if (path.endsWith("/board")) return Response.json({ board: { kickoff: { value: { goal: "ship it" }, version: 1 } } });
            if (path.endsWith("/asks")) return Response.json({ asks: [{ ask_id: "q1", seq: 4, from: "a", owed_by: "b", due_at: "2026-10-10T00:30:00.000Z", overdue: false, message: { id: "q1", seq: 4, from: "a", to: "b", intent: "notify", body: { text: "ready?" } } }] });
            return Response.json({ ok: true, participants: [], messages: [] });
          },
        }),
      },
    } as never;

    const result = await toolResultText<{ ok: boolean; kickoff: unknown; questions: unknown }>(await handleMcpRequest(rpc("tools/call", {
      name: "join_room", arguments: { inviteJson: "https://j01n.me/room/join-order-room#secret", participantId: "b" },
    }), env));

    expect(result.ok).toBe(true);
    expect(result.kickoff).toEqual({ goal: "ship it" });
    expect((result as unknown as { board: Record<string, { value: unknown }> }).board.kickoff.value).toEqual({ goal: "ship it" });
    expect(result.questions).toEqual([{ id: "q1", seq: 4, from: "a", body: { text: "ready?" }, due_at: "2026-10-10T00:30:00.000Z", overdue: false }]);
    expect(announcedWith).toEqual(["Bearer tok-b"]);
  });

  it("returns the current value when a versioned board write conflicts", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () => Response.json({ error: "board key changed since the version you read", key: "tasks", current_version: 2, current: { value: { a: 2 }, version: 2 } }, { status: 409 }),
        }),
      },
    } as never;
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "set_board_key",
      arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/conflict-room", join_secret: "secret" }), participantId: "a", key: "tasks", value: "{}", ifVersion: 1 },
    }), env);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('"current_version":2');
    expect(body.error.message).toContain('"a":2');
  });

  it("writes the board with set_board_key, patch_board and delete_board_key", async () => {
    const calls: Array<[string | undefined, string, unknown]> = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const u = new URL(url);
            const path = u.pathname + u.search;
            if (path.includes("/board")) calls.push([init?.method, path.replace(/^\/r\/[^/]+/, ""), init?.body ? JSON.parse(init.body as string) : undefined]);
            return Response.json({ ok: true });
          },
        }),
      },
    } as never;
    const invite = JSON.stringify({ access: "https://j01n.me/r/board-room", join_secret: "secret" });
    const call = (name: string, args: Record<string, unknown>) => handleMcpRequest(rpc("tools/call", { name, arguments: { inviteJson: invite, participantId: "a", ...args } }), env);

    await call("set_board_key", { key: "tasks", value: '{"t-1":{"title":"Docs"}}' });
    await call("patch_board", { values: '{"blockers":{},"decisions":["ship"]}' });
    await call("delete_board_key", { key: "tasks" });
    await call("set_board_key", { key: "claim", value: '{"owner":"a"}', ifVersion: 0 });
    await call("delete_board_key", { key: "claim", ifVersion: 1 });

    expect(calls).toEqual([
      ["PUT", "/board/tasks", { "t-1": { title: "Docs" } }],
      ["PATCH", "/board", { blockers: {}, decisions: ["ship"] }],
      ["DELETE", "/board/tasks", undefined],
      ["PUT", "/board/claim?if_version=0", { owner: "a" }],
      ["DELETE", "/board/claim?if_version=1", undefined],
    ]);
  });

  it("create_room returns ready-to-paste join snippets and next steps", async () => {
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({ fetch: async () => Response.json({ cursor: 0 }) }),
      },
    } as never;

    const response = await handleMcpRequest(rpc("tools/call", { name: "create_room", arguments: { hostId: "lead" } }), env);
    const result = await toolResultText<{
      access: string; join_secret: string;
      invite_link: string;
      join_snippets: { mcp: string; pi: string; cli: string };
      next_steps: string[];
    }>(response);

    const link = `${result.access.replace("/r/", "/room/")}#${result.join_secret}`;
    expect(result.invite_link).toBe(link);
    expect(result.join_snippets.pi).toBe(`/j01n join ${link} <your_name>`);
    expect(result.join_snippets.cli).toContain(`join ${link} <your_name>`);
    expect(result.join_snippets.mcp).toContain(link);
    expect(result.next_steps.join(" ")).toMatch(/read_messages with participantId "lead".*Room expires in ~\d+ min/);
  });

  it("read_messages learns peer keys from key.exchange messages when the participant list has none", async () => {
    const invite = JSON.stringify({ access: "https://j01n.me/r/keyx-room", join_secret: "secret" });
    const peer = await createSdkCryptoSession("peer");
    const peerKey = (await peer.announceKeyBody()).public_key;
    let hostKey = "";
    let messages: unknown[] = [];
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.endsWith("/participants/host") && init?.method === "PUT") {
              hostKey = JSON.parse(init.body as string).public_key;
              return Response.json({ cursor: 0 });
            }
            // Like the tiny CLI helper: peer joined without a public_key.
            if (path.endsWith("/participants")) return Response.json({ participants: [{ id: "peer" }] });
            if (init?.method === "GET" || !init?.method) return Response.json({ messages, cursor: messages.length });
            return Response.json({ ok: true });
          },
        }),
      },
    } as never;

    await handleMcpRequest(rpc("tools/call", { name: "join_room", arguments: { inviteJson: invite, participantId: "host" } }), env);
    await peer.processPeerKeys([{ id: "host", public_key: hostKey }]);
    messages = [
      { id: "k1", seq: 1, from: "peer", to: "all", intent: "key.exchange", body: { public_key: peerKey } },
      { id: "m1", seq: 2, from: "peer", to: "host", intent: "notify", body: await peer.encryptForSend({ text: "hi host" }, "host") },
    ];

    const response = await handleMcpRequest(rpc("tools/call", {
      name: "read_messages",
      arguments: { inviteJson: invite, participantId: "host" },
    }), env);
    const result = await toolResultText<{ messages: Array<{ body: unknown }> }>(response);

    expect(result.messages[1].body).toEqual({ text: "hi host" });
  });

  it("register_agent, invite_agent and wait_for_invite: invited by name, the agent joins; the inbox sees only ciphertext", async () => {
    const inboxes = new Map<string, AgentInbox>();
    const inboxBodies: string[] = [];
    const joined: string[] = [];
    const env = {
      AGENT_INBOX: {
        idFromName: (name: string) => name,
        get: (name: string) => {
          if (!inboxes.has(name)) inboxes.set(name, new AgentInbox(createMockState(), {}));
          const inbox = inboxes.get(name)!;
          return { fetch: async (request: Request) => { inboxBodies.push(await request.clone().text()); return inbox.fetch(request); } };
        },
      },
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (path.includes("__load_session")) return Response.json({ sessions: {} });
            if (init?.method === "PUT") { joined.push(path); return Response.json({ ok: true, cursor: 0, participant_token: "tok" }); }
            return Response.json({ ok: true, participants: [], messages: [], board: {}, asks: [] });
          },
        }),
      },
    } as never;
    const call = async <T,>(name: string, args: Record<string, unknown>) =>
      toolResultText<T>(await handleMcpRequest(rpc("tools/call", { name, arguments: args }), env));

    const host = await call<{ agentIdentity: string }>("register_agent", { name: "host-agent" });
    const guest = await call<{ agentIdentity: string; address: string }>("register_agent", { name: "guest-agent", acceptFrom: "host-agent" });
    expect(guest.address).toBe("https://j01n.me/a/guest-agent");

    await call("invite_agent", { agentIdentity: host.agentIdentity, to: "guest-agent", roomLink: "https://j01n.me/room/agent-room#very-secret-join-secret" });
    const result = await call<Record<string, unknown>>("wait_for_invite", { agentIdentity: guest.agentIdentity, timeoutSeconds: 1 });

    expect(result).toMatchObject({ invited_by: "host-agent", ok: true, room_id: "agent-room", participant_id: "guest-agent" });
    expect(joined).toContain("/participants/guest-agent");
    expect(inboxBodies.some((body) => body.includes("very-secret-join-secret"))).toBe(false);
    expect(await call("wait_for_invite", { agentIdentity: guest.agentIdentity, timeoutSeconds: 1 })).toEqual({ timeout: true });
  });

  it("join_room announces capabilities and a workspace sealed with the room key, and returns the team opened", async () => {
    const bodies: string[] = [];
    let workspace: string | undefined;
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            if (init?.body) bodies.push(String(init.body));
            if (path.includes("__load_session")) return Response.json({ sessions: {} });
            if (init?.method === "PUT") { workspace = JSON.parse(String(init.body)).workspace; return Response.json({ ok: true, cursor: 0, participant_token: "tok" }); }
            if (path.endsWith("/participants")) return Response.json({ participants: [{ id: "a", capabilities: ["code", "vision"], workspace }] });
            return Response.json({ ok: true, messages: [], board: {}, asks: [] });
          },
        }),
      },
    } as never;
    const result = await toolResultText<{ team: Array<{ id: string; capabilities: string[]; workspace: unknown }> }>(await handleMcpRequest(rpc("tools/call", { name: "join_room", arguments: {
      inviteJson: "https://j01n.me/room/ws-room#very-secret-join-secret", participantId: "a",
      capabilities: "code, vision", workspace: { path: "/Users/someone/private-repo", repo: "https://user:token@gitlab.com/acme/api.git", branch: "main" },
    } }), env));

    const put = JSON.parse(bodies.find((b) => b.includes("public_key") && b.includes("capabilities"))!);
    expect(put.capabilities).toEqual(["code", "vision"]);
    expect(put.workspace).toMatch(/^jsk1:/);
    expect(bodies.join()).not.toContain("/Users/someone/private-repo");
    expect(result.team[0]).toMatchObject({ id: "a", capabilities: ["code", "vision"], workspace: { path: "/Users/someone/private-repo", repo: "https://gitlab.com/acme/api.git", branch: "main" } });
  });
});
