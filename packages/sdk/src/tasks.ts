import type { RoomClient } from "./room-client";
import { RoomApiError } from "./errors";
import { listReservations, releaseReservationIds, reservePaths } from "./reservations";

export interface Task {
  title: string;
  files: string[];
  depends_on: string[];
  worktree?: string;
  status: "open" | "claimed" | "blocked" | "done";
  owner?: string;
  summary?: string;
  behaviour_changes?: string;
  evidence?: { commits: string[]; tests: string; contract?: string };
  blocked_reason?: string;
  waiting_for?: string[];
}
export type ListedTask = Task & { id: string; blocked_by: string[]; unblocked: boolean };

const key = (id: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid task id");
  return `task.${id}`;
};

function taskFrom(value: unknown): Task {
  if (!value || typeof value !== "object") throw new Error("invalid task entry");
  const task = value as Task;
  if (typeof task.title !== "string" || !Array.isArray(task.files) || !task.files.every((x) => typeof x === "string") ||
    !Array.isArray(task.depends_on) || !task.depends_on.every((x) => typeof x === "string") ||
    (task.waiting_for !== undefined && (!Array.isArray(task.waiting_for) || !task.waiting_for.every((x) => typeof x === "string"))) ||
    !["open", "claimed", "blocked", "done"].includes(task.status)) throw new Error("invalid task entry");
  return task;
}

export async function listTasks(client: RoomClient): Promise<ListedTask[]> {
  const board = (await client.board()).board;
  const tasks = Object.entries(board).filter(([name]) => name.startsWith("task.")).map(([name, entry]) => ({ id: name.slice(5), ...taskFrom(entry.value) }));
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks.map((task) => {
    const blocked_by = task.depends_on.filter((id) => !done.has(id));
    return { ...task, blocked_by, unblocked: task.status === "open" && blocked_by.length === 0 };
  });
}

async function load(client: RoomClient, id: string): Promise<{ task: Task; version: number }> {
  const entry = (await client.board()).board[key(id)];
  if (!entry) throw new Error(`task ${id} does not exist`);
  return { task: taskFrom(entry.value), version: entry.version ?? 0 };
}

function owned(client: RoomClient, id: string, task: Task): void {
  if (task.owner !== client.participantId) throw new Error(`task ${id} is ${task.status}${task.owner ? ` by ${task.owner}` : ""}`);
}

export async function claimTask(client: RoomClient, id: string, repo: string): Promise<Task> {
  let task: Task | undefined, version = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const board = (await client.board()).board;
    const entry = board[key(id)];
    if (!entry) throw new Error(`task ${id} does not exist`);
    const current = taskFrom(entry.value);
    if (current.status !== "open") throw new Error(`task ${id} is ${current.status}${current.owner ? ` by ${current.owner}` : ""}`);
    const unfinished = (entries: typeof board) => current.depends_on.filter((dep) => entries[key(dep)]?.value && taskFrom(entries[key(dep)].value).status === "done" ? false : true);
    const waiting = unfinished(board);
    if (waiting.length) {
      if (!current.waiting_for?.includes(client.participantId)) {
        try {
          await client.setBoardKey(key(id), { ...current, waiting_for: [...(current.waiting_for ?? []), client.participantId] }, { ifVersion: entry.version ?? 0 });
        } catch (error) {
          if (error instanceof RoomApiError && error.status === 409) continue;
          throw error;
        }
      }
      // A dependency may have completed before this waiter was recorded, so its notice could have missed us.
      if (unfinished((await client.board()).board).length === 0) continue;
      throw new Error(`task ${id} waits for ${waiting.join(", ")}`);
    }
    task = current;
    version = entry.version ?? 0;
    break;
  }
  if (!task) throw new Error(`task ${id} kept changing; try again`);
  if (task.files.length && !repo) throw new Error("repo is required to reserve task files");
  const before = task.files.length ? new Set((await listReservations(client)).map((r) => r.id)) : new Set<string>();
  const reserved = task.files.length ? await reservePaths(client, repo, task.files, `task ${id}`) : [];
  const newIds = reserved.filter((r) => r.by === client.participantId && !before.has(r.id) && r.reason === `task ${id}`).map((r) => r.id);
  const claimed: Task = { ...task, status: "claimed", owner: client.participantId };
  delete claimed.waiting_for;
  try {
    await client.setBoardKey(key(id), claimed, { ifVersion: version });
  } catch (error) {
    if (newIds.length) await releaseReservationIds(client, newIds);
    if (error instanceof RoomApiError && error.status === 409) {
      const current = await load(client, id);
      throw new Error(`task ${id} is ${current.task.status}${current.task.owner ? ` by ${current.task.owner}` : ""}`);
    }
    throw error;
  }
  return claimed;
}

export async function completeTask(client: RoomClient, id: string, repo: string, summary: string, evidence: { commits: string[]; tests: string; contract?: string }, behaviourChanges?: string): Promise<Task> {
  const { task, version } = await load(client, id);
  owned(client, id, task);
  if (task.status !== "claimed" && task.status !== "blocked") throw new Error(`task ${id} is ${task.status}`);
  if (!summary.trim() || !evidence.tests?.trim() || !Array.isArray(evidence.commits)) throw new Error("done needs summary, commits and tests");
  if (task.files.length && !repo) throw new Error("repo is required to release task files");
  const next: Task = { ...task, status: "done", summary, ...(behaviourChanges ? { behaviour_changes: behaviourChanges } : {}), evidence };
  delete next.blocked_reason;
  await client.setBoardKey(key(id), next, { ifVersion: version });
  if (task.files.length) {
    const reservations = await listReservations(client);
    await releaseReservationIds(client, reservations.filter((r) => r.by === client.participantId && r.repo === repo &&
      r.reason === `task ${id}` && JSON.stringify(r.paths) === JSON.stringify(task.files)).map((r) => r.id));
  }
  return next;
}

export async function blockTask(client: RoomClient, id: string, reason: string): Promise<Task> {
  const { task, version } = await load(client, id);
  if (!reason.trim()) throw new Error("block needs a reason");
  if (task.status === "done") throw new Error(`task ${id} is done`);
  if (task.owner) owned(client, id, task);
  const next: Task = { ...task, status: "blocked", blocked_reason: reason };
  await client.setBoardKey(key(id), next, { ifVersion: version });
  return next;
}

export async function unblockTask(client: RoomClient, id: string): Promise<Task> {
  const { task, version } = await load(client, id);
  if (task.status !== "blocked") throw new Error(`task ${id} is not blocked`);
  if (task.owner) owned(client, id, task);
  const next: Task = { ...task, status: task.owner ? "claimed" : "open" };
  delete next.blocked_reason;
  await client.setBoardKey(key(id), next, { ifVersion: version });
  return next;
}
