import { json } from "../format";
import type { InviteState } from "../types";
import { joinedThen, tokenAuthThen } from "./auth-context";
import {
  deleteBoardKeyData,
  deleteBoardKeysData,
  getBoard,
  getBoardKey,
  patchBoardData,
  RESERVATIONS_KEY,
  reservationChangeText,
  setBoardKeyData,
} from "./board";
import type { RoomEventBus } from "./events";
import type { BoardChange } from "@j01n/sdk/types";
import type { BoardEntry } from "../types";
import { announceSystemMessage } from "./announcement";
import type { RoomStorage } from "./storage";

export class RoomBoardController {
  constructor(private readonly storage: RoomStorage, private readonly events: RoomEventBus) {}

  /**
   * Save the board and tell everyone: waiters get the change directly, and one `board.changed` system message to all
   * puts it in the room history, so readers, late joiners, SSE and the web page see board progress too.
   */
  private async announce(invite: InviteState, board: InviteState["board"], updatedBy: string, changes: Record<string, BoardChange>): Promise<void> {
    await announceSystemMessage(this.storage, this.events, invite, "board.changed",
      { text: boardChangeText(updatedBy, changes, invite.board), updated_by: updatedBy, changes },
      { board }, { changes, updatedBy });
  }

  get(request: Request, invite: InviteState): Promise<Response> {
    return tokenAuthThen(invite, request, async () => getBoard(invite));
  }

  getKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return tokenAuthThen(invite, request, async () => getBoardKey(invite, keyFromPath));
  }

  setKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const ifVersion = parseIfVersion(request);
      if (ifVersion instanceof Response) return ifVersion;
      const result = setBoardKeyData(invite, keyFromPath, auth.body, auth.participantId, ifVersion);
      if (result instanceof Response) return result;
      await this.announce(invite, result.board, auth.participantId, boardChanges({ [result.key]: result.entry }));
      return json({ ok: true, key: result.key, entry: result.entry });
    });
  }

  patch(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const ifVersions = parseIfVersions(request);
      if (ifVersions instanceof Response) return ifVersions;
      const result = patchBoardData(invite, auth.body, auth.participantId, ifVersions);
      if (result instanceof Response) return result;
      await this.announce(invite, result.board, auth.participantId, boardChanges(result.updated));
      return json({ ok: true, updated: result.updated, board: result.board });
    });
  }

  deleteKey(request: Request, invite: InviteState, keyFromPath: string): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const ifVersion = parseIfVersion(request);
      if (ifVersion instanceof Response) return ifVersion;
      const result = deleteBoardKeyData(invite, keyFromPath, auth.participantId, ifVersion);
      if (result instanceof Response) return result;
      await this.announce(invite, result.board, auth.participantId, { [result.key]: null });
      return json({ ok: true, deleted: result.key });
    });
  }

  /** Batch delete: POST /r/:roomId/board/delete with { keys: [...] } */
  async deleteKeys(request: Request, invite: InviteState): Promise<Response> {
    return joinedThen(invite, request, async (auth) => {
      const rawKeys = (auth.body.keys ?? []) as string[];
      if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        return json({ error: "keys must be a non-empty array" }, 400);
      }
      const result = deleteBoardKeysData(invite, rawKeys, auth.participantId);
      if (result instanceof Response) return result;
      await this.announce(invite, result.board, auth.participantId, Object.fromEntries(result.keys.map((key) => [key, null])));
      return json({ ok: true, deleted: result.keys });
    });
  }
}

/** Optional `?if_version=N` on single-key writes (0 = the key must not exist yet). */
function parseIfVersion(request: Request): number | undefined | Response {
  const raw = new URL(request.url).searchParams.get("if_version");
  if (raw === null) return undefined;
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0 ? version : json({ error: "if_version must be a non-negative integer" }, 400);
}

/** Optional `?if_versions={"key":N,...}` on PATCH /board (0 = the key must not exist yet). */
function parseIfVersions(request: Request): Record<string, number> | Response {
  const raw = new URL(request.url).searchParams.get("if_versions");
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => Number.isInteger(v) && (v as number) >= 0)) return parsed as Record<string, number>;
  } catch { /* fall through */ }
  return json({ error: "if_versions must be a JSON object of key -> non-negative integer version" }, 400);
}

/** One line per write, e.g. `pi-agent set status_T3 (v2): {"state":"review"}`; values shortened. */
function boardChangeText(updatedBy: string, changes: Record<string, BoardChange>, before: InviteState["board"]): string {
  return Object.entries(changes).map(([key, change]) => {
    if (!change) return `${updatedBy} deleted ${key}`;
    if (key === RESERVATIONS_KEY) return reservationChangeText(updatedBy, before[key], change.value);
    const value = JSON.stringify(change.value) ?? "null";
    return `${updatedBy} set ${key} (v${change.version}): ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`;
  }).join("; ");
}

function boardChanges(entries: Record<string, BoardEntry>): Record<string, { value: unknown; version: number }> {
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { value: entry.value, version: entry.version ?? 1 }]));
}
