import { json } from "../format";
import type { InviteState } from "../types";
import { isParticipantJoined } from "./participants";
import { normalizeParticipantId } from "../validation";
import { hashJoinSecret } from "@j01n/sdk/crypto";

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return {};
  const text = await request.clone().text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { return {}; }
}

export interface ParsedRequest {
  body: Record<string, unknown>;
  token: string | undefined;
  participantId: string | undefined; // from x-participant-id header
}

export async function parseRequest(request: Request): Promise<ParsedRequest> {
  const body = await readJsonObject(request);
  const token = tokenFromRequest(request);
  const url = new URL(request.url);
  const participantId = request.headers.get("x-participant-id") ?? url.searchParams.get("participant_id") ?? undefined;
  return { body, token, participantId };
}

function tokenFromRequest(request: Request): string | undefined {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const url = new URL(request.url);
  return url.searchParams.get("s") ?? url.searchParams.get("token") ?? undefined;
}

export interface AuthSuccess {
  ok: true;
  body: Record<string, unknown>;
  participantId: string;
}

export type AuthResult = AuthSuccess | Response;

/**
 * Validate bearer token and resolve the participant ID.
 *
 * - Per-participant token: resolves to the bound participant ID.
 * - Room-level join_secret: returns undefined (x-participant-id header is required).
 */
export async function authenticate(invite: InviteState, parsed: ParsedRequest): Promise<{ resolvedParticipantId?: string } | Response> {
  if (!parsed.token) return json({ error: "authorization token is required" }, 401);

  // Try room-level join_secret first
  const roomHash = await hashJoinSecret(invite.roomId, parsed.token);
  if (roomHash === invite.secretHash) return {};

  // Try per-participant tokens via O(1) tokenIndex lookup
  if (invite.tokenIndex) {
    const pid = invite.tokenIndex[roomHash];
    if (pid) {
      const participant = invite.participants[pid];
      if (isParticipantJoined(invite.participants, pid) && participant?.tokenHash) {
        // Verify the token is bound to this participant (double-check)
        const expectedHash = await hashJoinSecret(invite.roomId + "." + pid, parsed.token);
        if (expectedHash === participant.tokenHash) {
          return { resolvedParticipantId: pid };
        }
      }
    }
  }

  return json({ error: "invalid authorization token" }, 403);
}

/**
 * Validate bearer token + resolve participant ID.
 *
 * Resolution order:
 * 1. If the token is a per-participant token, use its bound participant ID.
 * 2. If x-participant-id header is present, use it (for room-level join_secret).
 * 3. If fallbackId is provided (from URL path), use it.
 */
export async function authenticateParticipant(
  invite: InviteState,
  parsed: ParsedRequest,
  fallbackId?: string,
): Promise<AuthResult> {
  const tokenResult = await authenticate(invite, parsed);
  if (tokenResult instanceof Response) return tokenResult;

  // Per-participant token already resolves the participant ID
  if (tokenResult.resolvedParticipantId) {
    return { ok: true, body: parsed.body, participantId: tokenResult.resolvedParticipantId };
  }

  // Room-level secret: need x-participant-id or fallback
  const raw = parsed.participantId ?? fallbackId ?? null;
  const pidResult = normalizeParticipantId(raw);
  if (pidResult instanceof Response) return pidResult;
  return { ok: true, body: parsed.body, participantId: pidResult };
}

/** Assert the authenticated participant has joined the room. */
export async function requireJoined(
  invite: InviteState,
  auth: AuthResult,
): Promise<AuthResult> {
  if (auth instanceof Response) return auth;
  if (!isParticipantJoined(invite.participants, auth.participantId)) {
    return json({ error: "participant has not joined" }, 403);
  }
  return auth;
}

/** Validate bearer token only (for read-only endpoints), then run fn. */
export async function tokenAuthThen(
  invite: InviteState,
  request: Request,
  fn: () => Promise<Response>,
): Promise<Response> {
  const parsed = await parseRequest(request);
  const result = await authenticate(invite, parsed);
  if (result instanceof Response) return result;
  if (!result.resolvedParticipantId) {
    return json({ error: "participant token is required" }, 403);
  }
  return fn();
}

/** Validate a per-participant token (not the room join_secret), then run fn with the bound participant. */
export async function participantTokenAuthThen(
  invite: InviteState,
  request: Request,
  fn: (auth: AuthSuccess) => Promise<Response>,
): Promise<Response> {
  const parsed = await parseRequest(request);
  const result = await authenticate(invite, parsed);
  if (result instanceof Response) return result;
  if (!result.resolvedParticipantId) {
    return json({ error: "participant token is required" }, 403);
  }
  return fn({ ok: true, body: parsed.body, participantId: result.resolvedParticipantId });
}

/** Validate token + participant ID (no join check), then run fn with the auth result. */
export async function participantAuthThen(
  invite: InviteState,
  request: Request,
  fn: (auth: AuthSuccess) => Promise<Response>,
): Promise<Response> {
  const parsed = await parseRequest(request);
  const auth = await authenticateParticipant(invite, parsed);
  if (auth instanceof Response) return auth;
  return fn(auth);
}

/** Validate token + participant ID, require joined, then run fn with the auth result. */
export async function joinedThen(
  invite: InviteState,
  request: Request,
  fn: (auth: AuthSuccess) => Promise<Response>,
): Promise<Response> {
  return participantTokenAuthThen(invite, request, async (auth) => {
    const joined = await requireJoined(invite, auth);
    if (joined instanceof Response) return joined;
    return fn(joined);
  });
}
