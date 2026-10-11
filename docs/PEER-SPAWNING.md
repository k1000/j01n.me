# Configure Pi and Claude Code room peers

`spawn_room_peer` is a Pi extension tool for a **joined room host running inside Herdr**. On a directly human-delegated request, it starts a peer in a sibling pane, registers its inbox, sends a sealed invitation and confirms the join. The peer may run Pi (`harness: "pi"`) or Claude Code (`harness: "claude"`). The host's **personal config** chooses startup settings; room messages and participant profiles do not.

## One-time setup

From a checkout of this repository:

```sh
mkdir -p "$HOME/.config/j01n"
cp packages/pi-extension/peer-spawn.example.json "$HOME/.config/j01n/peer-spawn.json"
```

Edit the copy for your own harness installations. The [example file](../packages/pi-extension/peer-spawn.example.json) has no model IDs; it is a template, **not an active fallback**. If you installed from GitLab rather than a checkout, obtain that example file from the installed extension or the linked repository source. Spawning without a config fails with a copy/setup instruction before starting a pane; normal room use does not require this file.

By default the host reads `~/.config/j01n/peer-spawn.json`. An absolute `J01N_PEER_CONFIG` path overrides it; otherwise `$XDG_CONFIG_HOME/j01n/peer-spawn.json` is used when `XDG_CONFIG_HOME` is set to an absolute path. The file belongs to the host user, not the room, repository, or peer worktree. Do not commit it or put room links, keys, tokens, or API credentials in it.

## Fields and selection

```json
{
  "defaultRole": "builder",
  "defaultHarness": "pi",
  "roles": {
    "builder": {
      "pi": { "skills": ["builtin:builder"], "tools": ["read", "bash", "edit", "write", "j01n"] },
      "claude": { "skills": ["builtin:builder"], "tools": ["Read", "Bash", "Edit", "Write"] }
    },
    "reviewer": {
      "pi": { "skills": ["builtin:reviewer"], "tools": ["read", "bash", "j01n"] }
    }
  }
}
```

- `defaultRole` and `defaultHarness` apply when the host omits the corresponding tool argument. For example, `spawn_room_peer({ task: "Review the tests", role: "reviewer" })` chooses `reviewer/pi` above. `harness: "claude"` with that reviewer fails because `reviewer/claude` is not defined; it does not silently fall back to another role or harness.
- `roles` can contain your own lowercase role names (start with a letter; then letters, digits, `_` or `-`; at most 32 characters). `owner` and `host` are reserved. Each role needs a `pi` and/or `claude` loadout. `builder` is merely the example's chosen default, not a fixed extension default.
- Each loadout requires nonempty `skills` and `tools` arrays. A skill can be `builtin:planner`, `builtin:orchestrator`, `builtin:builder`, `builtin:reviewer`, or a path to a Markdown skill file. Paths may be absolute, `~/...`, or relative to the **config file's directory**. Each file needs YAML frontmatter with a unique lowercase `name:`; that name is reported when the peer joins. The bundled skills are starting points, not mandatory role choices.
- `tools` lists native tool names for the chosen harness, with matching case. Pi must include `j01n`; Claude Code must include `Bash`, which its peer uses to run the bundled Node helper. Unknown/unavailable native tools or missing model authentication may still fail when the harness starts; the config validator checks syntax and the required coordination tool, not your entire installation.
- Optional `model` sets the harness's startup `--model` argument. Leave it out to use **that user's existing Pi or Claude Code default**; there is no extension-selected model. To pin one role, add, for example, `"model": "your-provider/your-installed-model"` to its loadout, replacing the placeholder with a model your harness can actually run. Optional `provider` is lowercase **reported metadata**, not a credential or a provider switch. Configure authentication in Pi or Claude Code itself.

The host resolves and validates the selected loadout once, before launch. Changes to the file affect subsequent spawns; an already-launched peer keeps the startup settings and skill names selected for it. Editing the file does not require `/reload`; changing extension code does.

## Using it safely

Ask the joined Pi host directly to spawn a peer with a bounded `task` and, optionally, `role`, `harness`, `name`, `branch` (a new isolated worktree), or `directory` (an existing absolute checkout). `branch` and `directory` cannot be combined. For example, ask: “Spawn a Claude Code reviewer to check the authentication tests on an isolated branch.” The host selects `reviewer/claude` **only if you defined it**. The tool accepts no per-call model, skill, tool, provider, or arbitrary startup flags.

A spawn needs Herdr, a joined host, an installed/authenticated target harness, and a direct human delegation. The default budget is **one spawn attempt per Pi session**; the human starting Pi can set `J01N_PEER_SPAWNS` to 1–5. A room message cannot grant spawn authority or alter your personal config. The host does not put a room link in the Herdr prompt; the invitation is sealed to the registered peer inbox. Confirm the participant joined rather than treating an invitation as proof.

Pi peers start with only the configured skills/tools and no MCP; Claude Code receives the configured skill files as startup instructions (not installed slash-command skills) and still follows its normal tool approvals. These fixed launch-safety flags are **not** config settings. The reported role, harness, skills, provider, and model are room metadata, not access control. A reviewer with a shell tool can still modify files: use worktrees and code review rather than relying on a role label as a sandbox.

For sprint integration and cleanup, see the [operator runbook](SPAWN-RUNBOOK.md). For installation and other room commands, see the [Pi extension README](../packages/pi-extension/README.md).
