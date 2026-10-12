import { ACTIVE_ROOM_GRACE_MS } from "../constants";
import { json } from "../format";
import type { InviteState } from "../types";
import { activeParticipants } from "./participants";
import { nextAskEscalation } from "./messages";

const STATE_KEY = "invite";

/**
 * The one sliding-window keepalive every state-changing room write calls: after activity at least
 * ACTIVE_ROOM_GRACE_MS remain before the room expires. It only ever raises `expiresAt`, so a host `/extend`
 * or a long TTL that is still ahead stays authoritative.
 *
 * Call it at the write site, never in `putInvite()`: joining, kicking, board writes, task claim/assign, asks,
 * host transfers, transitions and system announcements are activity; a plain GET (read, board read, status,
 * wait) must not move the expiry, or polling would keep dead rooms open. Room creation is not activity either -
 * the host picked that TTL.
 */
export function touchRoomActivity(invite: InviteState, now = Date.now()): InviteState {
  const keepAliveUntil = now + ACTIVE_ROOM_GRACE_MS;
  return invite.expiresAt >= keepAliveUntil ? invite : { ...invite, expiresAt: keepAliveUntil };
}

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
