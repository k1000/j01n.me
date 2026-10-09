import type { InviteState, Participant, WebhookHook } from "../types";
import { publicParticipant } from "./participants";

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
  const hooks = invite.hooks;
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    // Filter by event type subscription (default: all events)
    if (hook.events && !hook.events.includes(event)) continue;

    const body = JSON.stringify({
      event,
      room_id: invite.roomId,
      room_name: invite.roomName,
      timestamp: new Date().toISOString(),
      ...payload,
      ...(payload.participant ? { participant: publicParticipant(payload.participant as Participant) } : {}),
    });

    // Fire-and-forget: don't await — DO stays alive long enough
    fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "j01n.me-webhook/1.0",
        "x-j01n-event": event,
        "x-j01n-room-id": invite.roomId,
      },
      body,
    }).catch(() => {
      /* fire-and-forget: hook delivery failures are silent */
    });
  }
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
