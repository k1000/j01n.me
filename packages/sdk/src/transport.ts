import { RoomApiError } from "./errors";
import type { Invite } from "./sdk";

/** Room-feature version this SDK speaks; bump with CLIENT_PROTOCOL in apps/web/src/constants.ts. */
export const SDK_CLIENT_PROTOCOL = 8;
let clientUpdateNotice: string | undefined;

/** The room's "please update" notice, if this SDK is older than the server's client protocol. */
export function getClientUpdateNotice(): string | undefined {
  return clientUpdateNotice;
}

export async function request<T>(
  url: string,
  invite: Invite,
  options: { method?: string; participantId?: string; body?: unknown } = {},
): Promise<T> {
  const token = invite.participant_token ?? invite.join_secret;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-j01n-client": `sdk/${SDK_CLIENT_PROTOCOL}` };
  if (options.participantId && token === invite.join_secret) headers["x-participant-id"] = options.participantId;
  const hasBody = options.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
  clientUpdateNotice = response.headers.get("x-j01n-client-update") ?? clientUpdateNotice;
  if (!response.ok) throw new RoomApiError(response.status, await response.text(), url);
  return (await response.json()) as T;
}
