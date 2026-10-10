import type { BoardChange } from "@j01n/sdk/types";
import { MAX_MESSAGES } from "../constants";
import type { InviteState } from "../types";
import type { RoomEventBus } from "./events";
import { dispatchWebhooks } from "./hooks";
import { createRoomMessage } from "./messages";
import type { RoomStorage } from "./storage";

/** Persist one system announcement and deliver its message and optional board change to listeners. */
export async function announceSystemMessage(
  storage: RoomStorage,
  events: RoomEventBus,
  invite: InviteState,
  intent: string,
  body: Record<string, unknown>,
  patch: Partial<InviteState> = {},
  boardChange?: { changes: Record<string, BoardChange>; updatedBy: string },
): Promise<InviteState> {
  const seq = invite.nextSeq + 1;
  const message = createRoomMessage({ intent, body }, "system", "all", seq);
  const updated = { ...invite, ...patch, nextSeq: seq, messages: [...invite.messages, message].slice(-MAX_MESSAGES) };
  await storage.putInvite(updated);
  if (boardChange) events.notifyBoard(Object.keys(boardChange.changes), boardChange.updatedBy, boardChange.changes);
  events.notifyMessage(message, seq);
  if (boardChange) dispatchWebhooks(updated, "board", { keys: Object.keys(boardChange.changes), updated_by: boardChange.updatedBy });
  else dispatchWebhooks(updated, "message", { type: "message", message, last_seq: seq });
  return updated;
}
