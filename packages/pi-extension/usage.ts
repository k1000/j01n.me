// Automatic usage self-reporting for Pi workers.
//
// Pi logs every session as JSONL under ~/.pi/agent/sessions/--<cwd slug>--/<session id>.jsonl. Each assistant
// turn carries `message.usage`, so a worker can total its own tokens and wall time without asking anyone.
// Reports go through RoomClient.reportUsage(), which seals a UsageDelta into the board key `usage.<participant>`:
// the room sees a seal it cannot open, and only holders of the join secret can read the numbers.
//
// Privacy rules this module must keep:
// - the delta is the difference since the last report, so nothing accumulates twice;
// - notes returned to the caller never contain absolute paths, session ids, file names or the join secret;
// - the "already reported" marker lives outside the repository (J01N_USAGE_DIR, else ~/.local/state/j01n/usage).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RoomClient } from "@j01n/sdk";
import {
  MAX_USAGE_DELTA_ACTIVE_MS,
  MAX_USAGE_DELTA_COST_USD,
  MAX_USAGE_DELTA_TOKENS,
  estimateCost,
  formatUsage,
  parseUsageSnapshot,
  ratesForModel,
  usageDeltaBetween,
} from "@j01n/sdk/metrics";
import type { TokenRates, UsageDelta, UsageSnapshot } from "@j01n/sdk/metrics";

/** How often a claimed task refreshes its usage row while the worker keeps working. */
export const USAGE_REPORT_INTERVAL_MS = 2 * 60 * 1000;
/** Give up on a heartbeat after this many consecutive failures (a left or expired room, offline host). */
export const USAGE_TIMER_MAX_FAILURES = 3;

/** Cumulative counters of the newest Pi session log for one directory. */
export interface SessionUsage {
  /** Prompt side: `usage.input` + cache reads + cache writes (everything the model was given). */
  inputTokens: number;
  /** Completion side: `usage.output` + reasoning tokens. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `usage.totalTokens` as Pi counted it. */
  totalTokens: number;
  /** Wall clock between the first and last assistant turn. */
  activeMs: number;
  /** Cost as logged by Pi; 0 on subscription plans, which is why an estimate is kept too. */
  loggedCostUsd: number;
  /** Rate-based estimate for these tokens. */
  estimatedCostUsd: number;
  /** True when the reported cost is the estimate, not an invoice. */
  costEstimated: boolean;
  turns: number;
  model?: string;
  provider?: string;
  /** Only for tests and diagnostics: a stable name, never a path. */
  file?: string;
}

export interface UsageReadOptions {
  cwd?: string;
  /** Session root; defaults to J01N_PI_SESSIONS_DIR, else ~/.pi/agent/sessions. */
  sessionsDir?: string;
  /** Rate table overrides for the cost estimate. */
  table?: Record<string, TokenRates>;
  fallback?: TokenRates;
}

export interface UsageReportOutcome {
  reported: boolean;
  /** One line for the local operator; free of paths, session ids and secrets. */
  note: string;
  delta?: UsageDelta;
  /** True when the report itself failed (network, sealed write), as opposed to "nothing to say". */
  failed?: boolean;
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const roundCost = (value: number): number => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, max: number): number => Math.min(value, max);

/** Pi's directory name for a checkout: the absolute path with every separator turned into a dash. */
export function sessionSlug(cwd: string): string {
  return `--${resolve(cwd).replace(/[\\/]+/g, "-").replace(/^-+/, "")}--`;
}

export function sessionDirFor(options: UsageReadOptions = {}): string {
  const root = options.sessionsDir ?? process.env.J01N_PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
  return join(root, sessionSlug(options.cwd ?? process.cwd()));
}

/** Newest session log in a directory: by mtime, then by name (names start with the session's ISO timestamp). */
export function newestSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  let best: { name: string; mtimeMs: number } | undefined;
  for (const name of files) {
    let mtimeMs = 0;
    try { mtimeMs = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && name > best.name)) best = { name, mtimeMs };
  }
  return best ? join(dir, best.name) : null;
}

function stampMs(record: Record<string, unknown>): number | undefined {
  const outer = record.timestamp;
  if (typeof outer === "string" && !Number.isNaN(Date.parse(outer))) return Date.parse(outer);
  const inner = (record.message as Record<string, unknown> | undefined)?.timestamp;
  if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  return undefined;
}

/** Total the newest session log. Null when this directory has no Pi log (a plain shell, or another harness). */
export function readSessionUsage(options: UsageReadOptions = {}): SessionUsage | null {
  const dir = sessionDirFor(options);
  const file = newestSessionFile(dir);
  if (!file) return null;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }

  const usage: SessionUsage = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
    activeMs: 0, loggedCostUsd: 0, estimatedCostUsd: 0, costEstimated: false, turns: 0,
  };
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; } // a half-written last line while Pi is still working
    if (!record || typeof record !== "object") continue;
    const row = record as Record<string, unknown>;
    const message = row.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;
    const turn = message.usage as Record<string, unknown> | undefined;
    if (!turn || typeof turn !== "object") continue;
    const cacheRead = finite(turn.cacheRead);
    const cacheWrite = finite(turn.cacheWrite);
    usage.inputTokens += finite(turn.input) + cacheRead + cacheWrite;
    usage.outputTokens += finite(turn.output) + finite(turn.reasoning);
    usage.cacheReadTokens += cacheRead;
    usage.cacheWriteTokens += cacheWrite;
    usage.totalTokens += finite(turn.totalTokens);
    usage.loggedCostUsd += finite((turn.cost as Record<string, unknown> | undefined)?.total);
    if (typeof message.model === "string" && message.model) usage.model = message.model;
    if (typeof message.provider === "string" && message.provider) usage.provider = message.provider;
    usage.turns += 1;
    const at = stampMs(row);
    if (at !== undefined) {
      firstMs = firstMs === undefined ? at : Math.min(firstMs, at);
      lastMs = lastMs === undefined ? at : Math.max(lastMs, at);
    }
  }
  if (!usage.turns) return null;

  usage.activeMs = Math.max(0, (lastMs ?? 0) - (firstMs ?? 0));
  usage.estimatedCostUsd = estimateCost(
    { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    ratesForModel(usage.model, options.table, options.fallback),
  );
  usage.costEstimated = usage.loggedCostUsd <= 0;
  usage.file = file.split(/[\\/]/).pop();
  return usage;
}

/** The cumulative snapshot these counters describe, in the shape `usage.<participant>` stores. */
export function snapshotForUsage(participant: string, usage: SessionUsage, at = new Date().toISOString()): UsageSnapshot {
  return {
    participant,
    reports: 0,
    updated_at: at,
    active_ms: Math.round(usage.activeMs),
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_usd: usage.costEstimated ? usage.estimatedCostUsd : usage.loggedCostUsd,
    ...(usage.model ? { model: usage.model } : {}),
    ...(usage.provider ? { provider: usage.provider } : {}),
  };
}

/**
 * What to report since the last time: counters are cumulative in the log, so subtract the last snapshot.
 * A negative difference means the log rotated to a new session file; that turn is skipped (clamped) and the
 * marker below makes the next report measure from the new file instead.
 */
export function deltaFromUsage(participant: string, last: UsageSnapshot | null, usage: SessionUsage, at = new Date().toISOString()): UsageDelta {
  const current = snapshotForUsage(participant, usage, at);
  const delta = usageDeltaBetween(last, current);
  delta.active_ms = clamp(delta.active_ms ?? 0, MAX_USAGE_DELTA_ACTIVE_MS);
  delta.input_tokens = clamp(delta.input_tokens ?? 0, MAX_USAGE_DELTA_TOKENS);
  delta.output_tokens = clamp(delta.output_tokens ?? 0, MAX_USAGE_DELTA_TOKENS);
  // Cost per delta, not the difference of two estimates: rates can change between reports, and an invoice (if the
  // harness logs one) still wins because the snapshot carries it.
  delta.cost_usd = usage.costEstimated
    ? roundCost(estimateCost({ input_tokens: delta.input_tokens, output_tokens: delta.output_tokens }, ratesForModel(usage.model)))
    : roundCost(clamp(delta.cost_usd ?? 0, MAX_USAGE_DELTA_COST_USD));
  return delta;
}

function hasCounters(delta: UsageDelta): boolean {
  return !!((delta.active_ms ?? 0) || (delta.input_tokens ?? 0) || (delta.output_tokens ?? 0) || (delta.cost_usd ?? 0));
}

function stateKey(client: RoomClient): string {
  return createHash("sha256").update(`${client.invite.room_url}\0${client.participantId}`).digest("hex").slice(0, 32);
}

/** Outside the repository, so a worker never commits its own counters. */
function stateDir(): string {
  const dir = process.env.J01N_USAGE_DIR ?? join(homedir(), ".local", "state", "j01n", "usage");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function usageMarkerPath(client: RoomClient): string {
  return join(stateDir(), `last-report-${stateKey(client)}.json`);
}

interface Marker {
  /** The session log these counters came from: a new log (Pi restart, resume) starts counting again. */
  session?: string;
  snapshot: UsageSnapshot;
}

const memory = new Map<string, Marker>();

/** A marker from another session log does not describe this one; without a session name, report the last counters. */
function markerSnapshot(marker: Marker, session?: string): UsageSnapshot | null {
  return marker.session === undefined || session === undefined || marker.session === session ? marker.snapshot : null;
}

/** The counters of the last accepted report; memory first, then the dotfile (a fresh Pi process resumes). */
export function loadLastReport(client: RoomClient, session?: string): UsageSnapshot | null {
  const key = stateKey(client);
  const cached = memory.get(key);
  if (cached) return markerSnapshot(cached, session);
  const file = usageMarkerPath(client);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    // An old marker is a bare snapshot; accept both shapes rather than double-counting the reader.
    const entry: Marker = (raw as Marker)?.snapshot ? (raw as Marker) : { snapshot: raw as UsageSnapshot };
    entry.snapshot = parseUsageSnapshot(entry.snapshot, client.participantId);
    memory.set(key, entry);
    return markerSnapshot(entry, session);
  } catch {
    return null; // a corrupt marker only means "report the whole session again"
  }
}

export function saveLastReport(client: RoomClient, snapshot: UsageSnapshot, session?: string): void {
  const key = stateKey(client);
  const marker = usageMarkerPath(client);
  const entry: Marker = { ...(session ? { session } : {}), snapshot };
  memory.set(key, entry);
  try {
    const temporary = `${marker}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
    renameSync(temporary, marker);
  } catch { /* the in-memory marker still prevents double reporting in this process */ }
}

function noteFor(delta: UsageDelta, usage: SessionUsage): string {
  const line = formatUsage({
    active_ms: delta.active_ms ?? 0,
    input_tokens: delta.input_tokens ?? 0,
    output_tokens: delta.output_tokens ?? 0,
    cost_usd: delta.cost_usd ?? 0,
  }, "usage");
  return usage.costEstimated ? `${line} (rate estimate)` : line;
}

/** True when this session can seal a report; a "resume-only" client has no room key to seal with. */
function canSeal(client: RoomClient): boolean {
  const secret = client.invite.join_secret;
  return typeof secret === "string" && secret.length > 0 && secret !== "resume-only";
}

/** Read the session log and report the delta since the last report. Never throws: a worker must not lose a done. */
export async function reportSessionUsage(client: RoomClient, options: UsageReadOptions & { usage?: SessionUsage | null } = {}): Promise<UsageReportOutcome> {
  const usage = options.usage === undefined ? readSessionUsage(options) : options.usage;
  if (!usage) return { reported: false, note: "usage: no Pi session log for this directory, nothing to report" };
  if (!canSeal(client)) return { reported: false, note: "usage: this session has no room key; join with the room link to report" };

  const at = new Date().toISOString();
  const delta = deltaFromUsage(client.participantId, loadLastReport(client, usage.file ?? undefined), usage, at);
  if (!hasCounters(delta)) return { reported: false, note: "usage: no new activity since the last report" };

  const row = await client.reportUsage(delta);
  saveLastReport(client, { ...snapshotForUsage(client.participantId, usage, at), reports: row.snapshot?.reports ?? 1 }, usage.file ?? undefined);
  return { reported: true, note: noteFor(delta, usage), delta };
}

interface UsageHeartbeat {
  timer: ReturnType<typeof setInterval>;
  failures: number;
}

const heartbeats = new Map<string, UsageHeartbeat>();

export interface UsageTimerOptions extends UsageReadOptions {
  /** Stop the heartbeat when the task is no longer claimed by this participant. */
  stillClaimed?: () => Promise<boolean>;
  intervalMs?: number;
  /** Hook for tests and for the caller's own logging. */
  onReport?: (outcome: UsageReportOutcome) => void;
}

/** Refresh the usage row every ~2 minutes while a task is claimed, so a long task is not invisible until done. */
export function startUsageTimer(client: RoomClient, options: UsageTimerOptions = {}): boolean {
  const key = stateKey(client);
  stopUsageTimer(client);
  let stopped = false;
  const stop = () => {
    stopped = true;
    const heartbeat = heartbeats.get(key);
    if (heartbeat) clearInterval(heartbeat.timer);
    heartbeats.delete(key);
  };
  const run = async () => {
    if (stopped) return;
    if (options.stillClaimed) {
      let claimed = true;
      try { claimed = await options.stillClaimed(); } catch { claimed = true; } // a flaky read must not silence reporting
      if (!claimed || stopped) { stop(); return; }
    }
    let outcome: UsageReportOutcome;
    try { outcome = await reportSessionUsage(client, options); }
    catch { outcome = { reported: false, failed: true, note: "usage: report failed; run the helper usage command to retry" }; }
    if (stopped) return;
    const heartbeat = heartbeats.get(key);
    if (outcome.reported) { if (heartbeat) heartbeat.failures = 0; }
    else if (outcome.failed && heartbeat) {
      heartbeat.failures += 1;
      if (heartbeat.failures >= USAGE_TIMER_MAX_FAILURES) { stop(); return; }
    }
    options.onReport?.(outcome);
  };
  const timer = setInterval(() => void run(), options.intervalMs ?? USAGE_REPORT_INTERVAL_MS);
  // Never hold the process open just to report usage.
  (timer as unknown as { unref?: () => void }).unref?.();
  heartbeats.set(key, { timer, failures: 0 });
  return true;
}

export function stopUsageTimer(client: RoomClient): boolean {
  const key = stateKey(client);
  const heartbeat = heartbeats.get(key);
  if (!heartbeat) return false;
  clearInterval(heartbeat.timer);
  heartbeats.delete(key);
  return true;
}

export function usageTimerActive(client?: RoomClient): boolean {
  if (!client) return heartbeats.size > 0;
  return heartbeats.has(stateKey(client));
}

/** Stop every heartbeat (used when leaving or closing a room). */
export function stopAllUsageTimers(): number {
  const count = heartbeats.size;
  for (const heartbeat of heartbeats.values()) clearInterval(heartbeat.timer);
  heartbeats.clear();
  return count;
}
