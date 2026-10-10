import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/mcp-handler";
import { RoomRegistry } from "../src/room/registry";
import type { Env } from "../src/types";
import { bootstrapRoom, createMockState } from "./room/helpers";

type Handler = typeof handleMcpRequest;
interface ResumeProfile { roomUrl: string; participantId: string; participantToken: string }
interface Result {
  ok: boolean; resumed?: boolean; participant_id: string; resume_profile: ResumeProfile;
  cursor: number; messages: Array<{ id: string; body: unknown }>; board: Record<string, { value: unknown }>;
  questions: Array<{ body: unknown }>; timeout?: boolean; reply?: { body: unknown };
}

function rpc(method: string, sessionId?: string, params?: Record<string, unknown>) {
  return new Request("https://j01n.me/mcp", {
    method: "POST", headers: { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function fixture() {
  const state = createMockState();
  const room = await bootstrapRoom({ initialBoard: { kickoff: "Review the implementation" } }, state);
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const faults = { failEvents: false, beforeEvents: undefined as (() => Promise<void>) | undefined };
  const env = {
    RENDEZVOUS: { idFromName: () => room.roomId, get: () => ({ fetch: async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === "string" ? new Request(input, init) : input;
      const path = new URL(request.url).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ method: request.method, path, body });
      if (path.endsWith("/events")) {
        await faults.beforeEvents?.();
        if (faults.failEvents) return new Response("Unavailable", { status: 503 });
      }
      return room.session.fetch(request);
    } }) },
  } as unknown as Env;
  const registry = new RoomRegistry(createMockState(), env);
  env.ROOM_REGISTRY = { idFromName: () => "global", get: () => registry } as unknown as DurableObjectNamespace;
  const initialize = async (handler: Handler = handleMcpRequest) => (await handler(rpc("initialize"), env)).headers.get("mcp-session-id")!;
  const call = async (sessionId: string, name: string, args: Record<string, unknown> = {}, handler: Handler = handleMcpRequest) => {
    const response = await handler(rpc("tools/call", sessionId, { name, arguments: args }), env);
    const body = await response.json() as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return JSON.parse(body.result!.content[0].text) as Result;
  };
  const invite = `https://j01n.me/room/${room.roomId}#${room.joinSecret}`;
  return { room, env, requests, state, faults, initialize, call, invite };
}

describe("MCP identity resume", () => {
  it("resumes its remembered identity with board and unread messages, without joining or announcing a new key", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    expect(joined.resume_profile).toMatchObject({ participantId: "agent", participantToken: expect.any(String) });
    const peerSid = await f.initialize();
    await f.call(peerSid, "join_room", { inviteJson: f.invite, participantId: "peer" });
    await f.call(peerSid, "send_message", { to: "agent", body: "Unfinished handoff", expectsReply: true });
    const before = f.requests.length;
    const resumed = await f.call(sid, "resume_room");
    expect(resumed).toMatchObject({ ok: true, resumed: true, participant_id: "agent", resume_profile: joined.resume_profile });
    expect(resumed.board.kickoff.value).toBe("Review the implementation");
    expect(resumed.messages.some(m => JSON.stringify(m.body).includes("Unfinished handoff"))).toBe(true);
    expect(resumed.questions.some(q => JSON.stringify(q.body).includes("Unfinished handoff"))).toBe(true);
    expect(f.requests.slice(before).some(r => r.method === "PUT" || r.body.intent === "key.exchange")).toBe(false);
  });

  it("preserves keys and decrypts catch-up after both a fresh MCP session and a fresh Worker handler", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const peerSid = await f.initialize();
    await f.call(peerSid, "join_room", { inviteJson: f.invite, participantId: "peer" });
    await f.call(peerSid, "send_message", { to: "agent", body: "Recover this encrypted message" });
    const before = f.requests.length;
    vi.resetModules();
    const fresh = (await import("../src/mcp-handler")).handleMcpRequest;
    const newSid = await f.initialize(fresh);
    const resumed = await f.call(newSid, "resume_room", { profile: joined.resume_profile }, fresh);
    expect(resumed.resume_profile).toEqual(joined.resume_profile);
    expect(resumed.messages.some(m => JSON.stringify(m.body).includes("Recover this encrypted message"))).toBe(true);
    expect(f.requests.slice(before).some(r => r.method === "PUT" || r.body.intent === "key.exchange" || r.path === "/__save_session")).toBe(false);
    const again = await f.call(newSid, "resume_room", { afterSeq: joined.cursor }, fresh);
    expect(again.messages.some(m => JSON.stringify(m.body).includes("Recover this encrypted message"))).toBe(true);
  });

  it("restores a listening stream after a Worker recycle without duplicate subscriptions", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    vi.resetModules();
    const fresh = (await import("../src/mcp-handler")).handleMcpRequest;
    const listening = await fresh(new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sid } }), f.env);
    const reader = listening.body!.getReader();
    try {
      await reader.read();
      const before = f.requests.length;
      const resumed = await f.call(sid, "resume_room", {}, fresh) as Result & { subscription_active: boolean };
      expect(resumed.subscription_active).toBe(true);
      expect(resumed.resume_profile).toEqual(joined.resume_profile);
      await f.call(sid, "resume_room", {}, fresh);
      expect(f.requests.slice(before).filter(r => r.path.endsWith("/events"))).toHaveLength(1);
    } finally {
      await reader.cancel();
    }
  });

  it("waits for and decrypts a real encrypted reply from another MCP participant", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const peerSid = await f.initialize();
    const peer = await f.call(peerSid, "join_room", { inviteJson: f.invite, participantId: "peer" });
    const waiting = f.call(sid, "send_message", { to: "peer", body: "Ready?", waitMode: "reply", timeoutSeconds: 2 });
    let askId = "";
    for (let i = 0; i < 20 && !askId; i++) {
      const response = await f.room.session.fetch(new Request(`https://j01n.me${f.room.roomPath}/asks`, { headers: { authorization: "Bearer " + peer.resume_profile.participantToken } }));
      const { asks } = await response.json() as { asks: Array<{ ask_id: string }> };
      askId = asks[0]?.ask_id ?? "";
      if (!askId) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(askId).not.toBe("");
    await f.call(peerSid, "send_message", { to: "agent", body: "Ready to collaborate", replyTo: askId });
    const result = await waiting;
    expect(result.timeout).toBe(false);
    expect(result.reply?.body).toEqual({ text: "Ready to collaborate" });
  });

  it("requires selection when several identities are remembered", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "peer" });
    await expect(f.call(sid, "resume_room")).rejects.toThrow("Several rooms");
    expect((await f.call(sid, "resume_room", { profile: joined.resume_profile })).participant_id).toBe("agent");
  });

  it("rejects altered profile origins, HTTP and URL credentials before contacting the room", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    for (const origin of ["https://other.example", "http://j01n.me", "https://user:password@j01n.me"]) {
      const before = f.requests.length;
      await expect(f.call(sid, "resume_room", { profile: { ...joined.resume_profile, roomUrl: origin + new URL(joined.resume_profile.roomUrl).pathname } })).rejects.toThrow("Invalid resume profile");
      expect(f.requests.length).toBe(before);
    }
  });

  it("concurrent resumes start only one event pump", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const response = await handleMcpRequest(new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sid } }), f.env);
    const reader = response.body!.getReader();
    try {
      await reader.read();
      await Promise.all([f.call(sid, "resume_room"), f.call(sid, "resume_room")]);
      await f.call(sid, "set_board_key", { key: "pump-test", value: '"ready"' });
      let frame = "";
      while (!frame.includes("notifications/j01n.me/board")) frame = new TextDecoder().decode((await reader.read()).value);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("notifications/j01n.me/message");
      expect(await Promise.race([reader.read().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 25))])).toBe(false);
    } finally { await reader.cancel(); }
  });

  it("does not install a stale auto-subscription after reconnecting during its open", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const open = () => handleMcpRequest(new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sid } }), f.env);
    const first = (await open()).body!.getReader();
    await first.read();
    let release!: () => void, opened!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { opened = resolve; });
    f.faults.beforeEvents = async () => { f.faults.beforeEvents = undefined; opened(); await gate; };
    const resuming = f.call(sid, "resume_room");
    await started;
    const second = (await open()).body!.getReader();
    try {
      await second.read();
      expect(new TextDecoder().decode((await second.read()).value)).toContain("notifications/j01n.me/restored");
      release();
      expect((await resuming as Result & { subscription_active: boolean }).subscription_active).toBe(true);
      await f.call(sid, "set_board_key", { key: "race-test", value: '"ready"' });
      expect(new TextDecoder().decode((await second.read()).value)).toContain("notifications/j01n.me/board");
      expect(new TextDecoder().decode((await second.read()).value)).toContain("notifications/j01n.me/message");
      expect(await Promise.race([second.read().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 25))])).toBe(false);
    } finally { release(); await second.cancel(); await first.cancel(); }
  });

  it("reports a failed restoration as inactive and retries it on resume", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const open = () => handleMcpRequest(new Request("https://j01n.me/mcp", { method: "GET", headers: { "mcp-session-id": sid } }), f.env);
    const first = (await open()).body!.getReader();
    await first.read();
    await f.call(sid, "resume_room");
    await first.cancel();
    f.faults.failEvents = true;
    const second = (await open()).body!.getReader();
    try {
      await second.read();
      expect((await f.call(sid, "resume_room") as Result & { subscription_active: boolean }).subscription_active).toBe(false);
      f.faults.failEvents = false;
      expect((await f.call(sid, "resume_room") as Result & { subscription_active: boolean }).subscription_active).toBe(true);
    } finally { await second.cancel(); }
  });

  it("rejects a forged profile without leaking its token or binding the current room", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    const newSid = await f.initialize();
    await expect(f.call(newSid, "resume_room", { profile: { ...joined.resume_profile, participantToken: "wrong-private-token" } })).rejects.toThrow("Cannot resume");
    await expect(f.call(newSid, "send_message", { to: "all", body: "should not send" })).rejects.toThrow("pass inviteJson");
    expect(f.requests.some(r => r.body.body && JSON.stringify(r.body.body).includes("wrong-private-token"))).toBe(false);
  });

  it("never generates replacement keys when the persisted identity is missing", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    await f.state.storage.delete("mcp_session:agent");
    vi.resetModules();
    const fresh = (await import("../src/mcp-handler")).handleMcpRequest;
    const newSid = await f.initialize(fresh);
    const before = f.requests.length;
    await expect(f.call(newSid, "resume_room", { profile: joined.resume_profile }, fresh)).rejects.toThrow("Cannot resume");
    expect(f.requests.slice(before).some(r => r.method === "PUT" || r.path === "/__save_session")).toBe(false);
  });

  it("rejects a revoked participant token rather than recreating a left identity", async () => {
    const f = await fixture();
    const sid = await f.initialize();
    const joined = await f.call(sid, "join_room", { inviteJson: f.invite, participantId: "agent" });
    await f.room.session.fetch(new Request(`https://j01n.me${f.room.roomPath}/participants/agent`, {
      method: "DELETE", headers: { authorization: "Bearer " + joined.resume_profile.participantToken },
    }));
    const newSid = await f.initialize();
    const before = f.requests.length;
    await expect(f.call(newSid, "resume_room", { profile: joined.resume_profile })).rejects.toThrow("/status failed");
    expect(f.requests.slice(before).some(r => r.method === "PUT")).toBe(false);
  });
});
