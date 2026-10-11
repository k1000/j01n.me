import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { splitArgs } from "./args";
import { autojoinNote, autojoinRoom, runj01n } from "./commands";
import { registerLive } from "./live";
import { registerPeerSpawnTool } from "./peer-spawn-tool";
import { registerRepoInviteTool } from "./repo-invite";
import { registerIntegratorTool } from "./integrator";
import { getExtensionDiagnostics } from "./version";

const USAGE = "Usage: /j01n <create|join|doctor|send|read|board|board_set|board_patch|board_delete|status|webhook|wait|register|allow|invite|listen|herdr_agents|invite_herdr|leave|close|participants|room_status|transition|host|profile|reserve|release|reservations|tasks|claim|done|conflicts|worktrees|live> ...";

type Notify = (message: string, level: "info" | "error") => void;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    for (const warning of getExtensionDiagnostics().warnings) ctx.ui.notify(`j01n: ${warning}`, "error");
  });

  // Registered before live mode, so the room it joins is delivered live in the same boot.
  registerAutojoin(pi);

  const live = registerLive(pi);
  registerPeerSpawnTool(pi);
  registerRepoInviteTool(pi);
  registerIntegratorTool(pi);
  pi.registerCommand("j01n", {
    description: "j01n.me encrypted room helper: create, join, use, doctor, send, read, board, board_set, board_patch, board_delete, status, webhook, wait, register, allow, invite, listen, herdr_agents, invite_herdr, leave, close, participants, room_status, transition, host, profile, reserve, release, reservations, tasks, claim, done, conflicts, worktrees, live",
    handler: async (args, ctx) => {
      const notify: Notify = ctx.ui.notify.bind(ctx.ui);
      const argv = splitArgs(args || "");
      if (argv[0] === "live") return notify(live.setEnabled(argv[1] !== "off"), "info");
      await runCommandFromText(args || "", notify);
      await live.refresh().catch(() => undefined); // join/leave change which rooms are delivered live
    },
  });

  pi.registerTool({
    name: "j01n",
    label: "j01n.me",
    description: "Use the j01n.me encrypted room helper. Args match the j01n client, e.g. ['read','docs-review.json','agent-b'] or ['board','docs-review.json','agent-b'] or ['status','docs-review.json','agent-b','free','working on docs'].",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: "Arguments: create|join|use|doctor|send|read|board|board_set|board_patch|board_delete|status|webhook|wait|register|allow|invite|listen|herdr_agents|invite_herdr|leave|close|participants|room_status|transition|host|profile|reserve|release|reservations|tasks|claim|done|conflicts|worktrees|live ..." }),
    }),
    async execute(_toolCallId, params) {
      if (params.args[0] === "live") return toolResult(live.setEnabled(params.args[1] !== "off"), params.args);
      return executeTool(params.args);
    },
  });
}

/**
 * Join without a first model turn: a pane opened in a worktree that holds one room profile, or one seeded
 * inbox identity, is in its room before the first prompt. A short note is the only room content the model
 * sees; a stale or ambiguous directory stays silent and the session behaves exactly as it did before.
 */
function registerAutojoin(pi: ExtensionAPI): void {
  let attempted = false;
  pi.on("session_start", async (_event, ctx) => {
    if (attempted || !ctx.hasUI) return; // one bounded attempt per process, and only where a session is really running
    attempted = true;
    try {
      const joined = await autojoinRoom();
      if (!joined) return;
      pi.sendMessage({ customType: "j01n", content: autojoinNote(joined), display: true, details: { autojoin: joined } });
    } catch {
      // never fatal: the room is simply unavailable from this directory
    }
  });
}

async function runCommandFromText(input: string, notify: Notify): Promise<void> {
  const argv = splitArgs(input);
  if (argv.length === 0) return notify(USAGE, "info");
  return notifyCommandResult(argv, notify);
}

async function notifyCommandResult(argv: string[], notify: Notify): Promise<void> {
  try {
    const output = await runj01n(argv);
    notify(output.slice(0, 4000), "info");
  } catch (err: unknown) {
    notify(`j01n error: ${errorMessage(err)}`, "error");
  }
}

async function executeTool(args: string[]) {
  try {
    const output = await runj01n(args);
    return toolResult(output, args);
  } catch (err: unknown) {
    return toolResult(`Error: ${errorMessage(err)}`, args, true);
  }
}

function toolResult(text: string, args: string[], isError?: true) {
  return {
    content: [{ type: "text" as const, text }],
    details: { args },
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
