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
        fetch: async (url: string) => url.includes("__load_session") ? Response.json({ sessions: {} }) : events.subscribe("agent-a", new URL(url).searchParams.get("include_self") === "true", 0),
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

  it("cancels a delayed subscription open when its listening stream was replaced", async () => {
    const sid = await initSession();
    const first = (await handleMcpRequest(getWithSession(sid))).body!.getReader();
    await first.read();
    let release!: () => void, opened!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { opened = resolve; });
    const events = new RoomEvents();
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async (url: string) => {
      if (url.includes("__load_session")) return Response.json({ sessions: {} });
      opened();
      await gate;
      return events.subscribe("agent-a", false, 0);
    } }) } } as never;
    const subscribing = handleMcpRequest(rpc("tools/call", { name: "subscribe_room", arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" } }, sid), env);
    await started;
    const second = (await handleMcpRequest(getWithSession(sid))).body!.getReader();
    try {
      await second.read();
      release();
      expect((await subscribing).status).toBe(500);
      expect(await Promise.race([second.read().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 25))])).toBe(false);
    } finally { release(); await second.cancel(); await first.cancel(); }
  });

  it("suppresses a fulfilled read batch when unsubscribe runs before its continuation", async () => {
    const sid = await initSession();
    const listening = (await handleMcpRequest(getWithSession(sid))).body!.getReader();
    await listening.read();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async (url: string) => url.includes("__load_session") ? Response.json({ sessions: {} }) : new Response(stream, { headers: { "content-type": "text/event-stream" } }) }) } } as never;
    const sub = await toolResultText<{ subscription_id: string }>(await handleMcpRequest(rpc("tools/call", { name: "subscribe_room", arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" } }, sid), env));
    const request = rpc("tools/call", { name: "unsubscribe_room", arguments: { subscriptionId: sub.subscription_id } }, sid);
    const body = await request.json();
    let release!: (value: unknown) => void;
    request.json = <T>() => new Promise<T>(resolve => { release = value => resolve(value as T); });
    const unsubscribing = handleMcpRequest(request, env);
    release(body);
    // Fulfill the reader between JSON parsing and unsubscribe; its continuation runs after cancellation.
    queueMicrotask(() => controller.enqueue(new TextEncoder().encode('event: message\ndata: {"id":"queued-one"}\n\nevent: message\ndata: {"id":"queued-two"}\n\n')));
    try {
      expect((await unsubscribing).status).toBe(200);
      expect(await Promise.race([listening.read().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 25))])).toBe(false);
    } finally { await listening.cancel(); }
  });

  it("honors unsubscribe while the listening stream is disconnected", async () => {
    const events = new RoomEvents();
    const env = makeRoomEnv(events);
    const init = await handleMcpRequest(rpc("initialize"), env);
    const sid = init.headers.get("mcp-session-id")!;
    const first = (await handleMcpRequest(getWithSession(sid), env)).body!.getReader();
    await first.read();
    const subscribed = await toolResultText<{ subscription_id: string }>(await handleMcpRequest(rpc("tools/call", { name: "subscribe_room", arguments: { inviteJson: JSON.stringify({ access: "https://j01n.me/r/offline-unsubscribe", join_secret: "secret" }), participantId: "agent-a" } }, sid), env));
    await first.cancel();
    await handleMcpRequest(rpc("tools/call", { name: "unsubscribe_room", arguments: { subscriptionId: subscribed.subscription_id } }, sid), env);
    const second = (await handleMcpRequest(getWithSession(sid), env)).body!.getReader();
    try {
      await second.read();
      expect(await Promise.race([second.read().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 25))])).toBe(false);
    } finally { await second.cancel(); }
  });

  it("reconnects a listening stream without duplicate room event pumps", async () => {
    const sid = await initSession();
    const first = await handleMcpRequest(getWithSession(sid));
    const firstReader = first.body!.getReader();
    await firstReader.read();
    const events = new RoomEvents();
    await handleMcpRequest(rpc("tools/call", { name: "subscribe_room", arguments: { inviteJson: TEST_INVITE, participantId: "agent-a" } }, sid), makeRoomEnv(events), NOOP_WAIT_UNTIL);
    const second = await handleMcpRequest(getWithSession(sid));
    const reader = second.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await reader.read(); // listening
      expect(decoder.decode((await reader.read()).value)).toContain("notifications/j01n.me/restored");
      events.notifyMessage({ id: "self-not-echoed", seq: 6, from: "agent-a", to: "all", reply_to: null, intent: "notify", priority: "normal", body: {}, created_at: new Date(0).toISOString() }, 6);
      events.notifyMessage({ id: "only-once", seq: 7, from: "agent-b", to: "agent-a", reply_to: null, intent: "notify", priority: "normal", body: {}, created_at: new Date(0).toISOString() }, 7);
      expect(decoder.decode((await reader.read()).value)).toContain("only-once");
      const extra = await Promise.race([reader.read().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15))]);
      expect(extra).toBe(false);
    } finally {
      await reader.cancel();
      await firstReader.cancel();
      events.notifyBoard("tasks", "agent-b");
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

  it("linked-reply waiting ignores unrelated messages and board events while returning their catch-up data", async () => {
    let reads = 0, waits = 0;
    let sentBody: Record<string, unknown> = {};
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.includes("__load_session")) return Response.json({ sessions: {} });
      if (u.pathname.includes("__save_session")) return Response.json({ ok: true });
      if (u.pathname.endsWith("/participants")) return Response.json({ participants: [{ id: "a", last_read_seq: 8 }] });
      if (init?.method === "POST") { sentBody = JSON.parse(String(init.body)); return Response.json({ ok: true, id: "ask-1", seq: 10 }); }
      if (u.pathname.endsWith("/wait")) {
        waits++;
        expect(u.searchParams.get("after")).toBe(String(reads === 1 ? 10 : 11));
        return Response.json(waits === 1 ? { event: "board", changes: { tasks: { value: "in progress", version: 2 } } } : { event: "message" });
      }
      reads++;
      expect(u.searchParams.get("after")).toBe(String(reads === 1 ? 8 : reads === 2 ? 10 : 11));
      return Response.json({ cursor: reads === 1 ? 10 : reads === 2 ? 11 : 12, messages: reads === 1 ? [{ id: "older-unread", seq: 9, from: "peer", to: "a", body: { text: "Keep this earlier handoff" } }] : [{
        id: reads === 2 ? "noise" : "answer", seq: reads === 2 ? 11 : 12, from: "peer", to: "a", reply_to: reads === 2 ? "another-ask" : "ask-1", body: { text: reads === 2 ? "unrelated" : "Ready" },
      }] });
    } }) } } as never;
    const response = await handleMcpRequest(rpc("tools/call", { name: "send_message", arguments: {
      inviteJson: "https://j01n.me/room/linked-room#secret", participantId: "a", to: "all", body: "Ready?", waitMode: "reply",
    } }), env);
    const result = await toolResultText<{ timeout: boolean; reply: { id: string }; messages: Array<{ id: string }>; board: unknown }>(response);
    expect(result.reply?.id).toBe("answer");
    expect(result.timeout).toBe(false);
    expect(result.messages.map(m => m.id)).toEqual(["older-unread", "noise", "answer"]);
    expect(result.board).toEqual({ tasks: { value: "in progress", version: 2 } });
    expect(sentBody.expects_reply).toBe(true);
    expect(waits).toBe(2);
  });

  it.each(["immediate", "timeout", "reply-at-timeout"])("linked waiting handles %s and does not accept another sender's reply", async (scenario) => {
    const peer = await createSdkCryptoSession("peer");
    const { public_key } = await peer.announceKeyBody();
    let reads = 0, waits = 0;
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.includes("__load_session")) return Response.json({ sessions: {} });
      if (u.pathname.includes("__save_session")) return Response.json({ ok: true });
      if (u.pathname.endsWith("/participants")) return Response.json({ participants: [{ id: "peer", public_key }] });
      if (init?.method === "POST") return Response.json({ ok: true, id: "ask", seq: 10 });
      if (u.pathname.endsWith("/wait")) { waits++; return Response.json({ timeout: true }); }
      reads++;
      const answered = scenario === "immediate" || (scenario === "reply-at-timeout" && reads === 2);
      return Response.json({ cursor: answered ? 12 : 11, messages: [{ id: answered ? "answer" : "intruder", seq: answered ? 12 : 11, from: answered ? "peer" : "not-the-recipient", to: "a", reply_to: "ask", body: { text: answered ? "Ready" : "Not your answer" } }] });
    } }) } } as never;
    const result = await toolResultText<{ timeout: boolean; reply: { id: string } | null; messages: Array<{ id: string }> }>(await handleMcpRequest(rpc("tools/call", { name: "send_message", arguments: {
      inviteJson: `https://j01n.me/room/boundary-${scenario}#secret`, participantId: "a", to: "peer", body: "Ready?", waitMode: "reply", timeoutSeconds: 1,
    } }), env));
    expect(result.timeout).toBe(scenario === "timeout");
    expect(result.reply?.id ?? null).toBe(scenario === "timeout" ? null : "answer");
    expect(waits).toBe(scenario === "immediate" ? 0 : 1);
    expect(result.messages.filter(m => m.id === "intruder")).toHaveLength(scenario === "immediate" ? 0 : 1);
  });

  it("retains every message observed across more than one history window", async () => {
    let reads = 0;
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes("__load_session")) return Response.json({ sessions: {} });
      if (path.includes("__save_session")) return Response.json({ ok: true });
      if (path.endsWith("/participants")) return Response.json({ participants: [] });
      if (init?.method === "POST") return Response.json({ ok: true, id: "ask", seq: 201 });
      if (path.endsWith("/wait")) return Response.json({ event: "message" });
      reads++;
      const messages = reads === 1 ? Array.from({ length: 200 }, (_, i) => ({ id: `older-${i}`, seq: i + 1, from: "peer", to: "all", body: { text: "Earlier update" } }))
        : [{ id: "answer", seq: 202, from: "peer", to: "a", reply_to: "ask", body: { text: "Ready" } }];
      return Response.json({ cursor: reads === 1 ? 201 : 202, messages });
    } }) } } as never;
    const result = await toolResultText<{ messages: Array<{ id: string }> }>(await handleMcpRequest(rpc("tools/call", { name: "send_message", arguments: {
      inviteJson: "https://j01n.me/room/overflow-wait#secret", participantId: "a", to: "all", body: "Ready?", waitMode: "reply",
    } }), env));
    expect(result.messages).toHaveLength(201);
    expect(result.messages[0].id).toBe("older-0");
  });

  it("rejects invalid wait options before sending anything", async () => {
    let fetched = false;
    const env = { RENDEZVOUS: { idFromName: () => "id", get: () => ({ fetch: async () => { fetched = true; return Response.json({}); } }) } } as never;
    for (const options of [{ waitMode: "wrong" }, { waitMode: "reply", timeoutSeconds: 0 }, { timeoutSeconds: 51 }]) {
      const response = await handleMcpRequest(rpc("tools/call", { name: "send_message", arguments: {
        inviteJson: "https://j01n.me/room/invalid-wait#secret", participantId: "a", to: "all", body: "Do not send", ...options,
      } }), env);
      expect(response.status).toBe(500);
    }
    expect(fetched).toBe(false);
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

  it("reserve_paths / list_reservations / release_paths: sealed on the board, overlapping reservations refused", async () => {
    let reservations: { value: unknown; version: number } | undefined;
    const env = {
      RENDEZVOUS: {
        idFromName: () => "id",
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            const u = new URL(url);
            if (u.pathname.includes("__load_session")) return Response.json({ sessions: {} });
            if (u.pathname.endsWith("/board")) return Response.json({ board: reservations ? { reservations } : {} });
            if (u.pathname.endsWith("/board/reservations") && init?.method === "PUT") {
              if (Number(u.searchParams.get("if_version")) !== (reservations?.version ?? 0)) return Response.json({ error: "version conflict" }, { status: 409 });
              reservations = { value: JSON.parse(String(init.body)), version: (reservations?.version ?? 0) + 1 };
              return Response.json({ ok: true });
            }
            return Response.json({ ok: true, participants: [], messages: [] });
          },
        }),
      },
    } as never;
    const link = "https://j01n.me/room/res-room#very-secret-join-secret";
    const call = async (name: string, args: Record<string, unknown>) => (await handleMcpRequest(rpc("tools/call", { name, arguments: { inviteJson: link, ...args } }), env)).json() as Promise<{ result?: { content: Array<{ text: string }> }; error?: { message: string } }>;
    const data = (r: { result?: { content: Array<{ text: string }> } }) => JSON.parse(r.result!.content[0].text);

    await call("reserve_paths", { participantId: "a", repo: "gitlab.com/acme/api", paths: "src/auth/", reason: "refactoring auth" });
    expect(JSON.stringify(reservations)).not.toContain("src/auth");
    const refused = await call("reserve_paths", { participantId: "b", repo: "gitlab.com/acme/api", paths: "src/auth/login.ts" });
    expect(JSON.stringify(refused)).toContain("already reserved by a (refactoring auth)");
    expect(data(await call("list_reservations", { participantId: "b" })).reservations).toMatchObject([{ by: "a", repo: "gitlab.com/acme/api", paths: ["src/auth/"] }]);
    await call("release_paths", { participantId: "a" });
    expect(data(await call("list_reservations", { participantId: "b" })).reservations).toEqual([]);
  });
});
