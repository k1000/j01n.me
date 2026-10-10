import type { RoomClient } from "./room-client";
import type { Workspace } from "./crypto";
import { listReservations, releasePaths, reservePaths } from "./reservations";
import { addDecision, addNote, notesAndDecisions } from "./notes";
import { blockTask, claimTask, completeTask, listTasks, unblockTask } from "./tasks";

const MESSAGE_KINDS = ["finding", "question", "decision", "blocker", "handoff"] as const;
type MessageKind = typeof MESSAGE_KINDS[number];
function kinds(value: string): MessageKind[] {
  const values = value.split(",").map((kind) => kind.trim());
  if (!values.length || values.some((kind) => !MESSAGE_KINDS.includes(kind as MessageKind))) throw new Error(`--kind needs: ${MESSAGE_KINDS.join("|")}`);
  return values as MessageKind[];
}

export async function roomSummary(client: RoomClient) {
  // These endpoints inspect state without reading messages or advancing the participant's cursor.
  const [board, tasks, reservations, participants] = await Promise.all([
    client.board(), listTasks(client), listReservations(client), client.team(),
  ]);
  return { tasks, reservations, participants, report: board.board.report?.value ?? null, ...notesAndDecisions(board.board) };
}

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

export async function waitRoom(client: RoomClient, timeoutSeconds?: number, filter: Parameters<RoomClient["wait"]>[0] & { kind?: MessageKind[] } = {}, prefix = "/j01n") {
  const woke = await client.wait({ ...filter, timeoutSeconds });
  if (woke.timeout) return { timeout: true };
  // read() consumes all unread messages; a kind filter only narrows what is returned.
  const messages = roomReplyHints(await client.read(), prefix);
  return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), messages: filter.kind?.length ? messages.filter((message) => filter.kind?.includes((message as typeof message & { kind?: MessageKind }).kind as MessageKind)) : messages };
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
  repo?: string;
  conflicts?: (branch?: string) => Promise<{ conflicts: Array<{ branches: [string, string]; files: string[] }> }>;
} = {}): Promise<unknown> {
  const prefix = options.prefix ?? "/j01n";
  if (cmd === "tasks") return { tasks: await listTasks(client) };
  if (cmd === "summary") return roomSummary(client);
  if (cmd === "note") {
    const text = rest[0];
    if (!text || text.startsWith("--")) throw new Error("note needs: <text> [--tag gotcha|finding|howto] [--files a,b]");
    const flags = new Map<string, string>();
    for (let i = 1; i < rest.length; i += 2) {
      if (!["--tag", "--files"].includes(rest[i]) || flags.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error("note needs: <text> [--tag gotcha|finding|howto] [--files a,b]");
      flags.set(rest[i], rest[i + 1]);
    }
    return { notes: await addNote(client, text, flags.has("--tag") ? [flags.get("--tag")!] : [], flags.get("--files")?.split(",").map((file) => file.trim()).filter(Boolean) ?? []) };
  }
  if (cmd === "decide") {
    if (!rest[0] || rest[1] !== "--why" || !rest[2]) throw new Error("decide needs: <decision> --why <reason>");
    return { decisions: await addDecision(client, rest[0], rest.slice(2).join(" ")) };
  }
  if (cmd === "conflicts") {
    if (!options.conflicts) throw new Error("conflicts needs a local git checkout");
    return options.conflicts();
  }
  if (cmd === "claim") {
    if (!rest[0]) throw new Error("claim needs: <id>");
    return { task: await claimTask(client, rest[0], options.repo ?? "") };
  }
  if (cmd === "done") {
    const [id, ...args] = rest;
    if (!id) throw new Error("done needs: <id> --summary <text> --commit <sha>... --tests <text> [--contract <text>]");
    const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    const commits: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--commit" && args[i + 1] && !args[i + 1].startsWith("--")) commits.push(args[++i]);
    const summary = flag("--summary"), tests = flag("--tests"), contract = flag("--contract"), changes = flag("--behaviour-changes");
    if (!summary || !tests || !commits.length) throw new Error("done needs --summary, --commit and --tests");
    const task = await completeTask(client, id, options.repo ?? "", summary, { commits, tests, ...(contract ? { contract } : {}) }, changes);
    if (!options.conflicts) return { task };
    try {
      const branch = (await client.team()).find((p) => p.id === client.participantId)?.workspace?.branch;
      const report = await options.conflicts(branch);
      if (report.conflicts.length) await client.send("all", { text: `${id} merge conflicts: ${report.conflicts.map((p) => `${p.branches.join(" vs ")}: ${p.files.join(", ")}`).join("; ")}` });
      return { task, conflicts: report.conflicts };
    } catch (error) { return { task, conflicts_error: error instanceof Error ? error.message : String(error) }; }
  }
  if (cmd === "block") {
    const [id, ...args] = rest;
    const at = args.indexOf("--reason");
    if (!id || at < 0 || !args[at + 1]) throw new Error("block needs: <id> --reason <text>");
    return { task: await blockTask(client, id, args.slice(at + 1).join(" ")) };
  }
  if (cmd === "unblock") {
    if (!rest[0]) throw new Error("unblock needs: <id>");
    return { task: await unblockTask(client, rest[0]) };
  }
  if (cmd === "send") {
    const [toRaw, ...args] = rest;
    const words: string[] = [];
    let andWait = false, replyTo: string | undefined, expectsReply = false, kind: MessageKind | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--wait") andWait = true;
      else if (args[i] === "--expect-reply") expectsReply = true;
      else if (args[i] === "--reply-to") replyTo = args[++i];
      else if (args[i] === "--kind") { const parsed = kinds(args[++i] ?? ""); if (parsed.length !== 1) throw new Error("send --kind needs one kind"); kind = parsed[0]; }
      else words.push(args[i]);
    }
    if (!toRaw || !words.length) throw new Error("send needs: <to> <text or json_body> [--reply-to <id>] [--expect-reply] [--wait]");
    const to = options.recipientList && toRaw.includes(",") ? toRaw.split(",").map((s) => s.trim()) : options.recipientList ? toRaw.trim() : toRaw;
    await options.beforeSend?.();
    const sendOptions = { replyTo, expectsReply: expectsReply || kind === "question" || kind === "blocker", kind };
    const sent = await client.send(to, parseRoomBody(words.join(" ")), sendOptions);
    return andWait ? { sent, ...await waitRoom(client, options.waitDefault, {}, prefix) } : sent;
  }
  if (cmd === "read" || cmd === "inbox") {
    return roomReplyHints(await client.read({ all: options.readAll || cmd === "inbox", includeSelf: true }), prefix);
  }
  if (cmd === "wait") {
    let timeout: string | undefined;
    const filter: Parameters<RoomClient["wait"]>[0] & { kind?: MessageKind[] } = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--from") filter.from = (rest[++i] ?? "").split(",").map((name) => options.trimWaitFrom ? name.trim() : name).filter(Boolean);
      else if (rest[i] === "--board") filter.board = rest[++i] ?? "";
      else if (rest[i] === "--kind") filter.kind = kinds(rest[++i] ?? "");
      else if (rest[i] === "--no-system") filter.system = false;
      else timeout = rest[i];
    }
    const seconds = timeout === undefined ? options.waitDefault : options.parseWaitFallback ? Number(timeout) || options.waitDefault : timeout ? Number(timeout) : undefined;
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

export async function runReservationCommand(client: RoomClient, cmd: "reserve" | "release" | "reservations", rest: string[], options: { repo: string; path: (value: string) => string; requirePaths?: boolean; releaseReasonDelimiter?: boolean }): Promise<unknown> {
  if (cmd === "reservations") return { reservations: await listReservations(client) };
  const at = rest.indexOf("--reason");
  if (cmd === "release") return { ok: true, reservations: await releasePaths(client, options.repo, (options.releaseReasonDelimiter && at >= 0 ? rest.slice(0, at) : rest).map(options.path)) };
  const paths = (at >= 0 ? rest.slice(0, at) : rest).map(options.path);
  if (options.requirePaths && !paths.length) throw new Error("reserve needs: <path>... [--reason text]");
  const reason = at >= 0 ? rest.slice(at + 1).join(" ") || undefined : undefined;
  const reservations = await reservePaths(client, options.repo, paths, reason);
  return { ok: true, reservations, ...(reservations.length ? {} : { message: "nobody shares your checkout: no reservation needed" }) };
}

export async function runProfileCommand(client: RoomClient, rest: string[], options: {
  modelFallback?: string;
  providerFallback?: string;
  workspace: () => Workspace;
  checkout?: () => string;
  secret: string;
  workspaceError: string;
}): Promise<unknown> {
  const target = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  if (target) {
    const role = rest[1] === "--role" ? rest[2] : undefined;
    if (rest.length !== 3 || (role !== "owner" && role !== "clear")) throw new Error("profile <participant> needs --role owner|clear");
    await client.setParticipantRole(target, role === "owner" ? "owner" : null);
    return { ok: true, team: await client.team() };
  }
  const flag = (name: string) => {
    const at = rest.indexOf(name);
    return at >= 0 && rest[at + 1] && !rest[at + 1].startsWith("--") ? rest[at + 1] : undefined;
  };
  const profile: { capabilities?: string[]; workspace?: Workspace | null; checkout?: string | null; display_name?: string; role?: string; model?: string; provider?: string } = {};
  const at = rest.indexOf("--capabilities");
  if (at >= 0) profile.capabilities = (flag("--capabilities") || "").split(",").map((name) => name.trim()).filter(Boolean);
  const model = flag("--model") || options.modelFallback;
  const provider = flag("--provider") || options.providerFallback;
  if (model) profile.model = model;
  if (provider) profile.provider = provider;
  if (flag("--display-name")) profile.display_name = flag("--display-name");
  if (flag("--role")) profile.role = flag("--role");
  if (rest.includes("--no-workspace")) { profile.workspace = null; profile.checkout = null; }
  else if (rest.includes("--workspace")) {
    if (options.secret === "resume-only") throw new Error(options.workspaceError);
    profile.workspace = options.workspace();
    profile.checkout = options.checkout?.();
  }
  if (Object.keys(profile).length) await client.setProfile(profile);
  return { ok: true, team: await client.team() };
}
