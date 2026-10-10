import { json } from "../format";
import type { InviteState } from "../types";
import { parseRequest, authenticate, joinedThen, participantTokenAuthThen } from "./auth-context";
import { announceSystemMessage } from "./announcement";
import { holdsReservations, withoutReservations } from "./board";
import { dispatchWebhooks } from "./hooks";
import { joinResponse, roomInfo } from "./info";
import { createRoomMessage } from "./messages";
import {
  collectPeerKeys,
  createJoinedParticipant,
  generateParticipantToken,
  isParticipantJoined,
  parseParticipantProfile,
  publicParticipant,
  validateParticipantCanJoin,
  withKickedParticipant,
  withLeftParticipant,
  withTokenIndex,
  withUpdatedParticipant,
} from "./participants";
import { normalizeParticipantId } from "../validation";
import type { RoomEventBus } from "./events";
import type { RoomStorage } from "./storage";

/** The body of a `profile.changed` announcement when capabilities, workspace or model changed, else undefined. */
function profileChangeMessage(before: InviteState, after: InviteState, participantId: string, actorId: string) {
  const old = before.participants[participantId];
  const now = after.participants[participantId];
  const capabilitiesChanged = (old.capabilities ?? []).join() !== (now.capabilities ?? []).join();
  const workspaceChanged = old.workspace !== now.workspace;
  const modelChanged = old.model !== now.model || (old.provider ?? "") !== (now.provider ?? "");
  if (!capabilitiesChanged && !workspaceChanged && !modelChanged) return undefined;
  const running = [now.provider, now.model].filter(Boolean).join("/");
  const text = [
    capabilitiesChanged ? `${participantId} can now: ${(now.capabilities ?? []).join(", ") || "(no capabilities announced)"}` : "",
    workspaceChanged ? (now.workspace ? `${participantId} changed workspace` : `${participantId} stopped announcing its workspace`) : "",
    modelChanged ? (running ? `${participantId} now runs ${running}` : `${participantId} stopped announcing its model`) : "",
  ].filter(Boolean).join("; ");
  return {
    text,
    participant_id: participantId,
    updated_by: actorId,
    ...(capabilitiesChanged ? { capabilities: now.capabilities ?? [] } : {}),
    ...(workspaceChanged ? { workspace: now.workspace ?? null } : {}),
    ...(modelChanged ? { model: now.model ?? null, provider: now.provider ?? null } : {}),
  };
}

export class RoomParticipantController {
  constructor(
    private readonly storage: RoomStorage,
    private readonly events: RoomEventBus,
  ) {}

  async join(request: Request, invite: InviteState, pathParticipantId: string): Promise<Response> {
    const parsed = await parseRequest(request);
    const authResult = await authenticate(invite, parsed);
    if (authResult instanceof Response) return authResult;

    const participantId = normalizeParticipantId(pathParticipantId);
    if (participantId instanceof Response) return participantId;

    const participants = { ...invite.participants };
    const joinValidation = validateParticipantCanJoin(participants, participantId, invite.maxParticipants);
    if (joinValidation) return joinValidation;
    const profile = parseParticipantProfile(parsed.body);
    if (profile instanceof Response) return profile;
    const { token, hash: tokenHash, tokenOnlyHash } = await generateParticipantToken(invite.roomId, participantId);
    if ((profile.role === "owner" || profile.role === "host") && participantId !== invite.hostId) {
      return json({ error: "only the host can assign owner or host roles" }, 403);
    }
    participants[participantId] = createJoinedParticipant(participantId, { ...profile, role: profile.role ?? (participantId === invite.hostId ? "host" : undefined) }, tokenHash);
    // Preserve the room's state-machine phase; only legacy rooms transition "waiting" → "ready" on first join.
    const nextPhase = invite.roomStates ? invite.phase : "ready";
    let updated: InviteState = { ...invite, phase: nextPhase, participants };
    updated = withTokenIndex(updated, tokenOnlyHash, participantId);
    const seq = updated.nextSeq + 1;
    const systemMessage = createRoomMessage(
      {
        body: {
          participant_id: participantId,
          room_id: updated.roomId,
          host_id: updated.hostId,
          public_key: profile.public_key ?? null,
          next: "Announce your encryption key (key.exchange), sync (read) to learn peer keys, then send encrypted messages.",
        },
        intent: "participant.joined",
      },
      "system",
      "all",
      seq,
    );
    const messages = [...updated.messages, systemMessage];
    await this.storage.patchAndSave(updated, { nextSeq: seq, messages });
    this.events.notifyParticipant(participantId, "joined", participants[participantId]);
    this.events.notifyMessage(systemMessage, seq);
    dispatchWebhooks({ ...updated, messages }, "participant", { participant_id: participantId, action: "joined", participant: participants[participantId] });
    dispatchWebhooks({ ...updated, messages }, "message", { type: "message", message: systemMessage, last_seq: seq });
    // A new participant starts with the whole board (same shape as GET /board).
    return json({ ...joinResponse(updated, participantId, invite.nextSeq, collectPeerKeys(participants)), participant_token: token, board: updated.board });
  }

  async update(request: Request, invite: InviteState, participantIdFromPath: string): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      const actorId = auth.participantId;
      const targetId = normalizeParticipantId(participantIdFromPath);
      if (targetId instanceof Response) return targetId;
      if (actorId !== targetId && actorId !== invite.hostId) {
        return json({ error: "only participant or host can update participant status" }, 403);
      }
      if (!isParticipantJoined(invite.participants, targetId)) {
        return json({ error: "participant has not joined" }, 403);
      }
      const profile = parseParticipantProfile(auth.body);
      if (profile instanceof Response) return profile;
      if ((profile.role === "owner" || profile.role === "host") && actorId !== invite.hostId) {
        return json({ error: "only the host can assign owner or host roles" }, 403);
      }
      if (profile.role === "host" && targetId !== invite.hostId) {
        return json({ error: "host role belongs to the current host" }, 400);
      }
      if (profile.role === "owner" && Object.values(invite.participants).some((p) => p.id !== targetId && !p.left_at && p.role === "owner")) {
        return json({ error: "room already has an owner; clear or reassign that role first" }, 409);
      }
      if (invite.participants[targetId].role === "owner" && profile.role !== undefined && profile.role !== "owner" && actorId !== invite.hostId) {
        return json({ error: "only the host can change the owner role" }, 403);
      }
      const updated = withUpdatedParticipant(invite, targetId, profile);
      const announcement = profileChangeMessage(invite, updated, targetId, actorId);
      if (announcement) {
        // Capabilities or workspace changed: tell everyone in the chat (the workspace stays sealed in the message).
        await announceSystemMessage(this.storage, this.events, updated, "profile.changed", announcement);
      } else {
        await this.storage.putInvite(updated);
      }
      this.events.notifyParticipant(targetId, "updated", updated.participants[targetId]);
      dispatchWebhooks(updated, "participant", { participant_id: targetId, action: "updated", participant: updated.participants[targetId] });
      return json({ ok: true, participant: publicParticipant(updated.participants[targetId]) });
    });
  }

  async delete(request: Request, invite: InviteState, targetIdFromPath: string): Promise<Response> {
    return participantTokenAuthThen(invite, request, async (auth) => {
      const actorId = auth.participantId;
      const targetId = normalizeParticipantId(targetIdFromPath);
      if (targetId instanceof Response) return targetId;
      if (actorId === targetId) return this.leave(invite, targetId, new URL(request.url).searchParams.get("release") === "true");
      return this.kick(invite, actorId, targetId);
    });
  }

  /** Hand the host role to another participant in the room. Everyone is told with a `host.changed` system message. */
  async transferHost(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      if (auth.participantId !== invite.hostId) return json({ error: "only the host can transfer the host role" }, 403);
      const to = normalizeParticipantId(auth.body.to);
      if (to instanceof Response) return to;
      if (to === invite.hostId) return json({ error: `${to} is already the host` }, 400);
      if (!isParticipantJoined(invite.participants, to)) return json({ error: `${to} is not in the room` }, 404);
      const participants = { ...invite.participants };
      if (participants[invite.hostId]?.role === "host") participants[invite.hostId] = { ...participants[invite.hostId], role: undefined };
      participants[to] = { ...participants[to], role: participants[to].role === "owner" ? "owner" : "host" };
      await announceSystemMessage(this.storage, this.events, invite, "host.changed",
        { text: `${invite.hostId} made ${to} the host`, host_id: to, updated_by: invite.hostId }, { hostId: to, participants });
      return json({ ok: true, host_id: to });
    });
  }

  private async leave(invite: InviteState, participantId: string, release: boolean): Promise<Response> {
    // The room must keep a host who can close, extend and kick: hand the role over before leaving others behind.
    const others = Object.keys(invite.participants).filter((id) => id !== participantId && isParticipantJoined(invite.participants, id));
    if (participantId === invite.hostId && others.length > 0) {
      return json({ error: "the host cannot leave while others are in the room: transfer the host role first (POST /r/:id/host {\"to\": \"<participant>\"})" }, 409);
    }
    // Reserved files must not stay locked by someone who left: release them explicitly, or leave with ?release=true.
    if (holdsReservations(invite, participantId)) {
      if (!release) return json({ error: "you still hold file reservations: release them first, or leave with ?release=true (CLI/Pi: leave --release)" }, 409);
      invite = await this.releaseReservations(invite, participantId, participantId, `${participantId} released its reservations and left`);
    }
    const updated = withLeftParticipant(invite, participantId);
    await this.storage.putInvite(updated);
    this.events.notifyParticipant(participantId, "left", updated.participants[participantId]);
    dispatchWebhooks(updated, "participant", { participant_id: participantId, action: "left", participant: updated.participants[participantId] });
    await this.storage.deleteIfEmpty();
    return json({ ok: true });
  }

  /** Drop a participant's file reservations from the board and announce it like any board change. */
  private async releaseReservations(invite: InviteState, participantId: string, actorId: string, text: string): Promise<InviteState> {
    const { board, changes } = withoutReservations(invite, participantId, actorId);
    return announceSystemMessage(this.storage, this.events, invite, "board.changed",
      { text, updated_by: actorId, changes }, { board }, { changes, updatedBy: actorId });
  }

  private async kick(invite: InviteState, actorId: string, targetId: string): Promise<Response> {
    if (actorId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    if (holdsReservations(invite, targetId) && invite.participants[targetId] && !invite.participants[targetId].left_at) {
      invite = await this.releaseReservations(invite, targetId, actorId, `${targetId}'s reservations were released (removed by ${actorId})`);
    }
    const updated = withKickedParticipant(invite, targetId);
    if (updated instanceof Response) return updated;
    await this.storage.putInvite(updated);
    this.events.notifyParticipant(targetId, "kicked", updated.participants[targetId]);
    dispatchWebhooks(updated, "participant", { participant_id: targetId, action: "kicked", participant: updated.participants[targetId] });
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }
}
