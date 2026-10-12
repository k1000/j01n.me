import { ACTIVE_ROOM_GRACE_MS } from "../constants";
import { json } from "../format";
import type { InviteState } from "../types";
import { activeParticipants } from "./participants";
import { nextAskEscalation } from "./messages";

const STATE_KEY = "invite";

/**
 * Absolute ceiling on activity-based keepalive: a room never lives longer than this from its first room write.
 * Activity moves the sliding window, it never removes the hard stop.
 */
export const ROOM_ACTIVITY_HARD_CAP_MS = 12 * 60 * 60_000;

/**
 * The one sliding-window keepalive every state-changing room write shares: after any activity at least
 * ACTIVE_ROOM_GRACE_MS remain, never past the hard cap anchored on the first activity write
 * (`activityCapAt`, recorded lazily so rooms nobody touches still expire on their own TTL).
 *
 * Only ever raises `expiresAt` — an expiry further ahead (a host `/extend`, a long TTL) stays authoritative.
 * Callers do not invoke this per route: `putInvite()` applies it, so board, participant, ask, message and
 * system-announcement writes cannot be forgotten. Room creation opts out (see RoomInitController).
 */
export function touchRoomActivity(invite: InviteState, now = Date.now()): InviteState {
  const activityCapAt = invite.activityCapAt ?? now + ROOM_ACTIVITY_HARD_CAP_MS;
  const keepAliveUntil = Math.min(now + ACTIVE_ROOM_GRACE_MS, activityCapAt);
  if (invite.expiresAt >= keepAliveUntil) {
    return invite.activityCapAt === activityCapAt ? invite : { ...invite, activityCapAt };
  }
  return { ...invite, activityCapAt, expiresAt: keepAliveUntil };
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

  /** Persist room state. Every room write goes here, so this is where the activity window is applied. */
  async putInvite(invite: InviteState, options: { activity?: boolean } = {}): Promise<void> {
    const touched = options.activity === false ? invite : touchRoomActivity(invite);
    await this.state.storage.put(STATE_KEY, touched);
    await this.scheduleCleanup(touched.expiresAt, touched);
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
