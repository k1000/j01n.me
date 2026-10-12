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
  unblockedNoticeBody,
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
    let current = await announceSystemMessage(this.storage, this.events, invite, "board.changed",
      { text: boardChangeText(updatedBy, changes, invite.board, board), updated_by: updatedBy, changes },
      { board }, { changes, updatedBy });
    for (const { id, recipients, caused_by, role, needs } of newlyUnblocked(changes, invite.board, board)) {
      const predecessorId = caused_by[0];
      const finishedOwner = taskValue(current.board[`task.${predecessorId}`])?.owner;
      // Role-aware routing: if the dependent task declares a role, try to find a matching free participant.
      if (typeof role === "string" && role) {
        const assigned = pickAssignmentTarget(current, role, needs, typeof finishedOwner === "string" ? finishedOwner : undefined);
        if (assigned) {
          const body = unblockedNoticeBody(id, predecessorId, current.board, assigned);
          current = await announceSystemMessage(this.storage, this.events, current, "task.unblocked",
            body, {}, undefined, assigned);
          const routingText = `${id} routed to ${assigned} (role: ${role}${needs?.length ? `, needs: ${needs.join(",")}` : ""})`;
          current = await announceSystemMessage(this.storage, this.events, current, "task.routed",
            { text: routingText, task_id: id, assigned, role, ...(needs?.length ? { needs } : {}) },
            { board: current.board });
          continue;
        }
        // No matching participant: post unrouted notice text.
        if (needs && needs.length > 0) {
          const unroutedText = `${id} unrouted: needs ${needs.join(",")}, no free capable holder`;
          current = await announceSystemMessage(this.storage, this.events, current, "task.unrouted",
            { text: unroutedText, task_id: id, role, needs },
            { board: current.board });
        }
      }
      // No role or no matching participant: existing bare unblocked notice to recipients.
      for (const recipient of recipients) {
        if (!current.participants[recipient] || current.participants[recipient].left_at) continue;
        const body = unblockedNoticeBody(id, predecessorId, current.board);
        current = await announceSystemMessage(this.storage, this.events, current, "task.unblocked",
          body, {}, undefined, recipient);
      }
    }
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
function taskValue(entry: BoardEntry | undefined): Record<string, unknown> | undefined {
  const value = entry?.value;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function newlyUnblocked(changes: Record<string, BoardChange>, before: InviteState["board"], after: InviteState["board"]): Array<{ id: string; recipients: string[]; caused_by: string[]; role?: string; needs?: string[] }> {
  const done = Object.keys(changes).filter((key) => key.startsWith("task.") && taskValue(before[key])?.status !== "done" && taskValue(after[key])?.status === "done").map((key) => key.slice(5));
  if (!done.length) return [];
  return Object.entries(after).flatMap(([key, entry]) => {
    if (!key.startsWith("task.")) return [];
    const task = taskValue(entry);
    const deps = task?.depends_on;
    if (!task || task.status === "done" || task.status === "blocked" || !Array.isArray(deps) || !deps.some((id) => done.includes(id)) ||
      !deps.every((id) => typeof id === "string" && taskValue(after[`task.${id}`])?.status === "done") ||
      deps.every((id) => typeof id === "string" && taskValue(before[`task.${id}`])?.status === "done")) return [];
    const waiters = Array.isArray(task.waiting_for) ? task.waiting_for.filter((id): id is string => typeof id === "string") : [];
    const role = typeof task.role === "string" ? task.role : undefined;
    const needs = Array.isArray(task.needs) ? task.needs.filter((t): t is string => typeof t === "string") : undefined;
    return [{ id: key.slice(5), recipients: [...new Set([...(typeof task.owner === "string" ? [task.owner] : []), ...waiters])], caused_by: done.filter((id) => deps.includes(id)), role, needs }];
  });
}

/**
 * Pick the first joined participant whose role matches, state is free, and (if needs are specified)
 * whose announced capabilities include every required token. Excludes the just-finished task owner
 * unless they are the sole match.
 */
function pickAssignmentTarget(invite: InviteState, role: string, needs: string[] | undefined, finishedOwner: string | undefined): string | undefined {
  const candidates = Object.values(invite.participants).filter((p) => {
    if (p.left_at || p.role !== role || p.state !== "free") return false;
    if (needs && needs.length > 0) {
      const caps = p.capabilities ?? [];
      if (!needs.every((token) => caps.includes(token))) return false;
    }
    return true;
  });
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].id;
  // Multiple candidates: exclude the just-finished owner.
  const nonOwner = candidates.filter((p) => p.id !== finishedOwner);
  return (nonOwner.length > 0 ? nonOwner : candidates)[0].id;
}

function boardChangeText(updatedBy: string, changes: Record<string, BoardChange>, before: InviteState["board"], after: InviteState["board"]): string {
  const lines = Object.entries(changes).map(([key, change]) => {
    if (!change) return `${updatedBy} deleted ${key}`;
    if (key === RESERVATIONS_KEY) return reservationChangeText(updatedBy, before[key], change.value);
    const task = key.startsWith("task.") ? taskValue(after[key]) : undefined;
    const prior = taskValue(before[key]);
    if (task && task.status !== prior?.status) {
      const id = key.slice(5);
      // A seeded spec `contract:` is the task's required check: echo it so a late joiner sees it when claimed.
      const contract = typeof task.contract === "string" && task.contract.trim() ? ` — contract: ${task.contract.trim().slice(0, 300)}` : "";
      if (task.status === "claimed") return `${String(task.owner ?? updatedBy)} claimed ${id}${contract}`;
      if (task.status === "done") return `${id} done: ${String(task.summary ?? "completed").slice(0, 300)}`;
      if (task.status === "blocked") return `${id} blocked: ${String(task.blocked_reason ?? "no reason given").slice(0, 300)}`;
      if (task.status === "open") return `${id} is open`;
    }
    const value = JSON.stringify(change.value) ?? "null";
    return `${updatedBy} set ${key} (v${change.version}): ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`;
  });
  for (const { id } of newlyUnblocked(changes, before, after)) lines.push(`${id} is now unblocked`);
  return lines.join("; ");
}

function boardChanges(entries: Record<string, BoardEntry>): Record<string, { value: unknown; version: number }> {
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { value: entry.value, version: entry.version ?? 1 }]));
}
