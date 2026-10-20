---
"@kontourai/station-contracts": minor
---

Session inventory: a current-answer projection now parses whatever the Surface answer state is (unavailable, stale, corrupt, restricted, unsupported-version, not-captured or observed-empty). It still has to be bound to the scope's exact Session and turn. When the answer is available, its reference must still equal the bound answer exactly. When it is not available, the projection may not carry rows bound to an answer (`surface-answer-contribution`). A partial Basis outage therefore keeps the inputs, execution and other groups resolved for the turn instead of discarding the whole inventory.

Current-answer rows may now be turn lineage without `contributed-to`. A row whose relations are only `observed-during` or `produced-by` (both still limited by the per-kind relation table) is admitted when it carries the scope's exact turn: `turnId` for tool results, decisions, delegations and work items, and `output.turnId` for outputs. `contributed-to` remains the only edge meaning support. Kinds with no turn binding, including the Session resource summary, stay out of current-answer lineage.

`station-request-decision` and `station-delegation` rows gain an optional `turnId`. It is required for a lineage-only current-answer row and optional elsewhere. Readers built against an earlier contracts version reject rows that carry it, so writers should emit it only to readers on this version or later.
