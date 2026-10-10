const MAX_ID_LENGTH = 64;
export const DEFAULT_MAX_PARTICIPANTS = 16;
export const MAX_MESSAGES = 200;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_BOARD_VALUE_BYTES = 64 * 1024;
export const INVITE_TTL_MS = 30 * 60 * 1000;
export const MIN_INVITE_TTL_MS = 60_000;
export const MAX_INVITE_TTL_MS = 3_600_000;
export const DEFAULT_EXTEND_MS = 5 * 60_000;
/**
 * Room-feature version the current clients speak. Clients send `x-j01n-client: <name>/<protocol>`; an older one gets an
 * `x-j01n-client-update` header with its update command. The SDK imports this constant;
 * scripts/generate-client-script.mjs injects it into the bundled helper script.
 */
export const CLIENT_PROTOCOL = 8;
export const CLIENT_UPDATE_COMMANDS: Record<string, string> = {
  helper: "curl -fsSL https://j01n.me/client/j01n.js -o .j01n/j01n.js",
  sdk: "pi install https://gitlab.com/k1000/j01n.me (Pi), or update @j01n/sdk from https://gitlab.com/k1000/j01n.me",
};
/** Any message keeps a room alive for at least this long. */
export const ACTIVE_ROOM_GRACE_MS = 10 * 60_000;

export function sanitizeId(value: string, maxLength = MAX_ID_LENGTH): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, maxLength);
}
