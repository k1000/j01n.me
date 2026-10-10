export { RoomApiError } from "./errors";
export { buildMinimalInvite, inviteLink, normalizeInvite, parseInviteLink } from "./invite";
export { getClientUpdateNotice, SDK_CLIENT_PROTOCOL } from "./transport";
export { deleteInvite, inviteAgent, registerAgent, setAcceptFrom, waitForInvites } from "./agents";
export { openWorkspace, sealWorkspace } from "./crypto";
export { listReservations, pathsOverlap, releasePaths, reservationFor, reservePaths, RESERVATIONS_KEY } from "./reservations";
export type { Reservation } from "./reservations";
export type { Workspace } from "./crypto";
export type { AgentIdentity, ReceivedInvite } from "./agents";
export { buildRoomClient } from "./room-client";

import { normalizeInvite, type RoomAccess } from "./invite";
import { buildRoomClient } from "./room-client";
import { createSdkCryptoSession } from "./sdk-crypto-session";
import type { SdkCryptoSession } from "./sdk-crypto-session";
import type { Invite, RoomClient, CreateRoomOptions } from "./room-client";
import { request } from "./transport";
import { sealWorkspace, type Workspace } from "./crypto";

export type { Invite, RoomClient, CreateRoomOptions, RoomAccess };

export async function createRoom(
  baseUrl = "https://j01n.me",
  options: CreateRoomOptions,
): Promise<Invite> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      template: options.template,
      room_id: options.roomId,
      host_id: options.hostId,
      host_public_key: options.hostPublicKey,
      host_model: options.hostModel,
      room_name: options.roomName,
      max_participants: options.maxParticipants,
      invite_ttl_ms: options.inviteTtlMs,
      purpose: options.purpose,
      first_message: options.firstMessage,
      board_schema: options.boardSchema,
      board_acls: options.boardAcls,
      board: options.board,
      suggested_id: options.suggestedId,
      suggested_model: options.suggestedModel,
      suggested_skills: options.suggestedSkills,
    }),
  });
  if (!response.ok) throw new Error(`failed to create room: ${response.status}`);
  return normalizeInvite(await response.json() as RoomAccess);
}

export async function createRoomAndJoin(
  baseUrl = "https://j01n.me",
  options: CreateRoomOptions,
): Promise<RoomClient> {
  // Generate ECDH keypair so the host can auto-join during room creation.
  const hostId = options.hostId ?? "agent";
  const cryptoSession = await createSdkCryptoSession(hostId);
  const publicKeyBody = await cryptoSession.announceKeyBody();

  const invite = await createRoom(baseUrl, {
    ...options,
    hostId,
    hostPublicKey: publicKeyBody.public_key,
    hostModel: options.hostModel,
  });

  // If the host was auto-joined, build a RoomClient directly.
  if (invite.host_joined && typeof invite.cursor === "number") {
    return buildRoomClient(invite, hostId, invite.cursor, cryptoSession);
  }

  // Fallback: join after creation (backward compat).
  return joinRoom(invite, hostId);
}

export async function joinRoom(
  inviteInput: RoomAccess,
  participantId: string,
  opts: { model?: string; provider?: string; skills?: string[]; webhook_url?: string; capabilities?: string[]; workspace?: Workspace } = {},
  existingSession?: SdkCryptoSession,
): Promise<RoomClient> {
  const invite = normalizeInvite(inviteInput);
  const { workspace, ...profile } = opts;

  // Generate (or reuse a saved) ECDH keypair and cache self-key before joining.
  const cryptoSession = existingSession ?? await createSdkCryptoSession(participantId);
  const publicKeyBody = await cryptoSession.announceKeyBody();

  interface JoinResponse {
    ok: boolean;
    cursor: number;
    participant_token?: string;
    peers?: Array<{ id: string; public_key: string }>;
  }
  const join = await request<JoinResponse>(
    `${invite.room_url}/participants/${encodeURIComponent(participantId)}`,
    invite,
    {
      method: "PUT",
      body: {
        ...profile,
        public_key: publicKeyBody.public_key,
        // Sealed with the room key: the server only stores ciphertext.
        ...(workspace ? { workspace: await sealWorkspace(workspace, invite.join_secret, invite.room_id) } : {}),
      },
    },
  );

  // Process peer keys from join response.
  if (join.peers && join.peers.length > 0) {
    await cryptoSession.processPeerKeys(join.peers);
  }

  const roomInvite = { ...invite, participant_token: join.participant_token };
  const room = await buildRoomClient(roomInvite, participantId, join.cursor, cryptoSession);
  // Announce via key.exchange too: peers learn keys from these messages.
  await room.announceKey();
  return room;
}

export async function resumeRoom(
  invite: RoomAccess,
  participantId: string,
  cryptoSession?: SdkCryptoSession,
): Promise<RoomClient> {
  return buildRoomClient(normalizeInvite(invite), participantId, 0, cryptoSession);
}
