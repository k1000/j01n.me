// Per-participant usage metrics: active time, tokens and estimated cost, plus room totals.
//
// Storage contract (client API, CLI and live room view all read this shape):
// - one board key per participant: `usage.<participant-id>`; only that participant writes their own key;
// - the value is a single room seal (`jsk1:...`) around a cumulative `UsageSnapshot`, exactly like workspaces
//   and reservations, so the server only sees that a key exists and who wrote it - never any numbers;
// - reports are self-reported `UsageDelta`s added to the previous snapshot with applyUsageDelta();
// - aggregation, costing and formatting happen here on the client: the server stays content-agnostic.
import { openRoomSeal, sealForRoom } from "./crypto";
import type { BoardEntry } from "./types";

export const USAGE_KEY_PREFIX = "usage.";

/** Bounds for one self-reported delta: a report cannot claim more than a day of work or a billion tokens. */
export const MAX_USAGE_DELTA_ACTIVE_MS = 24 * 60 * 60 * 1000;
export const MAX_USAGE_DELTA_TOKENS = 1_000_000_000;
export const MAX_USAGE_DELTA_COST_USD = 10_000;
/** A snapshot whose newest delta is older than this is reported as stale. */
export const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;

/** What a participant adds since their last report. At least one counter must be present. */
export interface UsageDelta {
  /** Wall-clock time this participant spent working on the room, in milliseconds. */
  active_ms?: number;
  /** Prompt tokens consumed. */
  input_tokens?: number;
  /** Completion tokens produced. */
  output_tokens?: number;
  /** Cost estimate in US cents-free USD; omit to let readers estimate from rates. */
  cost_usd?: number;
  /** Model that produced the reported tokens, for rate lookup and display. */
  model?: string;
  provider?: string;
  /** ISO timestamp of this report; defaults to now when applied. */
  at?: string;
}

/** Cumulative usage of one participant, as stored (sealed) under `usage.<participant>`. */
export interface UsageSnapshot {
  participant: string;
  /** Number of accepted reports. */
  reports: number;
  /** ISO timestamp of the newest accepted delta. */
  updated_at: string;
  active_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model?: string;
  provider?: string;
}

/** Fields every usage sum carries, so one formatter serves snapshots and room totals. */
export interface UsageNumbers {
  active_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface UsageTotals extends UsageNumbers {
  /** Participants that reported at least once. */
  participants: number;
  /** input_tokens + output_tokens. */
  tokens: number;
}

/** List price per million tokens, used only for client-side estimates. */
export interface TokenRates {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
}

/** One `usage.*` board key as a reader sees it. */
export interface UsageRow {
  participant: string;
  key: string;
  /** Board version, so writers can compare-and-set. */
  version: number;
  /** Null when the key is missing, cannot be opened with this room secret, or holds a bad snapshot. */
  snapshot: UsageSnapshot | null;
  /** True when a snapshot exists but is older than `staleAfterMs`, or when nothing was ever reported. */
  stale: boolean;
}

/** Rough model list prices (USD per million tokens). Estimates only; callers can pass their own table. */
export const DEFAULT_TOKEN_RATES: TokenRates = { input_usd_per_mtok: 1, output_usd_per_mtok: 4 };
export const MODEL_TOKEN_RATES: Record<string, TokenRates> = {
  "claude-opus": { input_usd_per_mtok: 15, output_usd_per_mtok: 75 },
  "claude-sonnet": { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
  "claude-haiku": { input_usd_per_mtok: 0.8, output_usd_per_mtok: 4 },
  "gpt-5": { input_usd_per_mtok: 1.25, output_usd_per_mtok: 10 },
  "gpt-4.1": { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  "gpt-4o": { input_usd_per_mtok: 2.5, output_usd_per_mtok: 10 },
  "o3": { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  "gemini-flash": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 2.5 },
  "gemini-pro": { input_usd_per_mtok: 1.25, output_usd_per_mtok: 10 },
  "qwen3": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 },
  "deepseek": { input_usd_per_mtok: 0.3, output_usd_per_mtok: 1.2 },
  "llama": { input_usd_per_mtok: 0.2, output_usd_per_mtok: 0.6 },
};

// ── Board keys ──────────────────────────────────────────────────

const PARTICIPANT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** Board key holding one participant's sealed cumulative snapshot. */
export function usageKey(participantId: string): string {
  if (!PARTICIPANT_ID.test(participantId)) throw new Error(`invalid participant id for a usage key: ${participantId}`);
  return `${USAGE_KEY_PREFIX}${participantId}`;
}

export function isUsageKey(key: string): boolean {
  return key.startsWith(USAGE_KEY_PREFIX) && PARTICIPANT_ID.test(key.slice(USAGE_KEY_PREFIX.length));
}

/** Participant a `usage.*` board key belongs to, or undefined for other keys. */
export function participantFromUsageKey(key: string): string | undefined {
  return isUsageKey(key) ? key.slice(USAGE_KEY_PREFIX.length) : undefined;
}

// ── Validation ──────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function count(value: unknown, name: string, { integer = false, max }: { integer?: boolean; max?: number } = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`usage ${name} must be a ${integer ? "whole " : ""}number >= 0`);
  }
  if (max !== undefined && value > max) throw new Error(`usage ${name} must be <= ${max}`);
  return value;
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`usage ${name} must be a non-empty string`);
  return value.trim();
}

function timestamp(value: unknown, name: string, now: () => Date): string {
  if (value === undefined || value === null) return now().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`usage ${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

const DELTA_FIELDS = ["active_ms", "input_tokens", "output_tokens", "cost_usd", "model", "provider", "at"];
const SNAPSHOT_FIELDS = [...DELTA_FIELDS.slice(0, 6), "participant", "reports", "updated_at"];

/** Validate a reported delta. Unknown keys are rejected so a typo cannot silently report zero usage. */
export function parseUsageDelta(value: unknown): UsageDelta {
  if (!isObject(value)) throw new Error("usage delta must be an object");
  const unknown = Object.keys(value).filter((key) => !DELTA_FIELDS.includes(key));
  if (unknown.length) throw new Error(`unknown usage delta field(s): ${unknown.join(", ")}`);
  const delta: UsageDelta = {};
  const active = count(value.active_ms, "active_ms", { integer: true, max: MAX_USAGE_DELTA_ACTIVE_MS });
  const input = count(value.input_tokens, "input_tokens", { integer: true, max: MAX_USAGE_DELTA_TOKENS });
  const output = count(value.output_tokens, "output_tokens", { integer: true, max: MAX_USAGE_DELTA_TOKENS });
  const cost = count(value.cost_usd, "cost_usd", { max: MAX_USAGE_DELTA_COST_USD });
  const model = text(value.model, "model");
  const provider = text(value.provider, "provider");
  const at = value.at === undefined || value.at === null ? undefined : timestamp(value.at, "at", () => new Date());
  if (active === undefined && input === undefined && output === undefined && cost === undefined && model === undefined && provider === undefined && at === undefined) {
    throw new Error("usage delta needs at least one of active_ms, input_tokens, output_tokens, cost_usd, model, provider, at");
  }
  if (active !== undefined) delta.active_ms = active;
  if (input !== undefined) delta.input_tokens = input;
  if (output !== undefined) delta.output_tokens = output;
  if (cost !== undefined) delta.cost_usd = cost;
  if (model !== undefined) delta.model = model;
  if (provider !== undefined) delta.provider = provider;
  if (at !== undefined) delta.at = at;
  return delta;
}

/** Validate a stored snapshot. `participantHint` fills in the id for a snapshot stored without one. */
export function parseUsageSnapshot(value: unknown, participantHint?: string): UsageSnapshot {
  if (!isObject(value)) throw new Error("usage snapshot must be an object");
  const unknown = Object.keys(value).filter((key) => !SNAPSHOT_FIELDS.includes(key));
  if (unknown.length) throw new Error(`unknown usage snapshot field(s): ${unknown.join(", ")}`);
  const participant = text(value.participant, "participant") ?? (participantHint && PARTICIPANT_ID.test(participantHint) ? participantHint : undefined);
  if (!participant) throw new Error("usage snapshot needs a participant");
  const reports = count(value.reports, "reports", { integer: true });
  if (reports === undefined) throw new Error("usage reports must be a whole number >= 0");
  const model = text(value.model, "model");
  const provider = text(value.provider, "provider");
  return {
    participant,
    reports,
    updated_at: timestamp(value.updated_at, "updated_at", () => new Date()),
    active_ms: count(value.active_ms, "active_ms") ?? 0,
    input_tokens: count(value.input_tokens, "input_tokens") ?? 0,
    output_tokens: count(value.output_tokens, "output_tokens") ?? 0,
    cost_usd: count(value.cost_usd, "cost_usd") ?? 0,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

/** Tolerant reader for board values: null instead of a throw when the shape is not a snapshot. */
export function coerceUsageSnapshot(value: unknown, participantHint?: string): UsageSnapshot | null {
  try {
    return parseUsageSnapshot(value, participantHint);
  } catch {
    return null;
  }
}

export function emptyUsage(participant: string, at = new Date().toISOString()): UsageSnapshot {
  return { participant, reports: 0, updated_at: new Date(at).toISOString(), active_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

// ── Accumulation ────────────────────────────────────────────────

/** Add a self-reported delta to the previous cumulative snapshot (a missing previous one starts from zero). */
export function applyUsageDelta(participant: string, previous: UsageSnapshot | null | undefined, deltaInput: UsageDelta | unknown): UsageSnapshot {
  const delta = parseUsageDelta(deltaInput);
  const base = previous && previous.participant === participant ? previous : emptyUsage(participant);
  const model = delta.model ?? base.model;
  const provider = delta.provider ?? base.provider;
  return {
    participant,
    reports: base.reports + 1,
    updated_at: timestamp(delta.at, "at", () => new Date()),
    active_ms: base.active_ms + (delta.active_ms ?? 0),
    input_tokens: base.input_tokens + (delta.input_tokens ?? 0),
    output_tokens: base.output_tokens + (delta.output_tokens ?? 0),
    cost_usd: roundCost(base.cost_usd + (delta.cost_usd ?? 0)),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

/** The same accumulation from a raw (possibly corrupt or absent) previous value; bad input means "start over". */
export function nextUsage(participant: string, previousValue: unknown, deltaInput: UsageDelta | unknown): UsageSnapshot {
  return applyUsageDelta(participant, coerceUsageSnapshot(previousValue, participant), deltaInput);
}

/** Counter-style reporters give absolute totals; turn two snapshots into the delta between them. */
export function usageDeltaBetween(previous: UsageSnapshot | null | undefined, current: UsageSnapshot): UsageDelta {
  const base = previous ?? emptyUsage(current.participant);
  const nonNegative = (value: number) => Math.max(0, value);
  return {
    active_ms: nonNegative(current.active_ms - base.active_ms),
    input_tokens: nonNegative(current.input_tokens - base.input_tokens),
    output_tokens: nonNegative(current.output_tokens - base.output_tokens),
    cost_usd: nonNegative(roundCost(current.cost_usd - base.cost_usd)),
    ...(current.model ? { model: current.model } : {}),
    ...(current.provider ? { provider: current.provider } : {}),
    at: timestamp(current.updated_at, "updated_at", () => new Date()),
  };
}

export function usageTotals(snapshots: Iterable<UsageSnapshot>): UsageTotals {
  const totals: UsageTotals = { participants: 0, active_ms: 0, input_tokens: 0, output_tokens: 0, tokens: 0, cost_usd: 0 };
  for (const snapshot of snapshots) {
    totals.participants += 1;
    totals.active_ms += snapshot.active_ms;
    totals.input_tokens += snapshot.input_tokens;
    totals.output_tokens += snapshot.output_tokens;
    totals.cost_usd += snapshot.cost_usd;
  }
  totals.tokens = totals.input_tokens + totals.output_tokens;
  totals.cost_usd = roundCost(totals.cost_usd);
  return totals;
}

// ── Cost estimation ─────────────────────────────────────────────

/** Longest table key contained in the model name wins, so "claude-sonnet-4" matches "claude-sonnet". */
export function ratesForModel(model: string | undefined, table: Record<string, TokenRates> = MODEL_TOKEN_RATES, fallback: TokenRates = DEFAULT_TOKEN_RATES): TokenRates {
  if (!model) return fallback;
  const needle = model.toLowerCase();
  let best: { key: string; rates: TokenRates } | undefined;
  for (const [key, rates] of Object.entries(table)) {
    if (needle.includes(key.toLowerCase()) && (!best || key.length > best.key.length)) best = { key, rates };
  }
  return best?.rates ?? fallback;
}

export function estimateCost(usage: Pick<UsageNumbers, "input_tokens" | "output_tokens">, rates: TokenRates): number {
  return roundCost((usage.input_tokens / 1_000_000) * rates.input_usd_per_mtok + (usage.output_tokens / 1_000_000) * rates.output_usd_per_mtok);
}

/** Rate estimate for one participant; a reported `cost_usd` (a real invoice) always wins. */
export function usageCost(snapshot: UsageSnapshot, table?: Record<string, TokenRates>, fallback?: TokenRates): number {
  if (snapshot.cost_usd > 0) return snapshot.cost_usd;
  return estimateCost(snapshot, ratesForModel(snapshot.model, table, fallback));
}

// ── Room reads (board -> rows -> totals) ────────────────────────

/** Seal a snapshot for the board key `usage.<participant>`. */
export async function sealUsage(snapshot: UsageSnapshot, joinSecret: string, roomId: string): Promise<string> {
  return sealForRoom(parseUsageSnapshot(snapshot), joinSecret, roomId);
}

/** Open a `usage.*` board value; null when it is not a seal this room can open, or not a valid snapshot. */
export async function openUsage(sealed: unknown, participantHint?: string, joinSecret = "", roomId = ""): Promise<UsageSnapshot | null> {
  // "jsk1:" is the room-seal prefix from crypto.ts; anything else was never sealed for this room.
  if (typeof sealed !== "string" || !sealed.startsWith("jsk1:")) return null;
  const value = await openRoomSeal(sealed, joinSecret, roomId).catch(() => null);
  return value === null ? null : coerceUsageSnapshot(value, participantHint);
}

/** Read every `usage.*` board key. `participants` adds rows for people who never reported. */
export async function usageRows(
  board: Record<string, BoardEntry>,
  options: { joinSecret: string; roomId: string; participants?: string[]; nowMs?: number; staleAfterMs?: number },
): Promise<UsageRow[]> {
  const { joinSecret, roomId, nowMs = Date.now(), staleAfterMs = USAGE_STALE_AFTER_MS } = options;
  const ids = new Set<string>();
  for (const key of Object.keys(board)) {
    const id = participantFromUsageKey(key);
    if (id) ids.add(id);
  }
  for (const id of options.participants ?? []) if (PARTICIPANT_ID.test(id)) ids.add(id);
  const rows = await Promise.all([...ids].sort().map(async (participant): Promise<UsageRow> => {
    const key = usageKey(participant);
    const entry = board[key];
    const snapshot = entry ? await openUsage(entry.value, participant, joinSecret, roomId) : null;
    return {
      participant,
      key,
      version: entry?.version ?? 0,
      // The key is the identity: a snapshot claiming somebody else still counts, but never under another name.
      snapshot: snapshot ? { ...snapshot, participant } : null,
      stale: snapshot === null || Date.parse(snapshot.updated_at) + staleAfterMs < nowMs,
    };
  }));
  return rows;
}

/** Per-participant rows plus the room total, the shape CLI and live view render. */
export async function roomUsage(
  board: Record<string, BoardEntry>,
  options: { joinSecret: string; roomId: string; participants?: string[]; nowMs?: number; staleAfterMs?: number },
): Promise<{ rows: UsageRow[]; totals: UsageTotals; reported: number; stale: number }> {
  const rows = await usageRows(board, options);
  const reported = rows.filter((row) => row.snapshot);
  return {
    rows,
    totals: usageTotals(reported.map((row) => row.snapshot as UsageSnapshot)),
    reported: reported.length,
    stale: rows.filter((row) => row.stale).length,
  };
}

// ── Formatting ──────────────────────────────────────────────────

/** "45s", "12m 30s", "2h 05m", "3d 04h" - compact enough for one table cell. */
export function formatActiveTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`;
}

/** "873", "12.3k", "1.24M". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return `${Math.round(value)}`;
  if (value < 1_000_000) return `${trimZero(value / 1000)}k`;
  if (value < 1_000_000_000) return `${trimZero(value / 1_000_000)}M`;
  return `${trimZero(value / 1_000_000_000)}B`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 1) return `$${trimZeros(usd.toFixed(4))}`;
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

/** "2h 05m active · 12.3k in / 4.5k out · $0.42", optionally prefixed with a label. */
export function formatUsage(usage: UsageNumbers, label?: string): string {
  const line = `${formatActiveTime(usage.active_ms)} active · ${formatTokens(usage.input_tokens)} in / ${formatTokens(usage.output_tokens)} out · ${formatCost(usage.cost_usd)}`;
  return label ? `${label}: ${line}` : line;
}

/** One row for the CLI and the live room view; `est` adds a rate-based estimate when no cost was reported. */
export function formatUsageRow(row: UsageRow, options: { table?: Record<string, TokenRates>; fallback?: TokenRates } = {}): string {
  if (!row.snapshot) return `${row.participant}: no usage reported`;
  const snapshot = row.snapshot;
  const cost = snapshot.cost_usd > 0 ? snapshot.cost_usd : estimateCost(snapshot, ratesForModel(snapshot.model, options.table, options.fallback));
  const model = snapshot.model ? ` · ${snapshot.model}` : "";
  return formatUsage({ ...snapshot, cost_usd: cost }, row.participant) + model + (row.stale ? " · stale" : "");
}

function pad(value: number): string { return value.toString().padStart(2, "0"); }
function trimZero(value: number): string { return trimZeros(value.toFixed(2)); }
function trimZeros(value: string): string { return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""); }
function roundCost(value: number): number { return Math.round(value * 1e6) / 1e6; }
