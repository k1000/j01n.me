import type { CreateRoomOptions } from "./room-client";

export type SprintTask = NonNullable<CreateRoomOptions["tasks"]>[number];

/** Parse the ## Tasks section of a sprint Markdown spec. All other sections remain in the sealed kickoff. */
export function parseSprintSpec(spec: string): SprintTask[] {
  const lines = spec.split(/\r?\n/);
  const sections = lines.flatMap((line, index) => /^## Tasks\s*$/.test(line) ? [index] : []);
  if (sections.length !== 1) throw new Error("spec needs exactly one ## Tasks section");
  const start = sections[0];
  const tasks: SprintTask[] = [];
  let current: SprintTask | undefined;
  const fields = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.trim()) continue;
    const heading = line.match(/^- ([A-Za-z0-9_-]+) (.+)$/);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), files: [] };
      if (!current.title || tasks.some((task) => task.id === heading[1])) throw new Error(`invalid or duplicate spec task ${heading[1]}`);
      tasks.push(current);
      fields.clear();
      continue;
    }
    const field = line.match(/^  +(?:- )?(files|depends|role|worktree):\s*(.*?)\s*$/);
    if (!current || !field || fields.has(field[1])) throw new Error(`invalid spec task line: ${line}`);
    const [, name, value] = field;
    fields.add(name);
    if (!value && name !== "depends") throw new Error(`spec task ${current.id} needs ${name}`);
    if (name === "files") current.files = value.split(",").map((file) => file.trim());
    if (name === "depends") current.depends_on = value ? value.split(",").map((id) => id.trim()) : [];
    if (name === "role") current.role = value;
    if (name === "worktree") current.worktree = value;
  }
  if (!tasks.length) throw new Error("spec ## Tasks section is empty");
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (!task.files.length || task.files.some((file) => !file || /(?:^|\/)(?:client-script\.ts|markdown-assets\.ts|skill\.ts)$/.test(file))) {
      throw new Error(`spec task ${task.id} needs valid files (generated files belong to integration)`);
    }
    if (task.depends_on?.some((id) => !ids.has(id) || id === task.id)) throw new Error(`spec task ${task.id} has an unknown or self dependency`);
  }
  return tasks;
}
