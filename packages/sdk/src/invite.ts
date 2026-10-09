import type { Invite } from "./room-client";

export type RoomAccess = Partial<Invite> & {
  access?: string;
  follow?: string;
  join_secret?: string;
};

function buildApiLinks(roomUrl: string): Invite["api"] {
  return {
    join: `${roomUrl}/participants/{participant_id}`,
    send: roomUrl,
    read: roomUrl,
    read_all: `${roomUrl}/?view=all`,
    events: `${roomUrl}/events`,
    board: `${roomUrl}/board`,
    participants: `${roomUrl}/participants`,
    status: `${roomUrl}/status`,
    extend: `${roomUrl}/extend`,
    export: `${roomUrl}/export`,
    leave: `${roomUrl}/participants/{participant_id}`,
    kick: `${roomUrl}/participants/{target_id}`,
    close: roomUrl,
  };
}

export function buildMinimalInvite(roomUrlRaw: string, joinSecret: string): Invite {
  const roomUrl = roomUrlRaw.replace(/\/$/, "");
  const roomId = roomUrl.split("/").pop() ?? "";
  const origin = new URL(roomUrl).origin;
  return {
    intro: "",
    next_step: "",
    room_id: roomId,
    room: { name: "", purpose: "", host_id: "", max_participants: 16 },
    join_secret: joinSecret,
    room_url: roomUrl,
    api: buildApiLinks(roomUrl),
    skill: `${origin}/skill/SKILL.md`,
    expires_at: "",
  };
}

/** The one-line room link: https://<host>/room/<id>#<join_secret>. */
export function inviteLink(roomUrl: string, joinSecret: string): string {
  return `${roomUrl.replace(/\/$/, "").replace(/\/r\/([^/]+)$/, "/room/$1")}#${joinSecret}`;
}

/** Parse a room link (see inviteLink) into a minimal invitation, or undefined if the text is not one. */
export function parseInviteLink(text: string): RoomAccess | undefined {
  const match = /^(https?:\/\/[^/\s]+)\/room\/([^/#?\s]+)#(\S+)$/.exec(text.trim());
  return match ? { access: `${match[1]}/r/${match[2]}`, join_secret: match[3] } : undefined;
}

export function normalizeInvite(invite: RoomAccess): Invite {
  const roomUrl = invite.room_url ?? invite.access ?? invite.follow;
  if (!roomUrl || !invite.join_secret) throw new Error("invite must include access (or room_url) and join_secret");
  const base = invite.room_id && invite.api
    ? { ...invite, room_url: roomUrl, join_secret: invite.join_secret } as Invite
    : buildMinimalInvite(roomUrl, invite.join_secret);
  return {
    ...base,
    ...(invite.suggested_id ? { suggested_id: invite.suggested_id } : {}),
    ...(invite.suggested_model ? { suggested_model: invite.suggested_model } : {}),
    ...(invite.suggested_skills ? { suggested_skills: invite.suggested_skills } : {}),
    ...(invite.participant_token ? { participant_token: invite.participant_token } : {}),
    ...(invite.host_joined ? { host_joined: true } : {}),
    ...(typeof invite.cursor === "number" ? { cursor: invite.cursor } : {}),
  };
}
