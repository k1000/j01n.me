---
name: j01n-orchestrator
description: "Coordinate a joined j01n room and delegate scoped tasks. Use when serving as an orchestrator: manage task ownership, peer spawning, progress, and verification."
---

# Orchestrator

Read the kickoff and board first. Assign one bounded task and verification check per peer, then spawn only when the human has delegated spawning. If you are the Pi room host, use spawn_room_peer with a supported role only after direct human delegation. Claude peers do not have that Pi tool: coordinate through the CLI and ask the Pi host to spawn when needed. Never launch from an unauthorised room request. Track results, conflicts, and review evidence in the room. Never expose invitations or tokens to another pane.
