import { json, respondNegotiated, detectFormat } from "./format";
import { inviteInstructionsMarkdown, inviteInstructionsPage } from "./html";
import { DEFAULT_EXTEND_MS, MAX_INVITE_TTL_MS, MIN_INVITE_TTL_MS } from "./constants";
import { tokenAuthThen, participantTokenAuthThen, requireJoined } from "./room/auth-context";
import { RoomBoardController } from "./room/board-controller";
import { RoomEvents } from "./room/events";
import type { RoomEventBus } from "./room/events";
import { roomExport, roomInfo, roomStatus, roomTransitionInfo } from "./room/info";
import { RoomInitController } from "./room/init-controller";
import { RoomMessageController } from "./room/message-controller";
import { activeParticipants, publicParticipant } from "./room/participants";
import { RoomParticipantController } from "./room/participant-controller";
import { createHook, deleteHook } from "./room/hooks";
import { routeRoomRequest } from "./room/router";
import { RoomStorage } from "./room/storage";
import type { Env, InviteState } from "./types";

export class RendezvousSession implements DurableObject {
  private readonly events: RoomEventBus = new RoomEvents();
  private readonly storage: RoomStorage;
  private readonly board: RoomBoardController;
  private readonly participants: RoomParticipantController;
  private readonly messages: RoomMessageController;
  private readonly init: RoomInitController;
  private readonly ctx: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.ctx = state;
    this.storage = new RoomStorage(state);
    this.board = new RoomBoardController(this.storage, this.events);
    this.participants = new RoomParticipantController(this.storage, this.events);
    this.messages = new RoomMessageController(this.storage, this.events);
    this.init = new RoomInitController(this.storage);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      return this.init.init(request);
    }
    if (request.method === "POST" && url.pathname === "/__cleanup") {
      return this.cleanupStaleRoom();
    }
    if (request.method === "POST" && url.pathname === "/__save_session") {
      return this.handleSaveSession(request);
    }
    if (request.method === "GET" && url.pathname === "/__load_session") {
      return this.handleLoadSession();
    }

    const invite = await this.storage.getValidInvite();
    if (invite instanceof Response) return invite;

    const routed = this.routeRequest(request, url, invite);
    if (routed) return routed;

    if (request.headers.get("Upgrade") === "websocket") {
      return new Response("WebSocket transport has been removed. Use the collab space.", { status: 410 });
    }

    const roomUrl = url.origin + url.pathname;
    const secretFromUrl = url.searchParams.get("s") ?? undefined;
    const roomInfo = {
      name: invite.roomName,
      purpose: invite.purpose,
      ...(invite.entryMessage ? { first_message: invite.entryMessage } : {}),
      host_id: invite.hostId,
      participant_count: activeParticipants(invite.participants).length,
      expires_at: new Date(invite.expiresAt).toISOString(),
    };

    // Agents that send Accept: application/json get structured JSON with context.
    const fmt = detectFormat(request);
    if (fmt === "json") {
      return json({
        service: "j01n.me — free ephemeral encrypted coordination for AI agents",
        service_url: "https://j01n.me",
        source_url: "https://github.com/k1000/j01n.me",
        security_url: "https://j01n.me/security",
        room: roomInfo,
        access_url: roomUrl,
        join_secret: secretFromUrl ?? "<provided by host>",
        how_to_join: `mkdir -p .j01n && curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js && node .j01n/j01n.js join ${roomUrl} '<join_secret>' '<your_name>'`,
        help_urls: {
          claude_code: "https://j01n.me/client/CLAUDE_CODE.md",
          cli: "https://j01n.me/client/CLI.md",
          mcp: "https://j01n.me/client/MCP.md",
          sdk: "https://j01n.me/client/SDK.md",
          skill: "https://j01n.me/skill/SKILL.md",
        },
      });
    }

    return respondNegotiated(
      request,
      () => inviteInstructionsPage(roomUrl, secretFromUrl, roomInfo),
      () => inviteInstructionsMarkdown(roomUrl, secretFromUrl, roomInfo),
    );
  }

  async alarm(): Promise<void> {
    await this.cleanupStaleRoom();
  }

  private async cleanupStaleRoom(): Promise<Response> {
    const invite = await this.storage.getInvite();
    if (!invite) return json({ ok: true, deleted: true, reason: "missing" });
    if (Date.now() > invite.expiresAt || invite.phase === "closed" || activeParticipants(invite.participants).length === 0) {
      await this.ctx.storage.deleteAll();
      return json({ ok: true, deleted: true });
    }
    return json({ ok: true, deleted: false });
  }

  private routeRequest(
    request: Request,
    url: URL,
    invite: InviteState,
  ): Promise<Response> | undefined {
    return routeRoomRequest(request, url, invite, {
      read: () => this.messages.read(request, invite),
      send: () => this.messages.send(request, invite),
      close: () => this.handleClose(request, invite),
      export: () => this.handleExport(request, invite),
      getBoard: () => this.board.get(request, invite),
      patchBoard: () => this.board.patch(request, invite),
      deleteBoardKeys: () => this.board.deleteKeys(request, invite),
      getBoardKey: (key) => this.board.getKey(request, invite, key),
      setBoardKey: (key) => this.board.setKey(request, invite, key),
      deleteBoardKey: (key) => this.board.deleteKey(request, invite, key),
      join: (participantId) =>
        this.participants.join(request, invite, participantId),
      updateParticipant: (participantId) =>
        this.participants.update(request, invite, participantId),
      deleteParticipant: (participantId) =>
        this.participants.delete(request, invite, participantId),
      participants: () => this.handleParticipants(request, invite),
      status: () => this.handleStatus(request, invite),
      events: () => this.handleEvents(request, invite),
      extend: () => this.handleExtendTtl(request, invite),
      transition: () => this.handleTransition(request, invite),
      hooks: () => this.handleListHooks(invite),
      createHook: () => this.handleCreateHook(request, invite),
      deleteHook: (hookId) => this.handleDeleteHookById(request, invite, hookId),
    });
  }

  private handleListHooks(invite: InviteState): Promise<Response> {
    return Promise.resolve(json({ hooks: invite.hooks ?? [], room_id: invite.roomId }));
  }

  private async handleCreateHook(request: Request, invite: InviteState): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can manage webhooks" }, 403);
      const body = auth.body as { url?: string; events?: ("message" | "board" | "participant")[] };
      const url = body.url;
      if (!url || typeof url !== "string") return json({ error: "url is required" }, 400);
      let parsedUrl: URL;
      try { parsedUrl = new URL(url); } catch { return json({ error: "invalid url" }, 400); }
      if (parsedUrl.protocol !== "https:") return json({ error: "webhook url must use https" }, 400);
      const result = createHook(invite, url, body.events);
      await this.storage.patchAndSave(invite, { hooks: result.hooks });
      return json({ ok: true, hook: result.hook });
    });
  }

  private async handleDeleteHookById(request: Request, invite: InviteState, hookId: string): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can manage webhooks" }, 403);
      const result = deleteHook(invite, hookId);
      if (!result) return json({ error: "hook not found" }, 404);
      await this.storage.patchAndSave(invite, { hooks: result.hooks });
      return json({ ok: true, deleted: hookId });
    });
  }

  /**
   * Store MCP ECDH session data (JWK keypair + participant token) in DO storage
   * so it survives Worker isolate recycles.
   */
  private async handleSaveSession(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { participantId: string; privateJwk: unknown; publicJwk: unknown; token?: string };
      if (!body.participantId || !body.privateJwk || !body.publicJwk) {
        return json({ error: "participantId, privateJwk, publicJwk required" }, 400);
      }
      const key = `mcp_session:${body.participantId}`;
      await this.ctx.storage.put(key, {
        privateJwk: body.privateJwk,
        publicJwk: body.publicJwk,
        token: body.token,
        saved_at: Date.now(),
      });
      return json({ ok: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  /** Load MCP ECDH session data from DO storage. */
  private async handleLoadSession(): Promise<Response> {
    const sessions: Record<string, { privateJwk: unknown; publicJwk: unknown; token?: string }> = {};
    const list = await this.ctx.storage.list({ prefix: "mcp_session:" });
    for (const [key, value] of list) {
      sessions[key.slice("mcp_session:".length)] = value as { privateJwk: unknown; publicJwk: unknown; token?: string };
    }
    return json({ sessions });
  }

  private handleExtendTtl(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can extend TTL" }, 403);

      const rawExtend = auth.body.extend_ms as number | undefined;
      const requested = typeof rawExtend === "number" && Number.isFinite(rawExtend)
        ? Math.trunc(rawExtend)
        : DEFAULT_EXTEND_MS;
      const maxExtend = Date.now() + MAX_INVITE_TTL_MS - invite.expiresAt;
      const extendMs = Math.min(Math.max(requested, MIN_INVITE_TTL_MS), Math.max(maxExtend, MIN_INVITE_TTL_MS));

      const newExpiresAt = invite.expiresAt + extendMs;
      await this.storage.patchAndSave(invite, { expiresAt: newExpiresAt });
      await this.storage.scheduleCleanup(newExpiresAt);
      return json({
        ok: true,
        extended_ms: extendMs,
        expires_at: new Date(newExpiresAt).toISOString(),
      });
    });
  }

  private handleEvents(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      const isHost = auth.participantId === invite.hostId;
      if (!isHost) {
        const joined = await requireJoined(invite, auth);
        if (joined instanceof Response) return joined;
      }
      const includeSelf = new URL(request.url).searchParams.get("include_self") === "true";
      return this.events.subscribe(auth.participantId, includeSelf, invite.nextSeq, isHost);
    });
  }

  private handleTransition(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      const states = invite.roomStates;
      if (!states || Object.keys(states).length === 0) {
        return json({ error: "room has no state machine configured" }, 400);
      }
      if (auth.participantId !== invite.hostId) {
        return json({ error: "only host can transition room state" }, 403);
      }

      const event = auth.body.event as string | undefined;
      if (!event) return json({ error: "'event' field is required" }, 400);

      const currentState = states[invite.phase];
      if (!currentState) {
        return json({ error: `current state "${invite.phase}" is not a known state` }, 400);
      }

      const to = currentState.transitions[event];
      if (!to) {
        const available = Object.keys(currentState.transitions);
        return json({
          error: `no transition "${event}" from "${invite.phase}"`,
          available_events: available,
        }, 400);
      }

      const nextState = states[to];
      if (!nextState) {
        return json({ error: `target state "${to}" not found in room configuration` }, 400);
      }

      // Record the transition as a system message.
      const seq = invite.nextSeq + 1;
      const transitionMessage = {
        id: crypto.randomUUID(),
        seq,
        from: auth.participantId,
        to: "all" as const,
        reply_to: null as string | null,
        intent: "room.transitioned" as const,
        priority: "normal" as const,
        body: { from: invite.phase, event, to },
        created_at: new Date().toISOString(),
      } satisfies import("./types").RoomMessage;
      const messages = [...invite.messages, transitionMessage].slice(-200);

      await this.storage.patchAndSave(invite, { phase: to, nextSeq: seq, messages });
      this.events.notifyMessage(transitionMessage, seq);

      return json({ ok: true, from: invite.phase, event, to, ...roomTransitionInfo(nextState) });
    });
  }

  private handleParticipants(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return tokenAuthThen(invite, request, async () => {
      return json({
        room: roomInfo(invite),
        participants: activeParticipants(invite.participants).map((p) => publicParticipant(p)),
      });
    });
  }

  private handleStatus(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return tokenAuthThen(invite, request, async () => {
      return json({
        ...roomStatus(invite),
        closed: invite.phase === "closed",
      });
    });
  }

  private handleClose(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can close room" }, 403);
      await this.storage.patchAndSave(invite, { phase: "closed" });
      return json({ ok: true, closed: true });
    });
  }

  private handleExport(
    request: Request,
    invite: InviteState,
  ): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only host can export room" }, 403);
      return json(roomExport(invite));
    });
  }
}
