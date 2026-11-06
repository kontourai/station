---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-cli': minor
---

Automation policy changes are explained and scoped (#4511), the operator
surface is complete (#4513), and the isolated-repair tick refuses intents whose
rule was deleted or changed kind (#4575).

Policy: a retained action's fingerprint covers only authority-bearing fields
(the source's repository, enabled/revoked state and the grant for this rule's
Project, Agent and action; the rule's mode, matcher and action). Renaming a
rule or a source, or changing a rate limit, episode policy or poll interval,
no longer stops work. A change to the action's instructions or budget is an
amendment: the action adopts it and the running Session gets the new text as
its next turn. Any other change is a revocation: automatic work stops, the
Session is marked blocked and the Task moves to `blocked`, both with the
reason. A person's own turn into that Session is admitted under their
authority (no rule budget, and Ask instead of an inherited Auto) and the
Session becomes theirs. Intents retained before this change still match
until their rule or source changes in any way.

Task reads (`GET /api/tasks/:taskId` and `/graph`) carry `automation`
(`AutomationTaskProjection`): the immutable `AutomationTaskMandate` the Task
started under, its amendments, revocation and hand-over. Task Details shows it
as "Started by automation".

Operator surface: every `AUTOMATION_OPERATOR_SURFACE` verb has a route, an SDK
function and a `station automation` action, plus the new `update-rule`
(`PUT /automations/rules/:target`). Station Control MCP gains the four read
tools only. Mutations need the operator in person and edit `dispatch-task`
rules only. `retry-episode` gives an exhausted episode exactly one more
attempt under the rule's current policy.

Ledger: a held claim records `suppressed` with its reason (`rate-limited`,
`rule-active-limit`, `concurrency-limit`, `episode-active`,
`episode-exhausted`, `episode-indeterminate`). A refused intent keeps its
refusal reason (`policy_changed` and the new `admission_refused`), never
`policy_unavailable` by default.

Breaking for type consumers: `notify` is no longer an action kind and
`received` is no longer a delivery outcome; nothing ever executed or wrote
either. A stored grant listing `notify` drops it on read; a stored `notify`
rule makes the configuration unreadable (fails closed). Downgrade: once an
episode has been retried, an older Station cannot open the ledger and reads
Automation as `policy_unavailable` (fails closed).
