import type { BoardChange } from "@j01n/sdk/types";
import type { Participant, RoomMessage } from "../types";
import { visibleTo } from "./messages";
import { publicParticipant } from "./participants";

const ENCODER = new TextEncoder();

const SSE_HEARTBEAT_MS = 25_000;
const SSE_SWEEP_INTERVAL = 50;

interface EventSubscriber {
  participantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  includeSelf: boolean;
  includeAll: boolean;
}

/** One event a participant can see, as returned by wait(). */
export type WaitEvent =
  | { event: "message"; message: RoomMessage; last_seq: number }
  | { event: "board"; keys: string[]; updated_by: string; changes: Record<string, BoardChange> }
  | { event: "participant"; participant_id: string; action: string };

interface Waiter {
  participantId: string;
  wake: (event: WaitEvent | null) => void;
}

export interface RoomEventBus {
  subscribe(participantId: string, includeSelf: boolean, lastSeq: number, includeAll?: boolean): Response;
  /** Resolve with the next event this participant can see (never its own action), or null after timeoutMs. */
  wait(participantId: string, timeoutMs: number): Promise<WaitEvent | null>;
  notifyMessage(message: RoomMessage, lastSeq: number): void;
  /** `changes` (new value + version, or null when deleted) is passed to waiters so a board wake is actionable. */
  notifyBoard(keys: string | string[], updatedBy: string, changes?: Record<string, BoardChange>): void;
  notifyParticipant(participantId: string, action: string, participant?: Participant): void;
}

/** Who caused a message: its sender, or for a board.changed announcement the participant who changed the board. */
export function messageActor(message: RoomMessage): string {
  return message.intent === "board.changed" ? ((message.body as { updated_by?: string }).updated_by ?? message.from) : message.from;
}

export class RoomEvents implements RoomEventBus {
  private readonly subscribers = new Map<string, EventSubscriber>();
  private readonly waiters = new Set<Waiter>();
  private notificationCount = 0;

  wait(participantId: string, timeoutMs: number): Promise<WaitEvent | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        participantId,
        wake: (event) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(event);
        },
      };
      const timer = setTimeout(() => waiter.wake(null), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Wake every waiter that can see this event, except the participant who caused it. */
  private wakeWaiters(event: WaitEvent, actor: string, canSee: (participantId: string) => boolean = () => true): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.participantId !== actor && canSee(waiter.participantId)) waiter.wake(event);
    }
  }

  subscribe(participantId: string, includeSelf: boolean, lastSeq: number, includeAll = false): Response {
    let interval: ReturnType<typeof setInterval> | undefined;
    let subscriberId = "";
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriberId = crypto.randomUUID();
        this.subscribers.set(subscriberId, { participantId, controller, includeSelf, includeAll });
        enqueueSse(controller, "ready", { participant_id: participantId, last_seq: lastSeq });
        interval = setInterval(() => {
          try {
            enqueueSse(controller, "ping", { ts: new Date().toISOString() });
          } catch {
            if (interval) clearInterval(interval);
            if (subscriberId) this.subscribers.delete(subscriberId);
          }
        }, SSE_HEARTBEAT_MS);
      },
      cancel: () => {
        if (interval) clearInterval(interval);
        if (subscriberId) this.subscribers.delete(subscriberId);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  notifyMessage(message: RoomMessage, lastSeq: number): void {
    // A key announcement gives a waiter nothing to read; the next read picks the key up anyway.
    if (message.intent !== "key.exchange") {
      this.wakeWaiters({ event: "message", message, last_seq: lastSeq }, messageActor(message), (id) => visibleTo(message, id));
    }
    this.maybeSweep();
    for (const [id, subscriber] of this.subscribers) {
      if (!subscriber.includeAll) {
        if (!subscriber.includeSelf && message.from === subscriber.participantId) continue;
        if (!visibleTo(message, subscriber.participantId)) continue;
      }
      this.enqueueOrDelete(id, subscriber.controller, "message", { last_seq: lastSeq, message });
    }
  }

  notifyBoard(keys: string | string[], updatedBy: string, changes: Record<string, BoardChange> = {}): void {
    this.wakeWaiters({ event: "board", keys: Array.isArray(keys) ? keys : [keys], updated_by: updatedBy, changes }, updatedBy);
    this.maybeSweep();
    for (const [id, subscriber] of this.subscribers) {
      this.enqueueOrDelete(id, subscriber.controller, "board", { keys: Array.isArray(keys) ? keys : [keys], updated_by: updatedBy });
    }
  }

  notifyParticipant(participantId: string, action: string, participant?: Participant): void {
    // Joins, leaves and kicks wake waiters; status and key updates are not worth waking an agent for.
    if (action !== "updated") this.wakeWaiters({ event: "participant", participant_id: participantId, action }, participantId);
    this.maybeSweep();
    for (const [id, subscriber] of this.subscribers) {
      this.enqueueOrDelete(id, subscriber.controller, "participant", { participant_id: participantId, action, participant: publicParticipant(participant) });
    }
  }

  /**
   * Periodically sweep stale subscribers whose controllers silently
   * disconnected without triggering the cancel callback.
   */
  private maybeSweep(): void {
    if (++this.notificationCount % SSE_SWEEP_INTERVAL !== 0) return;
    for (const [id, subscriber] of this.subscribers) {
      try {
        enqueueSse(subscriber.controller, "ping", { ts: new Date().toISOString() });
      } catch {
        this.subscribers.delete(id);
      }
    }
  }

  private enqueueOrDelete(id: string, controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
    try {
      enqueueSse(controller, event, data);
    } catch {
      this.subscribers.delete(id);
    }
  }
}

function enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown): void {
  const json = JSON.stringify(data);
  const lines = json.split("\n").map((line) => `data: ${line}`).join("\n");
  controller.enqueue(ENCODER.encode(`event: ${event}\n${lines}\n\n`));
}
