// File reservations: who is changing which paths of which repo, so agents in one room do not edit the same files.
// Stored on the board key "reservations" as { "<id>": { by, since, sealed } }; `sealed` holds { repo, paths, reason }
// sealed with the room key (like workspaces), so the server only sees who holds a reservation, never the paths.
import { openRoomSeal, sealForRoom } from "./crypto";
import { RoomApiError } from "./errors";
import type { RoomClient } from "./room-client";

export const RESERVATIONS_KEY = "reservations";

export interface Reservation {
  id: string;
  by: string;
  since: string;
  /** Repository identity (git remote without credentials, or the repo root when there is no remote). */
  repo: string;
  /** Paths relative to the repo root; a path also covers everything under it. */
  paths: string[];
  reason?: string;
}

interface StoredReservation {
  by: string;
  since: string;
  sealed: string;
}

/** Same repo and one path equals, or is a directory containing, the other. */
export function pathsOverlap(a: string, b: string): boolean {
  const clean = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const [x, y] = [clean(a), clean(b)];
  return x === y || x === "" || y === "" || x.startsWith(y + "/") || y.startsWith(x + "/");
}

/** The first reservation by someone else that covers `path` in `repo`. */
export function reservationFor(reservations: Reservation[], me: string, repo: string, path: string): Reservation | undefined {
  return reservations.find((r) => r.by !== me && r.repo === repo && r.paths.some((p) => pathsOverlap(p, path)));
}

async function load(client: RoomClient): Promise<{ stored: Record<string, StoredReservation>; version: number; reservations: Reservation[] }> {
  const entry = (await client.board()).board[RESERVATIONS_KEY];
  const stored = (entry?.value && typeof entry.value === "object" ? entry.value : {}) as Record<string, StoredReservation>;
  const reservations = await Promise.all(Object.entries(stored).map(async ([id, r]) => {
    // Sealed like the kickoff: AES-GCM with a key derived from the room secret.
    const opened = await openRoomSeal(r.sealed, client.invite.join_secret, client.invite.room_id).catch(() => null) as { repo?: string; paths?: string[]; reason?: string } | null;
    return { id, by: r.by, since: r.since, repo: opened?.repo ?? "", paths: opened?.paths ?? [], ...(opened?.reason ? { reason: opened.reason } : {}) };
  }));
  return { stored, version: entry?.version ?? 0, reservations };
}

export async function listReservations(client: RoomClient): Promise<Reservation[]> {
  return (await load(client)).reservations;
}

/** Write the board only if nobody changed it since we read it; on a race, read again and retry. */
async function update(client: RoomClient, change: (state: Awaited<ReturnType<typeof load>>) => Promise<Record<string, StoredReservation> | Error | null>): Promise<Reservation[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await load(client);
    const next = await change(state);
    if (next instanceof Error) throw next;
    if (next === null) return state.reservations; // nothing to change, nothing to announce
    try {
      await client.setBoardKey(RESERVATIONS_KEY, next, { ifVersion: state.version });
      return (await load(client)).reservations;
    } catch (err) {
      if (!(err instanceof RoomApiError && err.status === 409)) throw err;
    }
  }
  throw new Error("reservations kept changing; try again");
}

/** Reserve paths of a repo for yourself. Fails (naming the holder) if someone else already reserved an overlapping path. */
export async function reservePaths(client: RoomClient, repo: string, paths: string[], reason?: string): Promise<Reservation[]> {
  if (paths.length === 0) throw new Error("reserve needs at least one path");
  return update(client, async ({ stored, reservations }) => {
    for (const path of paths) {
      const held = reservationFor(reservations, client.participantId, repo, path);
      if (held) return new Error(`${path} is already reserved by ${held.by}${held.reason ? ` (${held.reason})` : ""}`);
    }
    const sealed = await sealForRoom({ repo, paths, ...(reason ? { reason } : {}) }, client.invite.join_secret, client.invite.room_id);
    return { ...stored, [crypto.randomUUID()]: { by: client.participantId, since: new Date().toISOString(), sealed } };
  });
}

/** Release your reservations: all of them, or those covering any of `paths` (in `repo`). */
export async function releaseReservationIds(client: RoomClient, ids: string[]): Promise<Reservation[]> {
  return update(client, async ({ stored, reservations }) => {
    const owned = new Set(reservations.filter((r) => r.by === client.participantId && ids.includes(r.id)).map((r) => r.id));
    if (!owned.size) return null;
    return Object.fromEntries(Object.entries(stored).filter(([id]) => !owned.has(id)));
  });
}

export async function releasePaths(client: RoomClient, repo?: string, paths: string[] = []): Promise<Reservation[]> {
  return update(client, async ({ stored, reservations }) => {
    const mine = reservations.filter((r) => r.by === client.participantId
      && (paths.length === 0 || (r.repo === repo && r.paths.some((p) => paths.some((q) => pathsOverlap(p, q))))));
    if (mine.length === 0) return null;
    return Object.fromEntries(Object.entries(stored).filter(([id]) => !mine.some((r) => r.id === id)));
  });
}
