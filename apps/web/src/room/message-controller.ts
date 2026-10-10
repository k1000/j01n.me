import { ACTIVE_ROOM_GRACE_MS } from "../constants";
import { json } from "../format";
import type { InviteState, Participant } from "../types";
import { joinedThen } from "./auth-context";
import type { RoomEventBus } from "./events";
import { dispatchWebhooks } from "./hooks";
import { buildReadResponse, createSentMessage, isReadableMessage, parseReadOptions } from "./messages";
import { parseParticipantProfile, publicParticipant, withReadReceipt, withUpdatedParticipant } from "./participants";
import type { RoomStorage } from "./storage";

export class RoomMessageController {
  constructor(
    private readonly storage: RoomStorage,
    private readonly events: RoomEventBus,
  ) {}

  async send(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const result = createSentMessage(auth.body, auth.participantId, invite);
      if (result instanceof Response) return result;

      // Optional: update participant status alongside the message.
      // Fields are top-level (outside the encrypted body) so the server
      // can manage participant metadata without needing decryption keys.
      const profile = parseParticipantProfile(auth.body);
      if (profile instanceof Response) return profile;
      // Record keys announced via key.exchange so /participants exposes them to every client.
      const announcedKey = result.message.intent === "key.exchange" ? (result.message.body as { public_key?: unknown }).public_key : undefined;
      if (typeof announcedKey === "string") profile.public_key = announcedKey.slice(0, 256);
      const hasStatusUpdate =
        typeof announcedKey === "string" ||
        profile.state !== undefined ||
        profile.status !== undefined ||
        profile.model !== undefined ||
        profile.skills !== undefined;

      let updatedInvite = { ...invite, nextSeq: result.seq, messages: result.messages };
      let updatedParticipant: Participant | undefined;
      if (hasStatusUpdate) {
        updatedInvite = withUpdatedParticipant(updatedInvite, auth.participantId, profile);
        updatedParticipant = updatedInvite.participants[auth.participantId];
      }

      // Keep an active room alive: after any message at least ACTIVE_ROOM_GRACE_MS remain before it expires.
      const keepAliveUntil = Date.now() + ACTIVE_ROOM_GRACE_MS;
      if (updatedInvite.expiresAt < keepAliveUntil) updatedInvite = { ...updatedInvite, expiresAt: keepAliveUntil };

      await this.storage.putInvite(updatedInvite);
      if (updatedParticipant) {
        this.events.notifyParticipant(auth.participantId, "updated", updatedParticipant);
        dispatchWebhooks(updatedInvite, "participant", { participant_id: auth.participantId, action: "updated", participant: updatedParticipant });
      }
      this.events.notifyMessage(result.message, result.seq);
      dispatchWebhooks(updatedInvite, "message", { type: "message", message: result.message, last_seq: result.seq });

      const response: Record<string, unknown> = { ok: true, id: result.message.id, seq: result.seq };
      if (updatedParticipant) response.participant = publicParticipant(updatedParticipant);
      return json(response);
    });
  }

  async read(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const readOptions = parseReadOptions(request, auth.body, invite, auth.participantId);
      const messages = invite.messages.filter((msg) =>
        isReadableMessage(msg, auth.participantId, readOptions),
      );
      const updated = withReadReceipt(invite, auth.participantId, invite.nextSeq);
      await this.storage.putInvite(updated);
      return json(buildReadResponse(updated, auth.participantId, messages, readOptions));
    });
  }
}
