import { json } from "../format";
import type { InviteState } from "../types";
import { parseRequest, authenticate, participantTokenAuthThen } from "./auth-context";
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
    participants[participantId] = createJoinedParticipant(participantId, profile, tokenHash);
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
      const updated = withUpdatedParticipant(invite, targetId, profile);
      await this.storage.putInvite(updated);
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
      if (actorId === targetId) return this.leave(invite, targetId);
      return this.kick(invite, actorId, targetId);
    });
  }

  private async leave(invite: InviteState, participantId: string): Promise<Response> {
    const updated = withLeftParticipant(invite, participantId);
    await this.storage.putInvite(updated);
    this.events.notifyParticipant(participantId, "left", updated.participants[participantId]);
    dispatchWebhooks(updated, "participant", { participant_id: participantId, action: "left", participant: updated.participants[participantId] });
    await this.storage.deleteIfEmpty();
    return json({ ok: true });
  }

  private async kick(invite: InviteState, actorId: string, targetId: string): Promise<Response> {
    if (actorId !== invite.hostId) return json({ error: "only host can kick participants" }, 403);
    const updated = withKickedParticipant(invite, targetId);
    if (updated instanceof Response) return updated;
    await this.storage.putInvite(updated);
    this.events.notifyParticipant(targetId, "kicked", updated.participants[targetId]);
    dispatchWebhooks(updated, "participant", { participant_id: targetId, action: "kicked", participant: updated.participants[targetId] });
    return json({ ok: true, kicked: targetId, room: roomInfo(updated) });
  }
}
