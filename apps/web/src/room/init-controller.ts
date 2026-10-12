import { json } from "../format";
import type { InitPayload, InviteState } from "../types";
import { validateBoard, wrapInitialBoard } from "./board";
import { createInitialMessage } from "./messages";
import { createJoinedParticipant, generateParticipantToken } from "./participants";
import type { RoomStorage } from "./storage";

export class RoomInitController {
  constructor(private readonly storage: RoomStorage) {}

  async init(request: Request): Promise<Response> {
    const body = (await request.json()) as InitPayload;
    const existing = await this.storage.getInvite();
    const initResult = await this.buildState(body, existing);
    if (initResult instanceof Response) return initResult;
    await this.storage.putInvite(initResult.state);
    await this.storage.scheduleCleanup(body.expiresAt);
    return json({ ok: true, ...(initResult.participantToken ? { participant_token: initResult.participantToken } : {}) });
  }

  private async buildState(
    body: InitPayload,
    existing: InviteState | undefined,
  ): Promise<{ state: InviteState; participantToken?: string } | Response> {
    if (existing && existing.phase !== "closed") {
      return json({ error: "invite already exists" }, 409);
    }
    const firstMessage = body.firstMessage ? [createInitialMessage(body)] : [];
    const board = wrapInitialBoard(body.initialBoard, body.hostId);
    if (board instanceof Response) return board;
    const validation = validateBoard(body.boardSchema, board);
    if (validation) return validation;

    // Auto-join the host when hostPublicKey is provided.
    const participants: Record<string, import("../types").Participant> = {};
    let participantToken: string | undefined;
    let tokenIndex: InviteState["tokenIndex"];
    if (body.hostPublicKey) {
      const token = await generateParticipantToken(body.roomId, body.hostId);
      participantToken = token.token;
      tokenIndex = { [token.tokenOnlyHash]: body.hostId };
      participants[body.hostId] = createJoinedParticipant(body.hostId, {
        public_key: body.hostPublicKey,
        model: body.hostModel,
      }, token.hash);
    }

    const { initialBoard: _ib, firstMessage: _fm, hostPublicKey: _hpk, hostModel: _hm, ...stateToStore } = body;
    const state = {
      ...stateToStore,
      nextSeq: firstMessage.length,
      participants,
      messages: firstMessage,
      board,
      ...(tokenIndex ? { tokenIndex } : {}),
    } satisfies InviteState;
    return { state, participantToken };
  }
}
