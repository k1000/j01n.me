/**
 * Pre-built room templates that populate board, ACLs, and state machine.
 * Hosts pick a template by name and optionally override any field.
 *
 * Explicit body fields always override template defaults.
 */

import type { BoardAcls, RoomStateConfig } from "../types";

/** Wrap a plaintext board value as an opaque `ui:` envelope so it satisfies the encrypted-envelope check. */
function wrapTemplateBoardValue(value: unknown): { encrypted_payload: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { encrypted_payload: "ui:" + btoa(String.fromCharCode(...bytes)) };
}

function wrapTemplateBoard(board: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(board)) wrapped[key] = wrapTemplateBoardValue(value);
  return wrapped;
}

export interface SprintTask {
  id: string;
  title: string;
  files: string[];
  depends_on?: string[];
  worktree?: string;
}

const SPRINT_KICKOFF = "Sprint rules: use tasks to see dependencies; claim <id> before editing (claim reserves task files), then done <id> --summary <text> --commit <sha> --tests <result> when finished. Work only in your own branch/worktree; never push or merge. Run pnpm check:contract before reporting and include its result. Ask the host when blocked. Generated client-script.ts, markdown-assets.ts and skill.ts belong to integration, not task files.";

function sprintBoard(tasks: SprintTask[]): Record<string, unknown> {
  if (!Array.isArray(tasks)) throw new Error("sprint tasks must be an array");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(task.id) || task.id.length > 75 || ids.has(task.id) ||
      typeof task.title !== "string" || !task.title.trim() || !Array.isArray(task.files) || !task.files.every((file) => typeof file === "string" && file.length > 0) ||
      (task.depends_on !== undefined && (!Array.isArray(task.depends_on) || !task.depends_on.every((id) => typeof id === "string"))) ||
      (task.worktree !== undefined && typeof task.worktree !== "string")) throw new Error("invalid sprint task");
    if (task.files.some((file) => /(?:^|\/)(?:client-script\.ts|markdown-assets\.ts|skill\.ts)$/.test(file))) throw new Error("generated files cannot be sprint task files");
    ids.add(task.id);
  }
  if (tasks.some((task) => task.depends_on?.some((id) => !ids.has(id) || id === task.id))) throw new Error("sprint task has unknown or self dependency");
  return Object.fromEntries(tasks.map((task) => [`task.${task.id}`, {
    title: task.title, files: task.files, depends_on: task.depends_on ?? [],
    ...(task.worktree ? { worktree: task.worktree } : {}), status: "open",
  }]));
}

export interface RoomTemplate {
  room_name: string;
  board: Record<string, unknown>;
  board_acls: BoardAcls;
  states: Record<string, RoomStateConfig>;
  first_message?: Record<string, unknown>;
}

export const ROOM_TEMPLATES: Record<string, RoomTemplate> = {
  /**
   * Simple Kanban — todo → doing → review → done.
   * One active state with no review gates.
   */
  kanban: {
    room_name: "Kanban board",
    first_message: {
      text: "Collaborate on tasks using the Kanban board. Add tasks to the columns, assign owners, and move them through todo → doing → review → done.",
      workflow: "Claim a task by setting its owner, update its state as you work, and move it to done when finished.",
    },
    board: {
      columns: { todo: [], doing: [], review: [], done: [] },
      tasks: {},
    },
    board_acls: {
      columns: "anyone",
      tasks: "anyone",
    },
    states: {
      active: {
        transitions: { close: "closed" },
        board_acls: { columns: "anyone", tasks: "anyone" },
      },
    },
  },

  /**
   * Milestone tracking — planning → in_progress → review → completed.
   * Tasks are host-only during planning and review (to freeze scope).
   * Decisions and milestones are always host-only.
   */
  milestone: {
    room_name: "Milestone tracking",
    first_message: {
      text: "Track milestones and tasks through a structured workflow: planning → in progress → review → completed.",
      workflow: "Tasks are editable by anyone during in_progress but locked during planning and review. The host controls milestones and decisions.",
      acceptance: "Complete all tasks, get review approval, then close the room.",
    },
    board: {
      milestones: {},
      tasks: {},
      decisions: {},
      timeline: {},
    },
    board_acls: {
      milestones: "host_only",
      tasks: "anyone",
      decisions: "host_only",
      timeline: "anyone",
    },
    states: {
      planning: {
        transitions: { begin: "in_progress" },
        board_acls: { tasks: "host_only", milestones: "host_only" },
      },
      in_progress: {
        transitions: { review: "review" },
        board_acls: { tasks: "anyone" },
      },
      review: {
        transitions: { approve: "completed", revise: "in_progress" },
        board_acls: { tasks: "host_only" },
      },
      completed: {
        transitions: { close: "closed" },
      },
    },
  },

  sprint: {
    room_name: "Agent sprint",
    board: { kickoff: SPRINT_KICKOFF },
    board_acls: { kickoff: "host_only" },
    states: { active: { transitions: { close: "closed" } } },
  },

  /**
   * Minimal room — one active state. No board, no ACLs.
   * Default when no template is specified.
   */
  quick: {
    room_name: "j01n rendezvous",
    board: {},
    board_acls: {},
    states: {
      active: {
        transitions: { close: "closed" },
      },
    },
  },
};

/** Return the first state name from a states config (used as the initial phase). */
export function initialStateName(states: Record<string, RoomStateConfig>): string {
  return Object.keys(states)[0] ?? "active";
}

/**
 * Apply template defaults and overlay explicit body fields.
 *
 * Order: template defaults → explicit body fields (body wins).
 */
export function applyTemplate(
  templateName: string | undefined,
  body: {
    room_name?: string;
    tasks?: SprintTask[];
    board?: Record<string, unknown>;
    board_acls?: Record<string, unknown>;
    states?: Record<string, unknown>;
  },
): {
  room_name: string;
  initial_phase: string;
  board: Record<string, unknown>;
  board_acls: BoardAcls;
  states: Record<string, RoomStateConfig>;
  first_message?: Record<string, unknown>;
} {
  const template = templateName && ROOM_TEMPLATES[templateName]
    ? ROOM_TEMPLATES[templateName]
    : ROOM_TEMPLATES.quick;

  const merged = {
    room_name: body.room_name ?? template.room_name,
    board: { ...wrapTemplateBoard(template.board), ...(templateName === "sprint" ? wrapTemplateBoard(sprintBoard(body.tasks ?? [])) : {}), ...(body.board ?? {}) },
    board_acls: { ...template.board_acls, ...(body.board_acls ?? {}) } as BoardAcls,
    states: { ...template.states, ...(body.states ?? {}) } as Record<string, RoomStateConfig>,
  };
  return {
    ...merged,
    initial_phase: initialStateName(merged.states),
    first_message: template.first_message,
  };
}
