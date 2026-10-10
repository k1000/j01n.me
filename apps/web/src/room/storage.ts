import { json } from "../format";
import type { InviteState } from "../types";
import { activeParticipants } from "./participants";
import { nextAskEscalation } from "./messages";

const STATE_KEY = "invite";

export class RoomStorage {
  constructor(private readonly state: DurableObjectState) {}

  getInvite(): Promise<InviteState | undefined> {
    return this.state.storage.get<InviteState>(STATE_KEY);
  }

  async getValidInvite(): Promise<InviteState | Response> {
    const invite = await this.getInvite();
    if (!invite) {
      return json({
        error: "room not found",
        reason: "room does not exist or has been deleted",
        deleted: true,
      }, 404);
    }
    if (invite.phase === "closed") {
      return json({
        error: "room closed",
        reason: "room was closed by the host",
        closed: true,
      }, 410);
    }
    if (Date.now() > invite.expiresAt) {
      await this.state.storage.deleteAll();
      return json({
        error: "room expired",
        reason: "room invite expired and the room was deleted",
        deleted: true,
        expired: true,
        expired_at: new Date(invite.expiresAt).toISOString(),
      }, 410);
    }
    return invite;
  }

  async putInvite(invite: InviteState): Promise<void> {
    await this.state.storage.put(STATE_KEY, invite);
    await this.scheduleCleanup(invite.expiresAt, invite);
  }

  patchAndSave(invite: InviteState, patch: Partial<InviteState>): Promise<void> {
    return this.putInvite({ ...invite, ...patch });
  }

  scheduleCleanup(expiresAt: number, invite?: InviteState): Promise<void> {
    const next = invite && nextAskEscalation(invite);
    return this.state.storage.setAlarm(next ? Math.min(expiresAt, Math.max(Date.now() + 1000, next.at)) : expiresAt);
  }

  async deleteIfEmpty(): Promise<void> {
    const invite = await this.getInvite();
    if (invite && activeParticipants(invite.participants).length === 0) await this.state.storage.deleteAll();
  }
}
