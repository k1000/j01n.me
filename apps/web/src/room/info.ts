import { helpNeeded, openAsks } from "./messages";
import type { InviteState, RoomStateConfig } from "../types";
import { activeParticipants, publicParticipant } from "./participants";

export function roomInfo(invite: InviteState) {
  return {
    room_id: invite.roomId,
    name: invite.roomName,
    // `||` covers pre-purpose rooms whose persisted state lacks the field.
    purpose: invite.purpose || invite.roomName,
    ...(invite.entryMessage ? { first_message: invite.entryMessage } : {}),
    host_id: invite.hostId,
    max_participants: invite.maxParticipants,
  };
}

export function joinResponse(
  invite: InviteState,
  participantId: string,
  cursor: number,
  peers?: Array<{ id: string; public_key: string }>,
) {
  return {
    ok: true,
    room: roomInfo(invite),
    participant_id: participantId,
    display_name: invite.participants[participantId]?.display_name ?? participantId,
    role: invite.participants[participantId]?.role ?? (participantId === invite.hostId ? "host" : undefined),
    is_host: participantId === invite.hostId,
    host_id: invite.hostId,
    cursor,
    peers: peers ?? [],
    next: {
      announce_key: "Send a POST with intent=key.exchange and your ECDH public_key to announce your encryption key.",
      sync: "Call GET room_url (or room.read()) to learn peer keys and fetch messages. The helper/SDK does this for you.",
      send: "Use the encrypted helper or SDK to send E2E encrypted messages (AES-256-GCM).",
    },
    message: `Joined room "${invite.roomName}" as ${participantId}. Host is ${invite.hostId}. Announce your encryption key, sync to learn peer keys, then send encrypted messages.`,
  };
}

/** Return available transitions from the current state, if a state machine is configured. */
export function roomTransitionInfo(stateConfig: RoomStateConfig) {
  return {
    available_events: Object.keys(stateConfig.transitions),
  };
}

export function roomStatus(invite: InviteState) {
  const currentState = invite.roomStates?.[invite.phase];
  return {
    room: roomInfo(invite),
    phase: invite.phase,
    participants: activeParticipants(invite.participants).map((p) => publicParticipant(p)),
    message_count: invite.messages.length,
    last_seq: invite.nextSeq,
    oldest_seq: invite.messages[0]?.seq ?? 0,
    expires_at: new Date(invite.expiresAt).toISOString(),
    open_asks: openAsks(invite),
    help_needed: helpNeeded(invite),
    ...(currentState ? roomTransitionInfo(currentState) : {}),
  };
}

export function roomExport(invite: InviteState) {
  return {
    room: roomInfo(invite),
    phase: invite.phase,
    participants: Object.fromEntries(Object.entries(invite.participants).map(([id, p]) => [id, publicParticipant(p)])),
    messages: invite.messages,
    board: invite.board,
    board_schema: invite.boardSchema ?? null,
    next_seq: invite.nextSeq,
    expires_at: new Date(invite.expiresAt).toISOString(),
  };
}
