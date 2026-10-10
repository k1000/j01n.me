import type { RoomClient } from "./room-client";
import type { Workspace } from "./crypto";
import { listReservations, releasePaths, reservePaths } from "./reservations";

export function parseRoomBody(raw: string): unknown {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") return value;
  } catch { /* plain text */ }
  return { text: raw };
}

export function roomReplyHint(message: { id: string; from: string }, prefix = "/j01n"): string {
  return `${prefix} send ${message.from} <text> --reply-to ${message.id}`;
}

export function roomReplyHints<T extends { id: string; from: string; intent?: string }>(messages: T[], prefix = "/j01n"): Array<T & { reply?: string }> {
  return messages.map((m) => m.from === "system" || m.intent === "key.exchange" ? m : { ...m, reply: roomReplyHint(m, prefix) });
}

export async function waitRoom(client: RoomClient, timeoutSeconds?: number, filter: Parameters<RoomClient["wait"]>[0] = {}, prefix = "/j01n") {
  const woke = await client.wait({ ...filter, timeoutSeconds });
  if (woke.timeout) return { timeout: true };
  return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), messages: roomReplyHints(await client.read(), prefix) };
}

/** Shared room-command execution; entry points retain their own session, key-file and output policies. */
export async function runRoomCommand(client: RoomClient, cmd: string, rest: string[], options: {
  prefix?: string;
  readAll?: boolean;
  waitDefault?: number;
  parseWaitFallback?: boolean;
  recipientList?: boolean;
  webhookResult?: "helper";
  beforeSend?: () => Promise<void>;
  trimWaitFrom?: boolean;
} = {}): Promise<unknown> {
  const prefix = options.prefix ?? "/j01n";
  if (cmd === "send") {
    const [toRaw, ...args] = rest;
    const words: string[] = [];
    let andWait = false, replyTo: string | undefined, expectsReply = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--wait") andWait = true;
      else if (args[i] === "--expect-reply") expectsReply = true;
      else if (args[i] === "--reply-to") replyTo = args[++i];
      else words.push(args[i]);
    }
    if (!toRaw || !words.length) throw new Error("send needs: <to> <text or json_body> [--reply-to <id>] [--expect-reply] [--wait]");
    const to = options.recipientList && toRaw.includes(",") ? toRaw.split(",").map((s) => s.trim()) : options.recipientList ? toRaw.trim() : toRaw;
    await options.beforeSend?.();
    const sent = await client.send(to, parseRoomBody(words.join(" ")), { replyTo, expectsReply });
    return andWait ? { sent, ...await waitRoom(client, options.waitDefault, {}, prefix) } : sent;
  }
  if (cmd === "read" || cmd === "inbox") {
    return roomReplyHints(await client.read({ all: options.readAll || cmd === "inbox", includeSelf: true }), prefix);
  }
  if (cmd === "wait") {
    let timeout: string | undefined;
    const filter: Parameters<RoomClient["wait"]>[0] = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--from") filter.from = (rest[++i] ?? "").split(",").map((name) => options.trimWaitFrom ? name.trim() : name).filter(Boolean);
      else if (rest[i] === "--board") filter.board = rest[++i] ?? "";
      else if (rest[i] === "--no-system") filter.system = false;
      else timeout = rest[i];
    }
    const seconds = timeout === undefined ? options.waitDefault : options.parseWaitFallback ? Number(timeout) || options.waitDefault : Number(timeout);
    return waitRoom(client, seconds, filter, prefix);
  }
  if (cmd === "board") return client.board();
  if (cmd === "board_set") {
    const [key, valueJson, ifVersion] = rest;
    if (!key || !valueJson) throw new Error("board_set needs: <key> <json_value> [if_version]");
    return client.setBoardKey(key, JSON.parse(valueJson), { ifVersion: ifVersion === undefined ? undefined : Number(ifVersion) });
  }
  if (cmd === "board_patch") {
    const [valueJson, ifVersionsJson] = rest;
    if (!valueJson) throw new Error("board_patch needs: <json_values> [if_versions_json]");
    return client.patchBoard(JSON.parse(valueJson), { ifVersions: ifVersionsJson ? JSON.parse(ifVersionsJson) : undefined });
  }
  if (cmd === "board_delete") {
    const [key, ifVersion] = rest;
    if (!key) throw new Error("board_delete needs: <key> [if_version]");
    return client.deleteBoardKey(key, { ifVersion: ifVersion === undefined ? undefined : Number(ifVersion) });
  }
  if (cmd === "status") {
    const [state, status] = rest;
    if (!state || !status) throw new Error("status needs: <free|busy> <status_text>");
    return client.updateStatus(state as "free" | "busy", status);
  }
  if (cmd === "webhook") {
    const [url] = rest;
    if (!url) throw new Error("webhook needs: <https_url|off>");
    const result = await client.setWebhook(url === "off" ? null : url);
    return options.webhookResult === "helper" ? { ok: true, webhook: url === "off" ? "off (poll with read/watch)" : url } : result;
  }
  if (cmd === "participants") return client.participants();
  if (cmd === "room_status") return client.status();
  if (cmd === "transition") {
    if (!rest[0]) throw new Error("transition needs: <event>");
    return client.transition(rest[0]);
  }
  if (cmd === "host") {
    if (!rest[0]) throw new Error("host needs: <participant to make host>");
    return client.transferHost(rest[0]);
  }
  throw new Error(`unknown room command: ${cmd}`);
}

export async function runReservationCommand(client: RoomClient, cmd: "reserve" | "release" | "reservations", rest: string[], options: { repo: string; path: (value: string) => string; requirePaths?: boolean }): Promise<unknown> {
  if (cmd === "reservations") return { reservations: await listReservations(client) };
  if (cmd === "release") return { ok: true, reservations: await releasePaths(client, options.repo, rest.map(options.path)) };
  const at = rest.indexOf("--reason");
  const paths = (at >= 0 ? rest.slice(0, at) : rest).map(options.path);
  if (options.requirePaths && !paths.length) throw new Error("reserve needs: <path>... [--reason text]");
  const reason = at >= 0 ? rest.slice(at + 1).join(" ") || undefined : undefined;
  return { ok: true, reservations: await reservePaths(client, options.repo, paths, reason) };
}

export async function runProfileCommand(client: RoomClient, rest: string[], options: {
  modelFallback?: string;
  providerFallback?: string;
  workspace: () => Workspace;
  secret: string;
  workspaceError: string;
}): Promise<unknown> {
  const flag = (name: string) => {
    const at = rest.indexOf(name);
    return at >= 0 && rest[at + 1] && !rest[at + 1].startsWith("--") ? rest[at + 1] : undefined;
  };
  const profile: { capabilities?: string[]; workspace?: Workspace | null; model?: string; provider?: string } = {};
  const at = rest.indexOf("--capabilities");
  if (at >= 0) profile.capabilities = (flag("--capabilities") || "").split(",").map((name) => name.trim()).filter(Boolean);
  const model = flag("--model") || options.modelFallback;
  const provider = flag("--provider") || options.providerFallback;
  if (model) profile.model = model;
  if (provider) profile.provider = provider;
  if (rest.includes("--no-workspace")) profile.workspace = null;
  else if (rest.includes("--workspace")) {
    if (options.secret === "resume-only") throw new Error(options.workspaceError);
    profile.workspace = options.workspace();
  }
  if (Object.keys(profile).length) await client.setProfile(profile);
  return { ok: true, team: await client.team() };
}
