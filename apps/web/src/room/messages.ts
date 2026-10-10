import { MAX_BODY_BYTES, MAX_MESSAGES } from "../constants";
import { json } from "../format";
import type { InitPayload, InviteState, Recipient, RoomMessage } from "../types";
import { validateEncryptedProtocol } from "./message-encryption";
import { isParticipantJoined } from "./participants";

const ENCODER = new TextEncoder();

interface ReadOptions {
  after: number;
  includeSelf: boolean;
  mode: "recent" | "all";
}

export function parseReadOptions(request: Request, body: Record<string, unknown>, invite: InviteState, participantId: string): ReadOptions {
  const url = new URL(request.url);
  const mode = body.all === true || url.searchParams.get("view") === "all" ? "all" : "recent";
  const explicitAfter = body.after ?? url.searchParams.get("after");
  const lastReadSeq = invite.participants[participantId]?.last_read_seq ?? 0;
  return {
    after: mode === "all" ? 0 : Number(explicitAfter ?? lastReadSeq),
    includeSelf: !!body.include_self || url.searchParams.get("include_self") === "true",
    mode,
  };
}

export function buildReadResponse(invite: InviteState, participantId: string, messages: RoomMessage[], options: ReadOptions) {
  return {
    participant_id: participantId,
    mode: options.mode,
    cursor: invite.nextSeq,
    oldest_seq: invite.messages[0]?.seq ?? 0,
    retention: { max_messages: MAX_MESSAGES },
    messages,
  };
}

export function createSentMessage(body: Record<string, unknown>, participantId: string, invite: InviteState): { message: RoomMessage; messages: RoomMessage[]; seq: number } | Response {
  if (ENCODER.encode(JSON.stringify(body.body ?? {})).length > MAX_BODY_BYTES) return json({ error: "message body too large" }, 413);
  const to: Recipient = (body.to as Recipient) ?? "all";
  if (!validRecipient(invite, to)) return json({ error: "recipient not joined" }, 404);
  const encryptionValidation = validateEncryptedProtocol(body, participantId, to, invite);
  if (encryptionValidation) return encryptionValidation;
  const seq = invite.nextSeq + 1;
  const message = createRoomMessage(body, participantId, to, seq);
  const messages = [...invite.messages, message].slice(-MAX_MESSAGES);
  return { message, messages, seq };
}

export function createRoomMessage(body: Record<string, unknown>, participantId: string, to: Recipient, seq: number): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq,
    from: participantId,
    to,
    reply_to: (body.reply_to as string) ?? null,
    intent: (body.intent as string) ?? "notify",
    priority: (body.priority as string) ?? "normal",
    body: (body.body as unknown) ?? {},
    created_at: new Date().toISOString(),
    ...(body.expects_reply === true ? { expects_reply: { due_at: new Date(Date.now() + replyByMinutes(body.reply_by_minutes) * 60_000).toISOString() } } : {}),
  };
}

function replyByMinutes(value: unknown): number {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(Math.round(minutes), 24 * 60) : 30;
}

/**
 * Questions still waiting for an answer. A direct (or list) question is open for each addressee until that addressee
 * sends a message with reply_to = its id; a question to `all` is closed by any reply from someone other than the asker.
 */
export function openAsks(invite: InviteState): Array<{ ask_id: string; seq: number; from: string; owed_by: string; due_at: string; overdue: boolean }> {
  const repliers = new Map<string, Set<string>>();
  for (const m of invite.messages) {
    if (!m.reply_to) continue;
    if (!repliers.has(m.reply_to)) repliers.set(m.reply_to, new Set());
    repliers.get(m.reply_to)!.add(m.from);
  }
  const now = Date.now();
  return invite.messages.filter((m) => m.expects_reply).flatMap((ask) => {
    const replied = repliers.get(ask.id) ?? new Set<string>();
    const owedBy = ask.to === "all"
      ? ([...replied].some((id) => id !== ask.from) ? [] : ["anyone"])
      : (Array.isArray(ask.to) ? ask.to : [ask.to]).filter((id) => !replied.has(id));
    return owedBy.map((owed) => ({ ask_id: ask.id, seq: ask.seq, from: ask.from, owed_by: owed, due_at: ask.expects_reply!.due_at, overdue: Date.parse(ask.expects_reply!.due_at) < now }));
  });
}

/** Open questions this participant owes (addressed to it, or to `all` and asked by someone else), newest first, at most 20. */
export function helpNeeded(invite: InviteState, now = Date.now()) {
  const byId = new Map(invite.messages.map((message) => [message.id, message]));
  return openAsks(invite).filter((ask) => {
    const message = byId.get(ask.ask_id);
    if (!message) return false;
    const due = Date.parse(ask.due_at);
    const period = Math.max(60_000, due - Date.parse(message.created_at));
    return now >= due + (ask.from === invite.hostId ? 0 : period);
  }).map((ask) => ({ ...ask, overdue_since: ask.due_at, escalated_to: "owner" as const }));
}

/** The next pending notification for a question; never stores or exposes its encrypted body. */
export function nextAskEscalation(invite: InviteState, now = Date.now()) {
  const notices = new Set(invite.messages.filter((m) => m.intent === "help.overdue" || m.intent === "help.needed")
    .map((m) => `${m.intent}:${(m.body as { ask_id?: string }).ask_id}:${(m.body as { owed_by?: string }).owed_by}`));
  const byId = new Map(invite.messages.map((m) => [m.id, m]));
  const pending = openAsks(invite).flatMap((ask) => {
    const original = byId.get(ask.ask_id);
    if (!original) return [];
    const due = Date.parse(ask.due_at);
    const period = Math.max(60_000, due - Date.parse(original.created_at));
    const owner = Object.values(invite.participants).find((p) => p.role === "owner" && !p.left_at)?.id;
    const stages = ask.from === invite.hostId ? [] : [{ at: due, to: invite.hostId, intent: "help.overdue" }];
    if (owner) stages.push({ at: due + (ask.from === invite.hostId ? 0 : period), to: owner, intent: "help.needed" });
    return stages.filter((stage) => !notices.has(`${stage.intent}:${ask.ask_id}:${ask.owed_by}`))
      .map((stage) => ({ ...stage, ask_id: ask.ask_id, from: ask.from, owed_by: ask.owed_by, due_at: ask.due_at }));
  });
  return pending.sort((a, b) => Math.max(a.at, now) - Math.max(b.at, now))[0];
}

export function openAsksFor(invite: InviteState, participantId: string) {
  const byId = new Map(invite.messages.map((m) => [m.id, m]));
  return openAsks(invite)
    .filter((ask) => ask.owed_by === participantId || (ask.owed_by === "anyone" && ask.from !== participantId))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 20)
    .map((ask) => ({ ...ask, message: byId.get(ask.ask_id)! }));
}

export function createInitialMessage(body: InitPayload): RoomMessage {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    from: body.hostId,
    to: "all",
    reply_to: null,
    intent: "room_purpose",
    priority: "normal",
    body: body.firstMessage,
    created_at: new Date().toISOString(),
  };
}

export function isReadableMessage(message: RoomMessage, participantId: string, options: ReadOptions): boolean {
  return message.seq > options.after && (options.includeSelf || message.from !== participantId) && visibleTo(message, participantId);
}

export function visibleTo(message: RoomMessage, participantId: string): boolean {
  if (message.to === "all" || message.from === participantId) return true;
  if (Array.isArray(message.to)) return message.to.includes(participantId);
  return message.to === participantId;
}

function validRecipient(invite: InviteState, to: Recipient): boolean {
  if (to === "all") return true;
  const recipients = Array.isArray(to) ? to : [to];
  return recipients.every((id) => isParticipantJoined(invite.participants, id));
}
