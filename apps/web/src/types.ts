import type { BoardEntry, Participant, RoomMessage } from "@j01n/sdk/types";
export type { BoardEntry, Participant, RoomMessage } from "@j01n/sdk/types";
export type { Recipient } from "@j01n/sdk/types";

export interface Env {
  RENDEZVOUS: DurableObjectNamespace;
  ROOM_REGISTRY?: DurableObjectNamespace;
  AGENT_INBOX?: DurableObjectNamespace;
}

/** Key-level board write permission: anyone, host_only, or specific participant IDs. */
export type BoardAclRule = "anyone" | "host_only" | string[];

/** Map of board key → write permission rule. Missing keys default to "anyone". */
export type BoardAcls = Record<string, BoardAclRule>;

/** A single state in the optional room state machine. */
export interface RoomStateConfig {
  /** Map of transition event → next state name. */
  transitions: Record<string, string>;
  /** Per-state board ACLs override room ACLs for these keys. */
  board_acls?: BoardAcls;
}

/** Payload sent to the DO's __init endpoint. Transient fields are consumed during init and never stored. */
export interface InitPayload {
  roomId: string;
  secretHash: string;
  expiresAt: number;
  phase: string;
  hostId: string;
  roomName: string;
  purpose: string;
  entryMessage?: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  boardAcls?: BoardAcls;
  /** Consumed during init — seeded as the first RoomMessage, then discarded. */
  firstMessage?: Record<string, unknown>;
  /** Consumed during init — unwrapped into the board, then discarded. */
  initialBoard?: Record<string, unknown>;
  /** When provided, the host is auto-joined as a participant during room creation. */
  hostPublicKey?: string;
  hostModel?: string;
  /** Optional room state machine config. */
  roomStates?: Record<string, RoomStateConfig>;
}

/** A webhook registered for a room. */
export interface WebhookHook {
  id: string;
  url: string;
  /** Event types to trigger on: "message", "board", "participant". Default all. */
  events?: ("message" | "board" | "participant")[];
  created_at: string;
  /** Optional secret to sign payloads with (future use). */
  secret?: string;
}

export interface InviteState {
  roomId: string;
  secretHash: string;
  expiresAt: number;
  /** State name: built-in ("waiting"|"ready"|"closed") or custom from state machine. */
  phase: string;
  hostId: string;
  roomName: string;
  purpose: string;
  entryMessage?: string;
  maxParticipants: number;
  boardSchema?: Record<string, unknown>;
  boardAcls?: BoardAcls;
  roomStates?: Record<string, RoomStateConfig>;
  nextSeq: number;
  participants: Record<string, Participant>;
  /** Index: tokenHash → participantId (O(1) lookup for per-participant tokens). */
  tokenIndex?: Record<string, string>;
  messages: RoomMessage[];
  board: Record<string, BoardEntry>;
  /** Registered webhook hooks for event notifications. */
  hooks?: WebhookHook[];
}
