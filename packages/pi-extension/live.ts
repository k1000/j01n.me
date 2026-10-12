// Live mode for joined rooms (on by default, `/j01n live off` stops it):
// - delivery: a background wait per room; new messages are injected into the conversation in one batch per wait.
//   Only direct requests and task.unblocked notices wake the agent; broadcasts are digested without a turn.
// - presence: the agent's tool activity becomes its room status ("editing src/a.ts", "running tests"), sent at most
//   every 15 s and only when it changed. Status updates never wake anyone.
// - reservations: edits/writes to a path another participant reserved (same repo) are blocked, naming the holder.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listReservations, reservationFor, RESERVATIONS_KEY } from "@j01n/sdk";
import type { Reservation, RoomClient } from "@j01n/sdk";
import type { RoomMessage } from "@j01n/sdk/types";
import { activeRoomClients, currentRepo, processRoomParticipant, replyHint, repoPath } from "./commands";

const BATCH_MS = 2_000;
const PRESENCE_MS = 15_000;
const RESERVATIONS_TTL_MS = 10_000;
const STUCK_MS = 15 * 60_000;

const roomKey = (client: RoomClient) => `${client.invite.room_url}:${client.participantId}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One injected text for a batch of new messages (null when there is nothing worth showing). */
export function formatBatch(client: RoomClient, messages: RoomMessage[]): { text: string; wake: boolean } | null {
  const shown = messages.filter((m) => m.from !== client.participantId && m.intent !== "key.exchange");
  if (shown.length === 0) return null;
  const bodyText = (m: RoomMessage) => {
    if (m.decrypt_error) return `(could not decrypt: ${m.decrypt_error})`;
    const body = m.body as { text?: unknown } | undefined;
    return typeof body?.text === "string" ? body.text : JSON.stringify(m.body);
  };
  const lines = shown.map((m) => {
    // Special format for task.assigned direct to self
    if (m.intent === "task.assigned" && (m.to === client.participantId || (Array.isArray(m.to) && m.to.includes(client.participantId)))) {
      const body = m.body as { task?: { id?: string; title?: string }; task_id?: string; title?: string } | undefined;
      const taskId = body?.task?.id ?? body?.task_id ?? "";
      const title = body?.task?.title ?? body?.title ?? "";
      const titlePart = title ? `: ${title}` : "";
      return `Task ${taskId} assigned to you${titlePart}\n  ready: j01n claim ${taskId}`;
    }
    // Special format for task.unblocked with assigned == self
    if (m.intent === "task.unblocked" && (m.body as { assigned?: unknown })?.assigned === client.participantId) {
      const body = m.body as { task_id?: string; blocked_by?: string[]; summary?: string; commit?: string };
      const taskId = body?.task_id ?? "";
      const predecessor = body?.blocked_by?.[0] ?? "";
      const summary = body?.summary ?? "";
      const commit = body?.commit ?? "";
      const commitShort = commit.length > 7 ? commit.slice(0, 7) : commit;
      const predecessorPart = predecessor && summary ? `\n  predecessor: ${predecessor} — ${summary}${commitShort ? ` (commit ${commitShort})` : ""}` : "";
      return `Task ${taskId} unblocked and assigned to you${predecessorPart}\n  ready: j01n claim ${taskId}`;
    }
    // Generic format
    return m.from === "system"
      ? `· ${bodyText(m)}`
      : `**${m.from}**${m.kind ? ` [${m.kind}]` : ""}${m.expects_reply ? " (asks for a reply)" : ""}: ${bodyText(m)}\n  reply: ${replyHint(m)}`;
  });
  return {
    text: `j01n room ${client.invite.room_id} · ${shown.length} new:\n${lines.join("\n")}`,
    wake: shown.some((m) => {
      // Direct message (not from system) to self
      if (m.from !== "system" && (m.to === client.participantId || (Array.isArray(m.to) && m.to.includes(client.participantId)))) return true;
      // task.assigned direct to self
      if (m.intent === "task.assigned" && (m.to === client.participantId || (Array.isArray(m.to) && m.to.includes(client.participantId)))) return true;
      // task.unblocked with assigned == self
      if (m.intent === "task.unblocked" && (m.body as { assigned?: unknown })?.assigned === client.participantId) return true;
      return false;
    }),
  };
}

/** What the agent is doing, from a tool call; undefined for tools that say nothing useful. */
export function activityOf(toolName: string, input: Record<string, unknown>, root: string): string | undefined {
  if ((toolName === "edit" || toolName === "write") && typeof input.path === "string") return `editing ${repoPath(root, input.path)}`;
  if (toolName === "bash" && typeof input.command === "string") {
    if (/\bgit\s+commit\b/.test(input.command)) return "committing";
    if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/.test(input.command)) return "running tests";
    return "running commands";
  }
  if (["read", "grep", "find", "ls"].includes(toolName)) return "exploring the code";
  return undefined;
}

/** The profile patch announcing our current model, or undefined when the room row already matches
 * (dedupe prevents a write per presence tick). Empty model => nothing to announce. */
export function modelPatchFor(
  current: { model?: string; provider?: string },
  mine: { model?: string; provider?: string } | undefined,
): { model: string; provider?: string } | undefined {
  if (!current.model) return undefined;
  if (mine?.model === current.model && (mine?.provider ?? "") === (current.provider ?? "")) return undefined;
  return { model: current.model, ...(current.provider ? { provider: current.provider } : {}) };
}

/** A spawned peer must not operate using another agent's saved room session in a shared checkout. */
export function liveClientsForProcess(clients: RoomClient[], env: Record<string, string | undefined> = process.env): RoomClient[] {
  if (env.J01N_PEER_PARTICIPANT_ID) return clients.filter((client) => client.participantId === env.J01N_PEER_PARTICIPANT_ID && client.invite.room_id === env.J01N_PEER_ROOM_ID);
  return clients.filter((client) => {
    const selected = processRoomParticipant(client.invite.room_url);
    return selected ? client.participantId === selected : !clients.some((other) => other !== client && other.invite.room_url === client.invite.room_url && other.participantId !== client.participantId);
  });
}

/** Without a process-scoped identity, two actors in one checkout cannot both truthfully announce this Pi model. */
export function modelAnnounceClients(clients: RoomClient[]): RoomClient[] {
  return liveClientsForProcess(clients);
}

export function registerLive(pi: ExtensionAPI): { refresh(): Promise<void>; setEnabled(on: boolean): string } {
  let enabled = true;
  const loops = new Set<string>();
  let clients: RoomClient[] = [];
  let notify: ((message: string, level: "info" | "warning" | "error") => void) | undefined;
  const warnedIdentity = new Set<string>();

  async function refresh(): Promise<void> {
    const saved = enabled ? await activeRoomClients() : [];
    clients = liveClientsForProcess(saved);
    for (const client of saved) {
      const room = client.invite.room_id;
      if (saved.some((other) => other !== client && other.invite.room_url === client.invite.room_url && other.participantId !== client.participantId) && !clients.some((selected) => selected.invite.room_url === client.invite.room_url) && !warnedIdentity.has(room)) {
        warnedIdentity.add(room);
        notify?.(`j01n: multiple local identities in room ${room}; run /j01n use ${room} <your-id> to select one for this Pi process`, "warning");
      }
    }
    for (const client of clients) if (!loops.has(roomKey(client))) void deliver(client);
    await announceModel();
  }

  async function deliver(client: RoomClient): Promise<void> {
    const key = roomKey(client);
    loops.add(key);
    try {
      while (enabled && clients.some((c) => roomKey(c) === key)) {
        const woke = await client.wait({ timeoutSeconds: 50 }).catch(async () => { await sleep(5_000); return { timeout: true as const }; });
        if (!enabled || !clients.some((c) => roomKey(c) === key)) break;
        if (woke.timeout) continue;
        await sleep(BATCH_MS); // let a burst arrive, then inject it once
        const messages = await client.read();
        if (messages.some((m) => m.intent === "board.changed" && RESERVATIONS_KEY in ((m.body as { changes?: object })?.changes ?? {}))) reservationCache.delete(key);
        const batch = formatBatch(client, messages);
        if (!batch) continue;
        pi.sendMessage({ customType: "j01n", content: batch.text, display: true, details: { room: client.invite.room_id } },
          batch.wake ? { triggerTurn: true, deliverAs: "steer" } : {});
      }
    } finally {
      loops.delete(key);
    }
  }

  // ── Presence ──
  let state: "free" | "busy" = "free";
  let activity = "idle";
  let sent = "";
  let lastSent = 0;
  async function flushPresence(force = false): Promise<void> {
    const now = Date.now();
    if (!enabled || `${state}|${activity}` === sent || (!force && now - lastSent < PRESENCE_MS)) return;
    sent = `${state}|${activity}`;
    lastSent = now;
    await Promise.all(clients.map((c) => c.updateStatus(state, activity).catch(() => undefined)));
  }
  const presenceTimer = setInterval(() => { void flushPresence(); void warnStuck(); }, PRESENCE_MS);
  presenceTimer.unref?.();

  // ── Reservations ──
  const reservationCache = new Map<string, { at: number; list: Reservation[] }>();
  async function reservationsOf(client: RoomClient): Promise<Reservation[]> {
    const cached = reservationCache.get(roomKey(client));
    if (cached && Date.now() - cached.at < RESERVATIONS_TTL_MS) return cached.list;
    const list = await listReservations(client).catch(() => cached?.list ?? []);
    reservationCache.set(roomKey(client), { at: Date.now(), list });
    return list;
  }

  const warned = new Set<string>();
  let lastStuckCheck = 0;
  async function warnStuck(): Promise<void> {
    if (!enabled || !notify || Date.now() - lastStuckCheck < 60_000) return;
    lastStuckCheck = Date.now();
    for (const client of clients) {
      const holders = new Set((await reservationsOf(client)).map((r) => r.by));
      const { participants = [] } = await client.participants().catch(() => ({ participants: [] }));
      for (const p of participants) {
        const quietFor = Date.now() - Date.parse(p.last_seen_at);
        if (p.id !== client.participantId && holders.has(p.id) && !p.left_at && quietFor > STUCK_MS && !warned.has(p.id)) {
          warned.add(p.id);
          notify(`j01n: ${p.id} holds file reservations but has been quiet for ${Math.round(quietFor / 60_000)} min`, "warning");
        }
      }
    }
  }

  let currentModel: { model?: string; provider?: string } = {};
  function readModel(ctx: { model?: { id?: string; name?: string; provider?: string } | undefined }): void {
    currentModel = ctx.model ? { model: ctx.model.id || ctx.model.name, provider: ctx.model.provider } : {};
  }
  async function announceModel(): Promise<void> {
    if (!enabled) return;
    await Promise.all(modelAnnounceClients(clients).map(async (c) => {
      try {
        const mine = (await c.team().catch(() => [])).find((t) => t.id === c.participantId);
        const patch = modelPatchFor(currentModel, mine);
        if (patch) await c.setProfile(patch);
      } catch { /* a room that refuses the update keeps its last profile */ }
    }));
  }

  pi.on("session_start", async (_event, ctx) => {
    notify = ctx.ui.notify.bind(ctx.ui);
    readModel(ctx);
    await refresh().catch(() => undefined);
  });
  pi.on("model_select", async (_event, ctx) => {
    readModel(ctx);
    await announceModel().catch(() => undefined);
  });
  pi.on("session_shutdown", async () => {
    enabled = false;
    clearInterval(presenceTimer);
  });
  pi.on("agent_start", async () => { state = "busy"; await flushPresence(true); });
  pi.on("agent_end", async () => { state = "free"; activity = "idle"; await flushPresence(true); });

  let repoInfo: { at: number; cwd: string; value: ReturnType<typeof currentRepo> } | undefined;
  const repoNow = () => {
    if (!repoInfo || repoInfo.cwd !== process.cwd() || Date.now() - repoInfo.at > 60_000) repoInfo = { at: Date.now(), cwd: process.cwd(), value: currentRepo() };
    return repoInfo.value;
  };

  pi.on("tool_call", async (event, ctx) => {
    notify = ctx.ui.notify.bind(ctx.ui);
    if (!enabled || clients.length === 0) return;
    const input = event.input as Record<string, unknown>;
    const { root, repo } = repoNow();
    activity = activityOf(event.toolName, input, root) ?? activity;
    void flushPresence();
    if ((event.toolName !== "edit" && event.toolName !== "write") || typeof input.path !== "string") return;
    const path = repoPath(root, input.path);
    for (const client of clients) {
      const checkout = (await client.team()).find((p) => p.id === client.participantId)?.checkout;
      const held = reservationFor(await reservationsOf(client), client.participantId, repo, path, checkout);
      if (held) {
        return {
          block: true,
          reason: `${path} is reserved by ${held.by}${held.reason ? ` (${held.reason})` : ""} in j01n room ${client.invite.room_id}.\n`
            + `Coordinate first: /j01n send ${held.by} <text> --expect-reply`,
        };
      }
    }
    return undefined;
  });

  // Commands such as join/leave change which rooms are active.
  pi.on("tool_result", async (event) => {
    if (event.toolName === "j01n") {
      await refresh().catch(() => undefined);
      await announceModel().catch(() => undefined);
    }
  });

  return {
    refresh,
    setEnabled(on: boolean) {
      enabled = on;
      void refresh();
      return on ? "live mode on: new room messages are delivered here, presence is shared, reserved paths are protected"
        : "live mode off: use /j01n wait to get messages";
    },
  };
}
