import { Validator } from "@cfworker/json-schema";
import { MAX_BOARD_VALUE_BYTES, sanitizeId } from "../constants";
import { json, type GuardResult } from "../format";
import { normalizeBoardKey, MAX_BOARD_KEY_LENGTH } from "../validation";
import type { BoardAclRule, BoardEntry, InviteState } from "../types";

const ENCODER = new TextEncoder();

function unwrapBoard(board: Record<string, BoardEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(board).map(([key, entry]) => [key, entry.value]));
}

/**
 * Unwrap a `ui:` envelope transparently. The web UI sends board values wrapped
 * as `{ encrypted_payload: "ui:base64(...)" }`. The server unwraps them before
 * storage so all consumers (API, CLI, SDK) see clean JSON. Existing stored
 * wrapped values are left in place; the web UI's read-path unwrapper handles them.
 */
function unwrapUiEnvelope(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const payload = record.encrypted_payload;
  if (typeof payload !== "string" || !payload.startsWith("ui:")) return value;
  try {
    const base64 = payload.slice(3);
    const json = decodeURIComponent(escape(atob(base64)));
    return JSON.parse(json);
  } catch {
    return value;
  }
}

function makeBoardEntry(value: unknown, updatedBy: string, previous?: BoardEntry): BoardEntry | Response {
  // Transparently unwrap ui: envelopes so stored board values are clean JSON.
  const cleanValue = unwrapUiEnvelope(value);
  const size = ENCODER.encode(JSON.stringify(cleanValue)).length;
  if (size > MAX_BOARD_VALUE_BYTES) {
    return json({ error: "board value too large", max_bytes: MAX_BOARD_VALUE_BYTES }, 413);
  }
  return { value: cleanValue, updated_by: updatedBy, updated_at: new Date().toISOString(), version: previous ? entryVersion(previous) + 1 : 1 };
}

/** Version of a stored entry (entries stored before versioning count as 1); 0 when the key does not exist. */
export function entryVersion(entry: BoardEntry | undefined): number {
  return entry ? entry.version ?? 1 : 0;
}

/** Optimistic concurrency: reject the write when the key changed since the version the writer last saw. */
function checkIfVersion(invite: InviteState, key: string, ifVersion: number | undefined): GuardResult {
  if (ifVersion === undefined) return undefined;
  const current = invite.board[key];
  if (entryVersion(current) === ifVersion) return undefined;
  return json({
    error: "board key changed since the version you read",
    key,
    expected_version: ifVersion,
    current_version: entryVersion(current),
    current: current ?? null,
  }, 409);
}

export function getBoard(invite: InviteState): Response {
  return json({
    board: invite.board,
    board_schema: invite.boardSchema ?? null,
    board_acls: invite.boardAcls ?? null,
  });
}

export function getBoardKey(invite: InviteState, keyFromPath: string): Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const entry = invite.board[key];
  if (!entry) return json({ error: "board key not found" }, 404);
  return json({ key, entry });
}

/** Resolve the effective ACL rule for a board key: per-state ACL overrides room ACL. */
function effectiveAclRule(invite: InviteState, key: string): BoardAclRule | undefined {
  // Per-state ACL (from optional state machine) takes priority.
  const stateConfig = invite.roomStates?.[invite.phase];
  if (stateConfig?.board_acls && key in stateConfig.board_acls) {
    return stateConfig.board_acls[key];
  }
  // Fall back to room-wide ACL.
  return invite.boardAcls?.[key];
}

/** Check whether `updatedBy` may write to the given board key. */
function checkBoardAcl(
  invite: InviteState,
  key: string,
  updatedBy: string,
): GuardResult {
  const rule = effectiveAclRule(invite, key);
  if (rule === undefined || rule === "anyone") return undefined;
  if (rule === "host_only") {
    if (updatedBy === invite.hostId) return undefined;
    return json({ error: "only the host can write to this board key" }, 403);
  }
  if (Array.isArray(rule) && rule.includes(updatedBy)) return undefined;
  return json({ error: "you don't have permission to write to this board key" }, 403);
}

export function setBoardKeyData(
  invite: InviteState,
  keyFromPath: string,
  value: unknown,
  updatedBy: string,
  ifVersion?: number,
): { board: Record<string, BoardEntry>; key: string; entry: BoardEntry } | Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const aclErr = checkBoardAcl(invite, key, updatedBy);
  if (aclErr) return aclErr;
  const conflict = checkIfVersion(invite, key, ifVersion);
  if (conflict) return conflict;
  const entryResult = makeBoardEntry(value, updatedBy, invite.board[key]);
  if (entryResult instanceof Response) return entryResult;
  const board = { ...invite.board, [key]: entryResult };
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, key, entry: entryResult };
}

export function patchBoardData(
  invite: InviteState,
  patchValues: Record<string, unknown>,
  updatedBy: string,
): { board: Record<string, BoardEntry>; updated: Record<string, BoardEntry> } | Response {
  const board = { ...invite.board };
  const updated: Record<string, BoardEntry> = {};
  for (const [rawKey, value] of Object.entries(patchValues)) {
    const key = normalizeBoardKey(rawKey);
    if (key instanceof Response) return key;
    const aclErr = checkBoardAcl(invite, key, updatedBy);
    if (aclErr) return aclErr;
    const entryResult = makeBoardEntry(value, updatedBy, board[key]);
    if (entryResult instanceof Response) return entryResult;
    board[key] = entryResult;
    updated[key] = entryResult;
  }
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, updated };
}

export function deleteBoardKeyData(
  invite: InviteState,
  keyFromPath: string,
  deletedBy: string,
  ifVersion?: number,
): { board: Record<string, BoardEntry>; key: string } | Response {
  const key = normalizeBoardKey(keyFromPath);
  if (key instanceof Response) return key;
  const conflict = checkIfVersion(invite, key, ifVersion);
  if (conflict) return conflict;
  const result = deleteBoardKeysData(invite, [key], deletedBy);
  if (result instanceof Response) return result;
  return { board: result.board, key };
}

/**
 * Delete multiple board keys in one operation. Returns the updated board and array of deleted keys.
 * Validates ACL for each key and schema on the resulting board.
 */
export function deleteBoardKeysData(
  invite: InviteState,
  keysFromPath: string[],
  deletedBy: string,
): { board: Record<string, BoardEntry>; keys: string[] } | Response {
  const board = { ...invite.board };
  const keys: string[] = [];
  for (const rawKey of keysFromPath) {
    const key = normalizeBoardKey(rawKey);
    if (key instanceof Response) return key;
    const aclErr = checkBoardAcl(invite, key, deletedBy);
    if (aclErr) return aclErr;
    delete board[key];
    keys.push(key);
  }
  const validation = validateBoard(invite.boardSchema, board);
  if (validation) return validation;
  return { board, keys };
}

export function wrapInitialBoard(
  initialBoard: Record<string, unknown> | undefined,
  updatedBy: string,
): Record<string, BoardEntry> | Response {
  if (!initialBoard) return {};
  const board: Record<string, BoardEntry> = {};
  for (const [rawKey, value] of Object.entries(initialBoard)) {
    const key = sanitizeId(rawKey).slice(0, MAX_BOARD_KEY_LENGTH);
    if (!key) continue;
    const entry = makeBoardEntry(value, updatedBy);
    if (entry instanceof Response) return entry;
    board[key] = entry;
  }
  return board;
}

export function validateBoard(
  schema: Record<string, unknown> | undefined,
  board: Record<string, BoardEntry>,
): GuardResult {
  if (!schema) return undefined;
  try {
    const result = new Validator(schema, "7").validate(unwrapBoard(board));
    if (result.valid) return undefined;
    return json({
      error: "board schema validation failed",
      issues: result.errors.map((issue) => ({
        path: issue.instanceLocation.replace(/^#/, "") || "/",
        message: issue.error,
        keyword: issue.keyword,
      })),
    }, 422);
  } catch (error) {
    return json({
      error: "invalid board_schema",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}
