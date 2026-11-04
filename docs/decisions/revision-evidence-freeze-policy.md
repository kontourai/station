---
status: current
subject: Freeze Task room revision evidence only when a consumer references it
decided: 2026-10-26
evidence:
  - kind: doc
    ref: docs/design/revision-bound-evidence.md
  - kind: doc
    ref: src-server/services/orchestration/project-task-room-runtime.ts
  - kind: doc
    ref: src-server/services/orchestration/project-task-room-working-state-worker.ts
  - kind: doc
    ref: src-server/services/projects/task-review-module.ts
---

# Task room revision freezes

## Decision

Keep one complete, replaceable candidate per document until a consumer requests
an immutable reference. Claim the exact working revision durably before freezing
and linking it. Task Review must finish that freeze before creating a plan
anchor. Saves retain the last writer's attribution and the last frozen parent;
receipt format, portable validation and immutable retention stay unchanged.
A receipt's actor is therefore the last writer before the freeze, not the
author of every change since its parent; per-save authorship is not evidence.
The [module contract](../design/revision-bound-evidence.md#freeze-and-retention-decision)
owns recovery, admission and local test evidence.

## Alternatives

Freezing every save exhausts a shared 256-receipt / 4 MiB ledger after a short
editing session. Idle timers or session-boundary freezes reduce that rate but
still retain snapshots nobody references, and cannot themselves guarantee a
receipt for a revision referenced before the boundary. They add timer/session
recovery obligations without helping reference correctness, so this decision
uses only explicit references.

Smaller receipts would change canonical identity and portable reconstruction.
Pruning receipts can break active references and transitive parent closure.
Neither is part of this change. Increasing capacity postpones exhaustion and
raises bounded restore costs. Unlimited storage or parent-aware retirement
needs a separate design and migration.

## Existing wedged rooms

Keep older outboxes claimed on upgrade. A successful recovery publishes them
once. A definite size/capacity refusal can release an unmarked claim for
replacement by a later save; it cannot delete or rewrite a committed receipt.
Unknown persistence results retain the claim. A full ledger continues to refuse
new reference creation while allowing editing after a deterministic refusal.
Corruption and genuinely indeterminate publication remain fail-closed.
