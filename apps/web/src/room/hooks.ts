import type { InviteState, Participant, RoomMessage, WebhookHook } from "../types";
import { visibleTo } from "./messages";
import { activeParticipants, publicParticipant } from "./participants";

/**
 * Fire-and-forget dispatch of room events to registered webhook hooks.
 * Called alongside SSE event notifications. Returns nothing — failures
 * are silently swallowed.
 */
export function dispatchWebhooks(
  invite: InviteState,
  event: "message" | "board" | "participant",
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify({
    event,
    room_id: invite.roomId,
    room_name: invite.roomName,
    timestamp: new Date().toISOString(),
    ...payload,
    ...(payload.participant ? { participant: publicParticipant(payload.participant as Participant) } : {}),
  });

  for (const hook of invite.hooks ?? []) {
    // Filter by event type subscription (default: all events)
    if (hook.events && !hook.events.includes(event)) continue;
    postEvent(hook.url, event, invite.roomId, body);
  }

  // Participants who opted into push get only what they could read themselves, minus their own actions.
  const message = payload.message as RoomMessage | undefined;
  const actor = event === "message" ? message?.from : event === "board" ? payload.updated_by : payload.participant_id;
  for (const participant of activeParticipants(invite.participants)) {
    if (!participant.webhook_url || participant.id === actor) continue;
    if (message && !visibleTo(message, participant.id)) continue;
    postEvent(participant.webhook_url, event, invite.roomId, body);
  }
}

function postEvent(url: string, event: string, roomId: string, body: string): void {
  // Fire-and-forget: don't await — DO stays alive long enough
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "j01n.me-webhook/1.0",
      "x-j01n-event": event,
      "x-j01n-room-id": roomId,
    },
    body,
  }).catch(() => {
    /* fire-and-forget: hook delivery failures are silent */
  });
}

/**
 * Create a new webhook hook. Returns the created hook.
 */
export function createHook(
  invite: InviteState,
  url: string,
  events?: ("message" | "board" | "participant")[],
): { hook: WebhookHook; hooks: WebhookHook[] } {
  const hook: WebhookHook = {
    id: crypto.randomUUID(),
    url,
    events: events && events.length > 0 ? events : undefined,
    created_at: new Date().toISOString(),
  };
  const hooks = [...(invite.hooks ?? []), hook];
  return { hook, hooks };
}

/**
 * Delete a webhook hook by ID. Returns the updated hooks list, or undefined if not found.
 */
export function deleteHook(
  invite: InviteState,
  hookId: string,
): { hooks: WebhookHook[] } | undefined {
  const current = invite.hooks ?? [];
  const idx = current.findIndex((h) => h.id === hookId);
  if (idx === -1) return undefined;
  const hooks = [...current.slice(0, idx), ...current.slice(idx + 1)];
  return { hooks };
}
