import { RoomApiError } from "./errors";
import type { RoomClient } from "./room-client";

export interface RoomNote {
  by: string;
  at: string;
  text: string;
  tags: string[];
  files: string[];
}

export interface RoomDecision {
  by: string;
  at: string;
  decision: string;
  why: string;
}

/** Append with a key-level compare-and-set so simultaneous authors cannot lose one another's entries. */
async function append<T>(client: RoomClient, key: "notes" | "decisions", value: T): Promise<T[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = (await client.board()).board[key];
    if (entry && !Array.isArray(entry.value)) throw new Error(`${key} must be an array`);
    const next = [...(entry?.value as T[] | undefined ?? []), value];
    try {
      await client.setBoardKey(key, next, { ifVersion: entry?.version ?? 0 });
      return next;
    } catch (error) {
      if (!(error instanceof RoomApiError && error.status === 409)) throw error;
    }
  }
  throw new Error(`${key} kept changing; try again`);
}

export function notesAndDecisions(board: Awaited<ReturnType<RoomClient["board"]>>["board"]) {
  return {
    notes: Array.isArray(board.notes?.value) ? board.notes.value as RoomNote[] : [],
    decisions: Array.isArray(board.decisions?.value) ? board.decisions.value as RoomDecision[] : [],
  };
}

export async function addNote(client: RoomClient, text: string, tags: string[] = [], files: string[] = []): Promise<RoomNote[]> {
  if (!text.trim()) throw new Error("note needs non-empty text");
  if (tags.some((tag) => !["gotcha", "finding", "howto"].includes(tag))) throw new Error("note --tag must be gotcha, finding or howto");
  return append(client, "notes", { by: client.participantId, at: new Date().toISOString(), text: text.trim(), tags, files });
}

export async function addDecision(client: RoomClient, decision: string, why: string): Promise<RoomDecision[]> {
  if (!decision.trim() || !why.trim()) throw new Error("decide needs: <decision> --why <reason>");
  return append(client, "decisions", { by: client.participantId, at: new Date().toISOString(), decision: decision.trim(), why: why.trim() });
}
