/**
 * Shared test helpers for room lifecycle tests.
 *
 * Creates a mock DurableObjectState backed by in-memory Map and provides
 * helper functions for making authenticated requests against a RendezvousSession.
 */

import { DEFAULT_MAX_PARTICIPANTS, INVITE_TTL_MS } from "../../src/constants";
import { hashJoinSecret, randomBase64Url } from "@j01n/sdk/crypto";
import { RendezvousSession } from "../../src/rendezvous";

/** Create a mock DurableObjectState with in-memory storage. */
export function createMockState(): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { storage.set(key, value); },
      delete: async (key: string) => storage.delete(key),
      deleteAll: async () => storage.clear(),
      list: async (options?: { prefix?: string }) => new Map([...storage].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))),
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      sync: async () => {},
      transaction: async <T>(fn: () => Promise<T>) => fn(),
    },
    id: { toString: () => "test-do" },
    waitUntil: async () => {},
    blockConcurrencyWhile: async () => {},
  } as unknown as DurableObjectState;
}

export function createMockEnv(): { RENDEZVOUS: DurableObjectNamespace } {
  return { RENDEZVOUS: {} as DurableObjectNamespace };
}

export interface RoomOpts {
  roomId?: string;
  hostId?: string;
  roomName?: string;
  maxParticipants?: number;
  firstMessage?: Record<string, unknown>;
  boardSchema?: Record<string, unknown>;
  initialBoard?: Record<string, unknown>;
  boardAcls?: import("../../src/types").BoardAcls;
  roomStates?: Record<string, import("../../src/types").RoomStateConfig>;
  phase?: string;
  /** Room lifetime from now; defaults to INVITE_TTL_MS. */
  expiresInMs?: number;
}

/** Bootstrap a room. Returns the session, the invite/secret, and the room path for making auth'd requests. */
export async function bootstrapRoom(opts: RoomOpts = {}, state = createMockState()): Promise<RoomFixture> {
  const session = new RendezvousSession(state, createMockEnv());
  const roomId = opts.roomId ?? randomBase64Url(16);
  const joinSecret = randomBase64Url(32);
  const secretHash = await hashJoinSecret(roomId, joinSecret);

  const res = await session.fetch(new Request("https://rendezvous.internal/__init", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      secretHash,
      expiresAt: Date.now() + (opts.expiresInMs ?? INVITE_TTL_MS),
      phase: opts.phase ?? "waiting",
      hostId: opts.hostId ?? "host",
      roomName: opts.roomName ?? "test room",
      maxParticipants: opts.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      ...(opts.firstMessage ? { firstMessage: opts.firstMessage } : {}),
      ...(opts.boardSchema ? { boardSchema: opts.boardSchema } : {}),
      ...(opts.initialBoard ? { initialBoard: opts.initialBoard } : {}),
      ...(opts.boardAcls ? { boardAcls: opts.boardAcls } : {}),
      ...(opts.roomStates ? { roomStates: opts.roomStates } : {}),
    }),
    headers: { "content-type": "application/json" },
  }));

  if (!res.ok) throw new Error(`bootstrapRoom failed: ${res.status}`);
  return { session, roomId, joinSecret, roomPath: `/r/${roomId}`, participantTokens: {} };
}

export interface RoomFixture {
  session: RendezvousSession;
  roomId: string;
  joinSecret: string;
  roomPath: string;
  participantTokens: Record<string, string>;
}

export function authHeaders(secret: string, participantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (participantId) headers["x-participant-id"] = participantId;
  return headers;
}

export function participantAuthHeaders(fixture: RoomFixture, participantId: string): Record<string, string> {
  const token = fixture.participantTokens[participantId];
  if (!token) throw new Error(`missing participant token for ${participantId}; join the participant first`);
  return { authorization: `Bearer ${token}` };
}

export async function roomRequest(fixture: RoomFixture, path = "", init?: RequestInit): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}${path}`, init));
}

export async function deleteParticipant(fixture: RoomFixture, targetId: string, actorId?: string): Promise<Response> {
  return roomRequest(fixture, `/participants/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
    headers: participantAuthHeaders(fixture, actorId ?? targetId),
  });
}

export async function closeRoom(fixture: RoomFixture): Promise<Response> {
  return roomRequest(fixture, "", {
    method: "DELETE",
    headers: participantAuthHeaders(fixture, "host"),
  });
}

export async function getRoomJson<T>(fixture: RoomFixture, path: string, participantId = Object.keys(fixture.participantTokens)[0]): Promise<T> {
  if (!participantId) throw new Error("getRoomJson needs a joined participant");
  const res = await roomRequest(fixture, path, { headers: participantAuthHeaders(fixture, participantId) });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

export async function joinParticipant(fixture: RoomFixture, participantId: string): Promise<Response> {
  const response = await fixture.session.fetch(new Request(`https://room${fixture.roomPath}/participants/${encodeURIComponent(participantId)}`, {
    method: "PUT",
    headers: { ...authHeaders(fixture.joinSecret), "content-type": "application/json" },
  }));
  if (response.ok) {
    const body = await response.clone().json() as { participant_token?: string };
    if (body.participant_token) fixture.participantTokens[participantId] = body.participant_token;
  }
  return response;
}

export async function announceKey(fixture: RoomFixture, participantId: string): Promise<Response> {
  return roomRequest(fixture, "", {
    method: "POST",
    headers: { ...participantAuthHeaders(fixture, participantId), "content-type": "application/json" },
    body: JSON.stringify({ to: "all", intent: "key.exchange", body: { public_key: `${participantId}-raw-key` } }),
  });
}

export function encryptedPayload(body: unknown): { encrypted_payload: string } {
  return { encrypted_payload: JSON.stringify(body) };
}

export function decodedPayload<T>(body: unknown): T {
  const record = body as Record<string, unknown>;
  // System messages (participant.joined etc.) have inline JSON body — return as-is
  if (typeof record.encrypted_payload !== "string") return body as T;
  return JSON.parse(record.encrypted_payload) as T;
}

export async function sendMessage(fixture: RoomFixture, participantId: string, to: string, body: unknown): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}`, {
    method: "POST",
    headers: { ...participantAuthHeaders(fixture, participantId), "content-type": "application/json" },
    body: JSON.stringify({ to, body: encryptedPayload(body) }),
  }));
}

export async function readMessages(fixture: RoomFixture, participantId: string, after = 0): Promise<Response> {
  return fixture.session.fetch(new Request(`https://room${fixture.roomPath}?after=${after}`, {
    headers: participantAuthHeaders(fixture, participantId),
  }));
}

// Re-export vitest helpers for convenience
import { expect } from "vitest";
export type { RoomMessage } from "../../src/types";
