import { json, type GuardResult } from "../format";
import type { InviteState, Participant } from "../types";
import { normalizeState, normalizeStatus, normalizeModel, normalizeProvider, normalizeSkills, normalizeCapabilities } from "../validation";
import { hashJoinSecret, randomBase64Url } from "@j01n/sdk/crypto";

/** Participant as shown to others: drops the token verifier hash and the private webhook URL. */
export function publicParticipant(participant: Participant): Omit<Participant, "tokenHash" | "webhook_url">;
export function publicParticipant(participant: Participant | undefined): Omit<Participant, "tokenHash" | "webhook_url"> | undefined;
export function publicParticipant(participant: Participant | undefined) {
  if (!participant) return participant;
  const { tokenHash: _tokenHash, webhook_url: _webhookUrl, ...rest } = participant;
  return rest;
}

interface ParticipantProfile {
  state?: "free" | "busy";
  status?: string;
  model?: string;
  provider?: string;
  skills?: string[];
  capabilities?: string[];
  /** Sealed workspace; null clears it. */
  workspace?: string | null;
  public_key?: string;
  display_name?: string | null;
  role?: string | null;
  /** Opaque room-keyed checkout identity; never a path or URL. */
  checkout?: string | null;
  /** null clears the webhook. */
  webhook_url?: string | null;
}

export function validateParticipantCanJoin(participants: Record<string, Participant>, participantId: string, maxParticipants: number): GuardResult {
  if (participants[participantId] && !participants[participantId].left_at) {
    return json({ error: "participant_id already joined" }, 409);
  }
  if (!participants[participantId] && activeParticipants(participants).length >= maxParticipants) {
    return json({ error: "room is full", max_participants: maxParticipants }, 409);
  }
  return undefined;
}

export function activeParticipants(participants: Record<string, Participant>): Participant[] {
  return Object.values(participants).filter((p) => !p.left_at);
}

/** Collect public key info for all active participants with announced keys. */
export function collectPeerKeys(participants: Record<string, Participant>): Array<{ id: string; public_key: string }> {
  return Object.values(participants)
    .filter((p): p is Participant & { public_key: string } => !p.left_at && !!p.public_key)
    .map((p) => ({ id: p.id, public_key: p.public_key }));
}

export function isParticipantJoined(participants: Record<string, Participant>, participantId: string): boolean {
  const participant = participants[participantId];
  return !!participant && !participant.left_at;
}

export function parseParticipantProfile(body: Record<string, unknown>): ParticipantProfile | Response {
  const state = normalizeState(body.state);
  if (state instanceof Response) return state;
  const status = normalizeStatus(body.status);
  if (status instanceof Response) return status;
  const model = normalizeModel(body.model);
  if (model instanceof Response) return model;
  const provider = normalizeProvider(body.provider);
  if (provider instanceof Response) return provider;
  const skills = normalizeSkills(body.skills);
  if (skills instanceof Response) return skills;
  const capabilities = normalizeCapabilities(body.capabilities);
  if (capabilities instanceof Response) return capabilities;
  const workspace = normalizeWorkspace(body.workspace);
  if (workspace instanceof Response) return workspace;
  const public_key = typeof body.public_key === "string" ? body.public_key.slice(0, 256) : undefined;
  const display_name = normalizeLabel(body.display_name, "display_name", 64);
  if (display_name instanceof Response) return display_name;
  const role = normalizeLabel(body.role, "role", 64);
  if (role instanceof Response) return role;
  const checkout = body.checkout === undefined ? undefined : body.checkout === null ? null : body.checkout;
  if (checkout !== undefined && checkout !== null && (typeof checkout !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(checkout))) {
    return json({ error: "checkout must be a room-keyed HMAC-SHA256 base64url digest" }, 400);
  }
  const webhook_url = normalizeWebhookUrl(body.webhook_url);
  if (webhook_url instanceof Response) return webhook_url;
  return { state, status, model, provider, skills, capabilities, workspace, public_key, display_name, role, checkout, webhook_url };
}

function normalizeLabel(value: unknown, field: string, max: number): string | null | undefined | Response {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    return json({ error: `${field} must be a nonempty string of at most ${max} characters, or null to clear` }, 400);
  }
  return value.trim();
}

/** The workspace must arrive sealed with the room key, so the server never stores a plaintext path or repo. */
function normalizeWorkspace(value: unknown): string | null | undefined | Response {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.startsWith("jsk1:") || value.length > 4096) {
    return json({ error: "workspace must be sealed with the room key (jsk1:...); clients do this for you" }, 400);
  }
  return value;
}

function normalizeWebhookUrl(value: unknown): string | null | undefined | Response {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) return json({ error: "webhook_url must be an https URL" }, 400);
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch { /* invalid URL */ }
  return json({ error: "webhook_url must be an https URL" }, 400);
}

export function createJoinedParticipant(participantId: string, profile: ParticipantProfile, tokenHash?: string): Participant {
  const now = new Date().toISOString();
  return {
    id: participantId,
    joined_at: now,
    last_seen_at: now,
    last_read_seq: 0,
    state: "free",
    status: "joined",
    status_updated_at: now,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.provider ? { provider: profile.provider } : {}),
    ...(profile.skills ? { skills: profile.skills } : {}),
    ...(profile.capabilities ? { capabilities: profile.capabilities } : {}),
    ...(profile.workspace ? { workspace: profile.workspace } : {}),
    ...(profile.display_name ? { display_name: profile.display_name } : {}),
    ...(profile.role ? { role: profile.role } : {}),
    ...(profile.checkout ? { checkout: profile.checkout } : {}),
    ...(profile.public_key ? { public_key: profile.public_key } : {}),
    ...(profile.webhook_url ? { webhook_url: profile.webhook_url } : {}),
    ...(tokenHash ? { tokenHash } : {}),
  };
}

/** Generate a per-participant token and return { token, hash, tokenOnlyHash }. */
export async function generateParticipantToken(roomId: string, participantId: string): Promise<{ token: string; hash: string; tokenOnlyHash: string }> {
  const token = randomBase64Url(32);
  const hash = await hashJoinSecret(roomId + "." + participantId, token);
  const tokenOnlyHash = await hashJoinSecret(roomId, token); // for O(1) index lookup
  return { token, hash, tokenOnlyHash };
}

/** Update the tokenIndex when a participant joins with a tokenHash. */
export function withTokenIndex(invite: InviteState, tokenOnlyHash: string | undefined, participantId: string): InviteState {
  if (!tokenOnlyHash) return invite;
  return { ...invite, tokenIndex: { ...(invite.tokenIndex ?? {}), [tokenOnlyHash]: participantId } };
}

function updateParticipantProfile(participant: Participant, profile: ParticipantProfile): Participant {
  const now = new Date().toISOString();
  const { webhook_url: currentWebhookUrl, workspace: currentWorkspace, display_name: currentName, role: currentRole, checkout: currentCheckout, ...rest } = participant;
  const webhook_url = profile.webhook_url === undefined ? currentWebhookUrl : profile.webhook_url ?? undefined;
  const workspace = profile.workspace === undefined ? currentWorkspace : profile.workspace ?? undefined;
  const display_name = profile.display_name === undefined ? currentName : profile.display_name ?? undefined;
  const role = profile.role === undefined ? currentRole : profile.role ?? undefined;
  const checkout = profile.checkout === undefined ? currentCheckout : profile.checkout ?? undefined;
  return {
    ...rest,
    ...(webhook_url ? { webhook_url } : {}),
    ...(workspace ? { workspace } : {}),
    ...(display_name ? { display_name } : {}),
    ...(role ? { role } : {}),
    ...(checkout ? { checkout } : {}),
    state: profile.state ?? participant.state ?? "free",
    status: profile.status ?? participant.status ?? "joined",
    status_updated_at: now,
    last_seen_at: now,
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
    ...(profile.skills !== undefined ? { skills: profile.skills } : {}),
    ...(profile.capabilities !== undefined ? { capabilities: profile.capabilities } : {}),
    ...(profile.public_key !== undefined ? { public_key: profile.public_key } : {}),
  };
}

export function withUpdatedParticipant(invite: InviteState, participantId: string, profile: ParticipantProfile): InviteState {
  const participants = { ...invite.participants };
  participants[participantId] = updateParticipantProfile(participants[participantId], profile);
  return { ...invite, participants };
}

export function withReadReceipt(invite: InviteState, participantId: string, seq: number): InviteState {
  const participant = invite.participants[participantId];
  if (!participant) return invite;
  const now = new Date().toISOString();
  const participants = { ...invite.participants };
  participants[participantId] = {
    ...participant,
    last_seen_at: now,
    last_read_seq: Math.max(participant.last_read_seq, seq),
  };
  return { ...invite, participants };
}

export function withLeftParticipant(invite: InviteState, participantId: string): InviteState {
  const participants = { ...invite.participants };
  if (participants[participantId]) participants[participantId] = { ...participants[participantId], left_at: new Date().toISOString() };
  return { ...invite, participants };
}

export function withKickedParticipant(invite: InviteState, targetId: string): InviteState | Response {
  if (targetId === invite.hostId) return json({ error: "host cannot kick themselves" }, 400);
  if (!isParticipantJoined(invite.participants, targetId)) return json({ error: "target participant is not active" }, 404);
  return withLeftParticipant(invite, targetId);
}
