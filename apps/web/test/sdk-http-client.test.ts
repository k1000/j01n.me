import { describe, expect, it } from "vitest";
import { createRoom, createRoomAndJoin, joinRoom, resumeRoom, type Invite } from "@j01n/sdk";
import { createSdkCryptoSession } from "@j01n/sdk/crypto-session";
import { sealKickoff } from "@j01n/sdk/crypto";

async function withFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

describe("SDK HTTP client", () => {
  const makeInvite = (): Invite => ({
    intro: "intro",
    next_step: "join",
    room_id: "invite",
    room: { name: "room", purpose: "room purpose", host_id: "host", max_participants: 2 },
    join_secret: "secret",
    room_url: "https://j01n.me/r/invite",
    api: {
      join: "https://j01n.me/r/invite/participants/{participant_id}",
      send: "https://j01n.me/r/invite",
      read: "https://j01n.me/r/invite",
      read_all: "https://j01n.me/r/invite/?view=all",
      events: "https://j01n.me/r/invite/events",
      board: "https://j01n.me/r/invite/board",
      participants: "https://j01n.me/r/invite/participants",
      status: "https://j01n.me/r/invite/status",
      extend: "https://j01n.me/r/invite/extend",
      leave: "https://j01n.me/r/invite/participants/{participant_id}",
      kick: "https://j01n.me/r/invite/participants/{target_id}",
      close: "https://j01n.me/r/invite",
      export: "https://j01n.me/r/invite/export",
    },
    skill: "https://j01n.me/skill/SKILL.md",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("creates rooms with normalized request keys", async () => {
    let requestBody: unknown;
    let requestUrl = "";
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        intro: "intro", next_step: "join", room_id: "invite",
        room: { name: "room", purpose: "room purpose", host_id: "host", max_participants: 2 },
        join_secret: "secret", room_url: "https://j01n.me/r/invite",
        api: {}, skill: "https://j01n.me/skill/SKILL.md",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, () =>
      createRoom("https://j01n.me/", { roomId: "room-1", hostId: "agent-a", roomName: "room", maxParticipants: 3, purpose: "test" }),
    );

    expect(requestUrl).toBe("https://j01n.me/rooms");
    expect(requestBody).toMatchObject({ room_id: "room-1", host_id: "agent-a", room_name: "room", max_participants: 3, purpose: "test" });
  });

  it("forwards inviteTtlMs as invite_ttl_ms in the request body", async () => {
    let requestBody: { invite_ttl_ms?: number } = {};
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        intro: "i", next_step: "j", room_id: "r", room: { name: "n", purpose: "p", host_id: "h", max_participants: 2 },
        join_secret: "s", room_url: "u", api: {}, skill: "k", expires_at: new Date().toISOString(),
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const ttl = 30 * 60_000;
    await withFetch(impl, () => createRoom("https://j01n.me/", { hostId: "h", inviteTtlMs: ttl }));

    expect(requestBody.invite_ttl_ms).toBe(ttl);
  });

  it("createRoomAndJoin creates the room, joins the host, and announces the host key", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), method, body });
      if (String(url).endsWith("/rooms")) {
        return new Response(JSON.stringify({
          intro: "intro", next_step: "join", room_id: "invite",
          room: { name: "room", purpose: "room purpose", host_id: "host-a", max_participants: 2 },
          join_secret: "secret", room_url: "https://j01n.me/r/invite",
          api: {}, skill: "https://j01n.me/skill/SKILL.md",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, cursor: 0 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, () => createRoomAndJoin("https://j01n.me/", { hostId: "host-a", roomName: "room" }));

    expect(requests[0]).toMatchObject({ url: "https://j01n.me/rooms", method: "POST" });
    expect(requests[1]).toMatchObject({ url: "https://j01n.me/r/invite/participants/host-a", method: "PUT" });
    // Key is now announced in the join PUT body, not a separate POST.
    const joinBody = requests[1].body as Record<string, unknown>;
    expect(joinBody.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("joinRoom announces the ECDH key in the join request body", async () => {
    const invite = makeInvite();
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true, cursor: 0 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, () => joinRoom(invite, "agent-a"));

    // Key is now sent in the join PUT body instead of a separate POST.
    expect(requests[0]).toMatchObject({ url: "https://j01n.me/r/invite/participants/agent-a", method: "PUT" });
    const joinBody = requests[0].body as Record<string, unknown>;
    expect(joinBody.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sends falsy JSON bodies", async () => {
    const invite = makeInvite();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, cursor: 0 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, async () => {
      const room = await joinRoom(invite, "agent-a");
      await room.setBoardKey("enabled", false);
    });

    // joinRoom emits PUT (with public_key) and a key.exchange announcement before setBoardKey.
    expect(JSON.parse(String(requests[1].init?.body))).toMatchObject({ intent: "key.exchange" });
    expect(requests[2].url).toBe("https://j01n.me/r/invite/board/enabled");
    expect(requests[2].init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(requests[2].init?.body).toBe("false");
  });

  it("extends room TTL using the participant token", async () => {
    const invite = makeInvite();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const body = String(url).endsWith("/participants/host")
        ? { ok: true, cursor: 0, participant_token: "host-token" }
        : { ok: true, extended_ms: 600000, expires_at: new Date(Date.now() + 600000).toISOString() };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, async () => {
      const room = await joinRoom(invite, "host");
      requests.length = 0;
      await room.extend({ extendMs: 600000 });
    });

    expect(requests[0].url).toBe("https://j01n.me/r/invite/extend");
    expect(requests[0].init?.method).toBe("POST");
    expect(requests[0].init?.headers).toMatchObject({ authorization: "Bearer host-token" });
    expect(requests[0].init?.body).toBe(JSON.stringify({ extend_ms: 600000 }));
  });

  it("sets view=all param when reading retained history", async () => {
    const invite = makeInvite();
    const requests: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ cursor: 0, messages: [] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, async () => {
      const room = await joinRoom(invite, "agent-a");
      requests.length = 0;
      await room.read({ all: true });
      await room.read();
    });

    expect(requests[0]).toBe("https://j01n.me/r/invite/?view=all");
    expect(requests[1]).toBe("https://j01n.me/r/invite");
  });

  it("resumeRoom skips the join PUT but builds a working client", async () => {
    const invite = makeInvite();
    const requests: Array<{ url: string; method: string }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ cursor: 0, messages: [] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await withFetch(impl, async () => {
      const room = await resumeRoom(invite, "agent-a");
      expect(room.participantId).toBe("agent-a");
      expect(room.cursor).toBe(0);
      await room.read();
    });

    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("read decrypts a new message from a peer whose key was announced before this process started", async () => {
    const peer = await createSdkCryptoSession("peer");
    const me = await createSdkCryptoSession("me");
    const peerKey = (await peer.announceKeyBody()).public_key;
    await peer.processPeerKeys([{ id: "me", public_key: (await me.announceKeyBody()).public_key }]);
    const dm = { id: "m", seq: 6, from: "peer", to: "me", intent: "notify", body: await peer.encryptForSend({ text: "only new message" }, "me") };
    const impl = (async (url: string | URL | Request) =>
      String(url).endsWith("/participants")
        ? Response.json({ participants: [{ id: "peer", public_key: peerKey }] })
        : Response.json({ cursor: 6, messages: [dm] })) as unknown as typeof fetch;

    // Resumed in a new process: same keypair, but no peer keys in memory and only the unread message to read.
    const room = await resumeRoom({ ...makeInvite(), participant_token: "tok" }, "me", me);
    const read = await withFetch(impl, () => room.read());

    expect(read[0].body).toEqual({ text: "only new message" });
  });

  it("read opens a sealed kickoff with the invite's join secret", async () => {
    const invite = makeInvite();
    const sealed = await sealKickoff({ goal: "ship" }, invite.join_secret, invite.room_id);
    const impl = (async () => Response.json({ cursor: 1, messages: [{ id: "k", seq: 1, from: "host", to: "all", intent: "kickoff", body: sealed }] })) as unknown as typeof fetch;
    const room = await resumeRoom({ ...invite, participant_token: "tok" }, "me");
    const read = await withFetch(impl, () => room.read());
    expect(read[0].body).toEqual({ goal: "ship" });
  });

  it("openQuestions returns the decrypted questions you owe without reading the room", async () => {
    const peer = await createSdkCryptoSession("peer");
    const me = await createSdkCryptoSession("me");
    const peerKey = (await peer.announceKeyBody()).public_key;
    await peer.processPeerKeys([{ id: "me", public_key: (await me.announceKeyBody()).public_key }]);
    const question = { id: "q1", seq: 5, from: "peer", to: "me", intent: "notify", body: await peer.encryptForSend({ text: "can you review?" }, "me") };
    const urls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).endsWith("/participants")
        ? Response.json({ participants: [{ id: "peer", public_key: peerKey }] })
        : Response.json({ asks: [{ ask_id: "q1", seq: 5, from: "peer", owed_by: "me", due_at: "2026-10-10T01:00:00.000Z", overdue: false, message: question }] });
    }) as unknown as typeof fetch;

    const room = await resumeRoom({ ...makeInvite(), participant_token: "tok" }, "me", me);
    const questions = await withFetch(impl, () => room.openQuestions());

    expect(questions).toEqual([{ id: "q1", seq: 5, from: "peer", body: { text: "can you review?" }, due_at: "2026-10-10T01:00:00.000Z", overdue: false }]);
    expect(urls.some((u) => u.endsWith("/asks"))).toBe(true);
    expect(urls.some((u) => /\/r\/[^/]+\/?(\?|$)/.test(u))).toBe(false);
  });

  it("read keeps messages it cannot decrypt instead of throwing", async () => {
    const peer = await createSdkCryptoSession("peer");
    const oldMe = await createSdkCryptoSession("me");
    await peer.processPeerKeys([{ id: "me", public_key: (await oldMe.announceKeyBody()).public_key }]);
    const forOldKey = await peer.encryptForSend({ text: "for my old key" }, "me");
    const messages = [
      { id: "k", seq: 1, from: "peer", to: "all", intent: "key.exchange", body: await peer.announceKeyBody() },
      { id: "m", seq: 2, from: "peer", to: "me", intent: "notify", body: forOldKey },
    ];
    const impl = (async () => Response.json({ cursor: 2, messages })) as unknown as typeof fetch;

    // Resumed with a fresh keypair, as after losing the original session.
    const room = await resumeRoom({ ...makeInvite(), participant_token: "tok" }, "me", await createSdkCryptoSession("me"));
    const read = await withFetch(impl, () => room.read({ all: true }));

    expect(read[1].body).toEqual(forOldKey);
    expect(read[1].decrypt_error).toContain("no key");
  });
});
