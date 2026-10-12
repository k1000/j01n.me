import type { RoomClient } from "./room-client";
import type { Workspace } from "./crypto";
import { RoomApiError } from "./errors";
import { listReservations, releasePaths, reservePaths } from "./reservations";
import { addDecision, addNote, notesAndDecisions } from "./notes";
import { blockTask, claimTask, completeTask, listTasks, taskKey, unblockTask, type Task } from "./tasks";
import type { CompareVerdictBody, RefineOptions, RoomMessage, SendResult, TaskRefinedBody, TaskRouting } from "./types";

const MESSAGE_KINDS = ["finding", "question", "decision", "blocker", "handoff"] as const;
type MessageKind = typeof MESSAGE_KINDS[number];
function kinds(value: string): MessageKind[] {
  const values = value.split(",").map((kind) => kind.trim());
  if (!values.length || values.some((kind) => !MESSAGE_KINDS.includes(kind as MessageKind))) throw new Error(`--kind needs: ${MESSAGE_KINDS.join("|")}`);
  return values as MessageKind[];
}

/** Pairwise comparison intents: a request asks the room to judge two options, a verdict answers it with the winner. */
export const COMPARE_INTENTS = { request: "compare.request", verdict: "compare.verdict" } as const;
/** Winner vocabulary for compare.verdict; case-insensitive on input, canonical on the wire. */
export const COMPARE_WINNERS = ["A", "B", "tie"] as const;
type CompareWinner = typeof COMPARE_WINNERS[number];
function compareWinner(value: string | undefined): CompareWinner {
  const winner = value && value.toLowerCase() !== "tie" ? value.toUpperCase() : value?.toLowerCase();
  if (!winner || !COMPARE_WINNERS.includes(winner as CompareWinner)) throw new Error(`verdict needs winner: ${COMPARE_WINNERS.join("|")}`);
  return winner as CompareWinner;
}
const COMPARE_USAGE = "compare needs: <a> <b> --criteria x,y [--wait]";
const VERDICT_USAGE = `verdict needs: <msg-id-or-seq> <${COMPARE_WINNERS.join("|")}> --reason <text> [--reply-to <id>]`;

/** The verdict loop: a losing verdict turns into rework as a child task of the task it judged. */
export const REFINE_INTENT = "task.refined";
const REFINE_USAGE = "refine needs: <task id> [--from <verdict seq|id>] [--note text]";
/** How much of a verdict reason a follow-up title carries. */
const REFINE_TITLE_CHARS = 60;
/** A board task plus the routing fields the sprint spec writes into it (see types.ts TaskRouting). */
type BoardTask = Task & TaskRouting;

/** Host by announced role, or by the room record when the role row never landed: the same rule assign follows. */
async function isRoomHost(client: RoomClient): Promise<boolean> {
  if ((await client.team()).find((p) => p.id === client.participantId)?.role === "host") return true;
  return (await client.status()).room.host_id === client.participantId;
}

/** The compare.verdict a refine leans on: `from` names its seq or message id, otherwise the newest verdict wins.
 * Reading messages advances this participant's cursor, the same tradeoff `report` accepts to see verdicts. */
async function verdictToRefine(client: RoomClient, from?: string): Promise<RoomMessage> {
  const messages = await client.read({ all: true, includeSelf: true });
  const verdicts = messages.filter((message) => message.intent === COMPARE_INTENTS.verdict);
  if (!verdicts.length) throw new Error(`refine needs a ${COMPARE_INTENTS.verdict} message to point at: post one, or pass --from <seq>`);
  if (from === undefined) return verdicts.reduce((latest, message) => (message.seq > latest.seq ? message : latest));
  const found = verdicts.find((message) => String(message.seq) === from || message.id === from);
  if (!found) throw new Error(`refine --from ${from} is not a ${COMPARE_INTENTS.verdict} message in this room`);
  return found;
}

/**
 * Open one follow-up task from a verdict, so a losing comparison turns into routed rework instead of a chat thread.
 * Reads `task.<taskId>`, takes the newest (or `--from`) `compare.verdict` as its reason, and seeds a NEW board key
 * `task.<parentId>r<n>` - n one past the parent's existing numbered children, refused when that key already exists
 * (and guarded by if_version 0, so a concurrent refine cannot clobber it) - with status open, the parent's files,
 * role and needs copied, depends_on [parentId] and the reason `verdict <seq>` in the brief. Then posts a sealed
 * task.refined notice to all with the new id. Only the verdict's author may refine, the host always may.
 */
export async function refineTask(client: RoomClient, taskId: string, options: RefineOptions = {}): Promise<{ id: string; task: BoardTask; notice: SendResult }> {
  taskKey(taskId);
  const tasks = await listTasks(client);
  const parent = tasks.find((task) => task.id === taskId) as BoardTask | undefined;
  if (!parent) throw new Error(`task ${taskId} does not exist`);

  const verdict = await verdictToRefine(client, options.from === undefined ? undefined : String(options.from));
  if (!(await isRoomHost(client)) && verdict.from !== client.participantId) {
    throw new Error(`refine ${taskId}: verdict ${verdict.seq} is ${verdict.from}'s to refine, or ask the host`);
  }
  const note = options.note?.trim() ?? "";
  const opened = verdict.body as CompareVerdictBody | undefined;
  const reasonText = typeof opened?.reason === "string" ? opened.reason.trim() : "";
  const detail = note || reasonText.slice(0, REFINE_TITLE_CHARS);
  if (!detail) throw new Error(`refine ${taskId} needs --note, or a verdict reason this client can open`);

  // t1 -> t1r1, t1r2, ... one past the parent's numbered children; the slot must be free, refine never rewrites
  // a task somebody already holds (a gap in the sequence is a collision, not an invitation).
  const childPattern = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}r\\d+$`);
  const children = tasks.filter((task) => childPattern.test(task.id));
  const id = `${taskId}r${children.length + 1}`;
  if (children.some((task) => task.id === id)) throw new Error(`refine ${taskId} cannot seed task ${id}: it already exists`);
  const reason = `verdict ${verdict.seq}`;
  const task: BoardTask = {
    title: `refine ${taskId}: ${detail}`,
    files: [...parent.files],
    depends_on: [taskId],
    status: "open",
    brief: [`${reason}${reasonText ? `: ${reasonText}` : ""}`, note ? `note: ${note}` : "", parent.brief ? `${taskId}: ${parent.brief}` : ""]
      .filter(Boolean).join("; "),
    ...(parent.role ? { role: parent.role } : {}),
    ...(parent.needs?.length ? { needs: [...parent.needs] } : {}),
    ...(parent.contract ? { contract: parent.contract } : {}),
  };
  try {
    await client.setBoardKey(taskKey(id), task, { ifVersion: 0 });
  } catch (error) {
    if (error instanceof RoomApiError && error.status === 409) throw new Error(`refine ${taskId} cannot seed task ${id}: it already exists`);
    throw error;
  }
  // The same vocabulary task.assigned uses, so one notice reader covers both, plus the lineage a modal shows.
  const body: TaskRefinedBody = {
    text: `${id} opened from ${taskId}: ${detail}`,
    task: id, task_id: id, title: task.title, refines: taskId, reason, by: client.participantId,
  };
  const notice = await client.send("all", body, { intent: REFINE_INTENT });
  return { id, task, notice };
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
  // read() advances the cursor for every unread message, including other kinds. Return those too.
  const messages = roomReplyHints(await client.read(), prefix);
  if (!filter.kind?.length) return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), messages };
  const matching = messages.filter((message) => filter.kind?.includes((message as typeof message & { kind?: MessageKind }).kind as MessageKind));
  return { woke: woke.event, ...(woke.changes ? { board: woke.changes } : {}), messages: matching, other_messages: messages.filter((message) => !matching.includes(message)) };
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
  if (cmd === "assign") {
    const [id, worker, ...reasonWords] = rest;
    if (!id || !worker || id.startsWith("--") || worker.startsWith("--")) throw new Error("assign needs: <task id> <participant> [reason]");
    const reason = reasonWords.join(" ").trim();
    return { task: await client.assign(id, worker, reason ? { reason } : {}) };
  }
  if (cmd === "refine") {
    const [id, ...args] = rest;
    if (!id || id.startsWith("--")) throw new Error(REFINE_USAGE);
    const flags: RefineOptions = {};
    for (let i = 0; i < args.length; i++) {
      const name = args[i];
      const value = args[i + 1];
      if (name !== "--from" && name !== "--note") throw new Error(REFINE_USAGE);
      const already = name === "--from" ? flags.from : flags.note;
      if (!value || value.startsWith("--") || already !== undefined) throw new Error(REFINE_USAGE);
      if (name === "--from") flags.from = value; else flags.note = value;
      i++;
    }
    await options.beforeSend?.();
    return refineTask(client, id, flags);
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
  if (cmd === "compare") {
    const [a, b, ...args] = rest;
    let criteria: string[] | undefined;
    let andWait = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--criteria") criteria = (args[++i] ?? "").split(",").map((criterion) => criterion.trim()).filter(Boolean);
      else if (args[i] === "--wait") andWait = true;
      else throw new Error(COMPARE_USAGE);
    }
    if (!a || !b || a.startsWith("--") || b.startsWith("--") || !criteria?.length) throw new Error(COMPARE_USAGE);
    await options.beforeSend?.();
    const sent = await client.send("all", { a, b, criteria }, { intent: COMPARE_INTENTS.request, kind: "question", expectsReply: true });
    return andWait ? { sent, ...await waitRoom(client, options.waitDefault, {}, prefix) } : sent;
  }
  if (cmd === "verdict") {
    const [target, winnerRaw, ...args] = rest;
    let reason: string | undefined, replyTo: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--reason") {
        const words: string[] = [];
        for (i++; i < args.length && !args[i].startsWith("--");) words.push(args[i++]);
        reason = words.join(" ");
        i--;
      } else if (args[i] === "--reply-to") replyTo = args[++i];
      else throw new Error(VERDICT_USAGE);
    }
    if (!target || target.startsWith("--") || !winnerRaw || winnerRaw.startsWith("--")) throw new Error(VERDICT_USAGE);
    const winner = compareWinner(winnerRaw);
    if (!reason) throw new Error(VERDICT_USAGE);
    await options.beforeSend?.();
    // Verdicts carry no reply ask: they answer one, and stay visible to all so every peer sees the comparison result.
    return client.send("all", { of: target, winner, reason }, { intent: COMPARE_INTENTS.verdict, kind: "finding", ...(replyTo ? { replyTo } : {}) });
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
  if (cmd === "unassign") {
    const [id, ...noteWords] = rest;
    if (!id) throw new Error("unassign needs: <task id> [note]");
    const note = noteWords.join(" ").trim() || undefined;
    
    // Host-only check
    const team = await client.team();
    const me = team.find((p) => p.id === client.participantId);
    if (me?.role !== "host") {
      const hostId = (await client.status()).room.host_id;
      if (hostId !== client.participantId) throw new Error(`unassign is host only: ask ${hostId} to unassign ${id}`);
    }
    
    // Read the task
    const board = await client.board();
    const entry = board.board[`task.${id}`];
    if (!entry) throw new Error(`task ${id} does not exist`);
    const task = entry.value as Record<string, unknown>;
    
    // Check if task was assigned (has assigned_by)
    if (!task.assigned_by) {
      throw new Error(`task ${id} was not assigned (no assigned_by field)`);
    }
    
    // Check if task has evidence (meaning it was completed)
    if (task.evidence) {
      throw new Error(`task ${id} has evidence (already completed, cannot unassign)`);
    }
    
    // Write the unassign: remove all assignment markers, set status=open, optionally set assigned_reason=note
    const { owner, assigned, assigned_by, assigned_at, assigned_reason, ...taskRest } = task;
    const unassigned = {
      ...taskRest,
      status: "open",
      ...(note ? { assigned_reason: note } : {}),
    };
    
    await client.setBoardKey(`task.${id}`, unassigned, { ifVersion: entry.version });
    return { task: unassigned };
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
  const profile: { capabilities?: string[]; workspace?: Workspace | null; checkout?: string | null; display_name?: string; role?: string; model?: string; provider?: string; harness?: string | null } = {};
  const at = rest.indexOf("--capabilities");
  if (at >= 0) profile.capabilities = (flag("--capabilities") || "").split(",").map((name) => name.trim()).filter(Boolean);
  const model = flag("--model") || options.modelFallback;
  const provider = flag("--provider") || options.providerFallback;
  if (model) profile.model = model;
  if (provider) profile.provider = provider;
  if (flag("--harness")) profile.harness = flag("--harness") === "clear" ? null : flag("--harness");
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
