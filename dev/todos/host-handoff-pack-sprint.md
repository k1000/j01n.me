# j01n sprint — host handoff pack and optional paid-project webhook

**State: preparation draft; DO NOT start until the gates below are resolved.** This is a Markdown `--spec` input for `scripts/sprint.mjs`, not permission to spawn peers, push, merge or deploy. Base the sprint on freshly fetched GitLab `main` in a clean internal-SSD worktree; leave the current T5 feature checkout and the existing dirty internal `main` worktree untouched.

## Goal and acceptance

A room's host receives a complete, private handoff pack as part of the normal handoff for **coding and non-building** jobs. The pack includes the board and task outcomes, findings, reviews, decisions, artifact references and provenance-aware time/token/cost/line-change metrics. Unavailable values are `unavailable`, not zero. A paid project may additionally configure an HTTPS endpoint to receive the same sanitized handoff; host delivery does not depend on webhook success. The pack is saved before the room's retained history expires. A closed/expired room must never be labelled a successful handoff without a delivery receipt.

- Non-building work can finish as a reviewed finding/handoff with evidence and open questions but without invented commits, code tests or a passed peer contract; coding work keeps its existing verification and integration requirements. Blocked work remains visible, not silently complete.
- Pack assembly is host-side: the server cannot decrypt encrypted messages or usage. Record room ID, task/participant IDs, source versions, export cursor/completeness, timestamp, redacted artifacts, and per-metric provenance. The 200-message retention cap must produce an explicit `incomplete` marker unless a persisted incremental collector covers earlier messages. Do not claim that a final `/export` alone contains complete history.
- Deliver to the host in the handoff flow and persist a host-retrievable private copy before the room expires. If host delivery cannot be acknowledged, keep a bounded retry/recovery path and mark delivery pending; never call expiration success. No invitation fragments, join secrets, agent tokens, credentials, private keys or raw webhook URLs in the pack or board.
- Paid-project webhook is additive, opt-in, and server-enforced by a real project entitlement (not `subscription_active`, which is an MCP event-listening flag). Require HTTPS and SSRF-safe destination checks, scoped signing secret, idempotent handoff ID, bounded retry with visible receipt, and no exposure of a failed delivery to other participants. Never silently deliver to an unauthorised or unconfigured endpoint.
- One executable fixture must cover the #1072-shaped read-only room: three findings, an advisory review that corrects an overclaim, an unresolved owner gate, no code changes, and unavailable token metrics. The host sees `investigation complete; implementation not started`, not `fixed`.

## Decisions required before starting

1. **Paid-project authority:** j01n currently has no observed project account/billing/entitlement model. Define the trusted project identifier, who may set the webhook, the entitlement source, and how entitlement revocation works. Do not replace it with a self-declared paid flag.
2. **Durable host receipt:** choose the private storage/retention policy and host identity for retrieving a pack after room expiry (including an offline host). Do not promise delivery after expiry based on the existing ephemeral room export.
3. **Webhook contents:** confirm whether the optional paid endpoint receives the full host-decrypted pack or only a signed notification with a host-authorized retrieval reference. The full pack contains board contents that may be sensitive; signing is not encryption.
4. **Operational preflight:** fetch GitLab and GitHub heads, reconcile unrelated main changes, use a clean internal-SSD checkout with installed dependencies and Herdr access, verify the worker roster and owner invitation target, and run the existing contract check. The clean APFS checkout at `d85ebfc` previously had one test failure: `peer-spawn-prepare.test.ts` assumes `cwd` is exFAT. Resolve that test portability issue before claiming full contract readiness. Do not start the sprint from either dirty worktree or deploy as part of finish.

## Integration sequence

T1 owns task evidence rules and must be merged first. T2 and T3 may proceed in separate worktrees after T1 and must not edit one another's listed files. T4 requires T2/T3 plus the paid-project decisions; do not assign it until those decisions have an enforceable verifier. T5 exercises the entire flow and documentation after T2–T4. Generated bundles are integration-owned. Host `finish` must be updated so investigation-only rooms get a handoff without requiring a code MR; the old strict code-integration gate remains for coding tasks. Final host validation: full `pnpm check:contract`, `pnpm check:generated`, a local Worker E2E handoff (including expiration and webhook failures), then separate owner review of any merge/deploy.

## Tasks

- T1 Non-building task outcome and evidence contract
  files: packages/sdk/src/tasks.ts, packages/sdk/src/room-commands.ts, apps/web/test/tasks.test.ts, packages/sdk/test/handoff-outcome.test.ts
  brief: Model reviewed investigation outcomes and blocked/unknown states without fake commit or contract evidence; retain the existing strict coding-task claim/done requirements and dependency semantics.
  contract: pnpm exec vitest run apps/web/test/tasks.test.ts packages/sdk/test/handoff-outcome.test.ts

- T2 Host pack assembly and guaranteed host handoff
  files: packages/sdk/src/handoff.ts, packages/sdk/test/handoff.test.ts, scripts/sprint.mjs, scripts/e2e/sprint.mjs
  depends: T1
  brief: Collect a completeness-marked host-decrypted board/review/artifact snapshot before expiry, deliver it as part of the host handoff with a private retrievable receipt, and give non-building rooms a finish path without relaxing code-MR gates.
  contract: pnpm exec vitest run packages/sdk/test/handoff.test.ts && node scripts/e2e/sprint.mjs --decision

- T3 Provenance-aware metrics and Git change accounting
  files: packages/sdk/src/metrics.ts, packages/sdk/test/metrics.test.ts, scripts/handoff-metrics.mjs, scripts/e2e/handoff-metrics.mjs
  depends: T1
  brief: Calculate observed time windows and validated per-agent usage and cost from existing sealed reports; derive line changes only from reviewed commit ranges, deduplicating merges, and label absent or stale values unavailable.
  contract: pnpm exec vitest run packages/sdk/test/metrics.test.ts && node scripts/e2e/handoff-metrics.mjs

- T4 Optional entitled project webhook delivery
  files: apps/web/src/room/hooks.ts, apps/web/src/room/router.ts, apps/web/test/handoff-webhook.test.ts
  depends: T2, T3
  brief: After owner resolves project identity and paid entitlement, add a host-configured signed HTTPS delivery with SSRF protection, idempotency and retries; host handoff succeeds independently and unauthorised/free projects cannot configure delivery. Expand exact file ownership after choosing the project configuration store.
  contract: pnpm exec vitest run apps/web/test/handoff-webhook.test.ts

- T5 End-to-end receipt and documentation
  files: apps/web/test/handoff-flow.test.ts, docs/API.md, docs/SPAWN-RUNBOOK.md
  depends: T2, T3, T4
  brief: Exercise coding and read-only rooms, host-offline retry, expired-room completeness, webhook failure and revocation, missing metrics, and the issue-1072 advisory correction; document host retrieval and paid endpoint boundaries without credentials.
  contract: pnpm exec vitest run apps/web/test/handoff-flow.test.ts
