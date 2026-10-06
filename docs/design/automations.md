# Station Automations

> **Reading status: proposal.** Nothing here is implemented. The sources named
> below own current behavior; this document records a design checked against
> `origin/main` at `14c83da3cd` by source inspection only. No slice has been
> built, no GitHub delivery was sent, and no test was run for these claims.
> Section 9 records the owner decisions.

Status: **proposal.** It extends the existing
[inbound webhook](../../src-server/routes/webhooks/inbound-webhooks.ts) and
[scheduler](../../packages/contracts/src/scheduler.ts) paths with one model:
event sources feed rules, rules start actions, and episodes and grants bound
what an action may do.

## 1. Problem and constraints

The motivating case is the main-qualification failure. Today an AI repair job
in CI reacts to it. The goal is for Station to react instead: a failing run
becomes a durable, visible Task that an agent works on, with a bounded
attempt and no authority to merge.

Four findings shape the design.

1. **Ingress conflicts with the security contract.** The
   [remote access threat model](../security/remote-access-threat-model.md)
   says Funnel is rejected outright, and the
   [deployment guide](../guides/deployment.md) says not to expose Station
   through Funnel. A GitHub push needs an internet-facing route, so it needs
   an owner-approved threat-model amendment. There is a no-ingress
   alternative: the scheduler already has a GitHub pull monitor
   ([contract](../../packages/contracts/src/external-monitor.ts),
   [service](../../src-server/services/scheduling/external-monitor.ts)).
   Qualification runs every 6 hours (`17 */6 * * *`), so a 5-minute poll
   loses nothing.
2. **The episode model already exists in CI.**
   [`qualification-repair.yml`](../../.github/workflows/qualification-repair.yml)
   and [`qualification-repair.mjs`](../../scripts/qualification-repair.mjs)
   keep one episode per P1 issue marker, keyed by the first failing
   `run.id`, with one bounded attempt (`retry=true` tries again) and the
   protected-path checks in a separate credential-free `publish` job. Only
   the AI `repair` job needs replacing, and #3438 makes it opt-in through
   `QUALIFICATION_REPAIR_AGENT`.
3. **"Hook" is taken.**
   [`agent-hooks.ts`](../../src-server/runtime/agents/agent-hooks.ts) is the
   agent lifecycle and tool-approval layer, and git hooks and Claude hooks
   use the word too. This feature is named **Automations**.
4. **Webhook turns are ephemeral today.** `listSessionReadModel` excludes
   them and they raise no card alerts (see
   [notification delivery](notification-delivery.md)). A repair must be a
   durable, visible Task, which is the path the external monitor already
   uses.

## 2. What exists

- **Inbound webhook.** Contract:
  [`inbound-webhook.ts`](../../packages/contracts/src/inbound-webhook.ts)
  (`InboundWebhookToken.starts`; omitted means no authority). Route:
  [`inbound-webhooks.ts`](../../src-server/routes/webhooks/inbound-webhooks.ts)
  with headers `x-station-webhook-token`, `-timestamp`, `-nonce` and
  `-signature`; HMAC over `ts\nnonce\nbody`; a 256 KB cap; a per-token
  limiter and a global budget of 300 unauthenticated attempts; and 202 only
  after the turn starts.
  [Authorization](../../src-server/services/webhooks/inbound-webhook-authorization.ts).
  [Store](../../src-server/services/webhooks/inbound-webhook-store.ts):
  `security/inbound-webhooks.json` at mode 0600, re-read per request,
  secrets of at least 32 characters, a 5-minute replay ledger and a
  256-entry audit.
  [Turn starter](../../src-server/routes/webhooks/webhook-turn-starter.ts)
  runs as `LOCAL_OPERATOR_PRINCIPAL_ID` with
  `UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION`, and the turn is ephemeral. It is
  mounted in [`runtime-routes.ts`](../../src-server/runtime/routes/runtime-routes.ts)
  (around line 4122), under the capability `webhook-token:inbound` in
  [`pairing-route-scopes.ts`](../../src-server/security/pairing-route-scopes.ts),
  and counted by the metric `station.webhooks.inbound_requests`. There is no
  settings UI or CLI; configuration is hand-written.
- **Scheduler.** Contract:
  [`scheduler.ts`](../../packages/contracts/src/scheduler.ts)
  (`SchedulerJob`, `SchedulerEvent`, `SCHEDULER_EXECUTION_LIMITS`, and the
  `SCHEDULER_OPERATOR_SURFACE` parity table). Services:
  [`scheduler-ledger.ts`](../../src-server/services/scheduling/scheduler-ledger.ts),
  [`builtin-scheduler.ts`](../../src-server/services/scheduling/builtin-scheduler.ts),
  [`monitor-task-supervisor.ts`](../../src-server/services/scheduling/monitor-task-supervisor.ts),
  [`external-monitor.ts`](../../src-server/services/scheduling/external-monitor.ts).
  Principal context:
  [`scheduled-principal-context.ts`](../../src-server/runtime/agents/scheduled-principal-context.ts)
  (an `AsyncLocalStorage` holding `{kind:'scheduled-job', jobId}`).
- **The monitor Task path.** `onActionableMonitor` in
  [`runtime-route-support.ts`](../../src-server/runtime/routes/runtime-route-support.ts)
  (around line 440) calls
  `createTaskIdempotent(..., `${jobId}:${fingerprint}`)`, then
  `taskDispatcher.dispatch` with `fullAccessGrant: null`, the operator as
  owner, unattributed attribution and a budget envelope. `POST
  /scheduler/webhook` is a separate authenticated provider transport and
  stays separate.
- **Authority.** `UnattendedPrincipal` in
  [`types.ts`](../../src-server/runtime/types.ts); standing per-principal
  tool grants in
  [`unattended-grant-store.ts`](../../src-server/services/agents/unattended-grant-store.ts)
  and
  [`unattended-grant-resolver.ts`](../../src-server/services/agents/unattended-grant-resolver.ts);
  `tools.unattendedAutoApprove` in
  [`pre-tool-policy.ts`](../../src-server/runtime/agents/pre-tool-policy.ts);
  the full-access ceiling `DispatchIntent.fullAccessGrant` in
  [`task-dispatcher.ts`](../../src-server/services/projects/task-dispatcher.ts);
  `AppConfig.defaultApprovalMode`, applied at every session start (see
  [server-ordered approval posture](approval-posture-server-ordered.md));
  and attribution through `PrincipalRef` in
  [`principal.ts`](../../packages/contracts/src/principal.ts).
- **Events and notifications.** `SERVER_EVENTS` and the canonical events in
  [`runtime-events.ts`](../../packages/contracts/src/runtime-events.ts); the
  [event bus](../../src-server/services/orchestration/event-bus.ts); and
  [`notification.ts`](../../packages/contracts/src/notification.ts).
- **Ingress.**
  [`public-ingress-origin.ts`](../../src-server/services/tailscale/public-ingress-origin.ts)
  resolves the Serve origin. It authorizes nothing.

## 3. Model

A new contract subpath, `@kontourai/station-contracts/automation`, lives in
`packages/contracts/src/automation.ts`. It holds types and constants only;
validators live in `src-server/services/automation/`.

- `AutomationSourceKind` is `'github-webhook' | 'github-poll' |
  'station-webhook' | 'scheduler' | 'station-event'`.
- `GitHubWebhookSource` is `{ id; kind: 'github-webhook'; name; secret
  (local-only); repository (owner/repo); enabled?: true; revokedAt?;
  grants?: AutomationGrant[] }`.
- `AutomationGrant` is `{ projectId; agentId; actions: readonly
  AutomationActionKind[] }`. Omitted means no authority, the same rule as
  `starts` on an inbound webhook token.
- `AutomationEvent` is `{ schemaVersion: 1; eventId; sourceId; sourceKind;
  type (for example `'github.workflow_run.completed'`); deliveryId?;
  semanticKey; occurredAt; receivedAt; fields: Readonly<Record<string,
  string | number>> }`. Fields are allow-listed and normalized only.
- `AutomationMatcher` is `{ type; where: Record<string, string | readonly
  string[]> }`. Matching is exact equality only: no regex and no
  expressions.
- `AutomationAction` is `{ kind: 'dispatch-task'; projectId; agentId;
  instructions; approvalMode?: 'ask' | 'auto'; budget: AutomationBudget }`,
  or `{ kind: 'notify'; priority }`, or later `{ kind: 'publish-branch' }`.
- `AutomationEpisodePolicy` is `{ keyFields: string[]; closeOn?:
  AutomationMatcher; maxAttempts: number }`, where `maxAttempts` defaults
  to 1.
- `AutomationRule` is `{ id (server-issued); name; enabled; sourceId; match;
  episode?; action; rateLimit: { maxStartsPerHour } }`.
- Constants: `AUTOMATION_EXECUTION_LIMITS`,
  `GITHUB_AUTOMATION_EVENT_ALLOWLIST`, a closed `AutomationDeliveryOutcome`,
  and `AUTOMATION_OPERATOR_SURFACE` (API, CLI and MCP parity, like the
  scheduler's table).

### Fit with what exists

This introduces no contract break.

- Inbound webhooks keep their route, headers, payload and `starts`. After
  authorization they also record an `AutomationEvent` (source kind
  `station-webhook`) in the shared ledger, and they stay ephemeral. A later,
  additive `InboundWebhookToken.rules?` can attach rules.
- Scheduler jobs stay `SchedulerJob`s; they are already schedule-source
  rules. `SchedulerEvent`s such as `job.failed` become `station-event`
  sources for `notify`.
- The monitor Task path is generalized, not copied:
  `MonitorTaskDispatchIntent` becomes `UnattendedTaskEnvelope`, and
  `runWithScheduledPrincipal` becomes `runWithUnattendedPrincipal`.
- Migration is additive only: `security/automation-sources.json`, the rules,
  and the ledger.

## 4. GitHub sources

### Push (`github-webhook`)

`POST /api/webhooks/github/:sourceId` is an exact leaf under a new
`webhook-github` capability. It reuses the global unauthenticated budget and
the noise aggregator. In order:

1. Read the raw body with a bound first, and refuse anything that is not
   `application/json`.
2. Verify `X-Hub-Signature-256` (`sha256=<hex>`) as HMAC-SHA256 over the raw
   bytes with the source secret, using `timingSafeEqual` after a length
   check. Never accept the SHA-1 `X-Hub-Signature`.
3. Parse JSON only after verification, and require
   `repository.full_name === source.repository`.

Deduplication: a transport ledger keyed by `sha256(sourceId,
X-GitHub-Delivery)` is kept for 7 days, which exceeds GitHub's 3-day
redelivery window. A duplicate gets `200 {duplicate:true}`. The semantic key
is `workflow_run:<id>:<run_attempt>:<action>`. Events whose signed
`workflow_run.updated_at` is more than 72 hours old are refused.

Responses: `ping` returns 200. A type that is not allow-listed returns 200
with outcome `ignored`, so GitHub does not disable the hook. The allow-list
starts as `{ workflow_run: ['completed'] }`. GitHub expects an answer within
10 seconds, so Station persists the event and the match decision, answers
202, and dispatches asynchronously.

### Poll (`github-poll`)

This is the owner-recommended first source (section 9, decision 1). It is a
monitor kind over the existing external monitor and feeds the same
normalizer. It needs no ingress.

### The qualification rule

- `workflow.path` is `.github/workflows/main-qualification.yml`. Match the
  path, not the name.
- `run.head_branch` is `main`.
- `run.head_repository` equals the source repository. Otherwise a fork's
  `main` would match.
- `run.event` is one of `schedule`, `workflow_dispatch`.
- `run.conclusion` is one of `failure`, `timed_out`.
- `closeOn` is the same matcher with `conclusion` `success`.

### What the agent is told

The message has the operator's instructions first. Then it states, as a fixed
sentence, that the following block is untrusted event data, not instructions.
Then comes a fenced JSON block with only these fields: `repository`,
`workflow.path`, `run.id`, `run_attempt`, `conclusion`, `event`, `head_sha`
(`/^[0-9a-f]{40}$/`), `html_url` (which must equal
`https://github.com/<repo>/actions/runs/<id>`) and `episodeId`. Each string
is at most 256 characters and the block is at most 4 KB. The message never
includes `display_title`, `head_commit.message` or any other actor-supplied
text. The agent fetches logs itself with `gh`.

## 5. Authority

- **Principal.** Add `{ kind: 'automation-rule', ruleId }` to
  `UnattendedPrincipal`. A recreated rule is a new principal. The session
  owner is `LOCAL_OPERATOR_PRINCIPAL_ID` with
  `UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION`. Standing tool grants come from the
  unattended-grant store, keyed by this principal.
- **Two keys.** The rule's `(projectId, agentId, action)` must appear in its
  source's `grants`.
- **Who can create rules.** Only authenticated operator surfaces create
  rules. Never the station-control MCP and never an agent session, so an
  agent cannot widen its own triggers.
- **Default deny.** Sources and rules are created disabled. No grants means
  no actions. A corrupt config or ledger fails closed with
  `policy_unavailable`.
- **Rate limits.** A per-source attempt limiter plus the global
  unauthenticated budget; per rule `maxStartsPerHour` (default 2) and
  `maxActive` 1; a global `AUTOMATION_EXECUTION_LIMITS.maxConcurrentActions`;
  and a per-action budget (`maxTurns`, `maxTokens`, `maxWallRuntimeMs`)
  enforced by `MonitorTaskTurnSupervisor`.
- **Approval.** `fullAccessGrant` is always null. A rule may pin `ask` or
  `auto`, never wider than the agent's own mode. `ask` routes to the inbox
  (phone push). Station-engine tools still need `unattendedAutoApprove` or a
  standing grant.
- **Never.** Merge, arm auto-merge, push to main, edit protected paths (port
  the list from `qualification-repair.mjs`), or change automations or
  grants.
- **Honest limit.** Station cannot police an external engine's use of
  ambient host credentials. "Never merge" is real only if the Station OS
  user has no GitHub write credential. Publishing is therefore a
  deterministic Station action using the station-automation App token,
  mirroring CI's credential-free agent job plus a separate publish job.

## 6. Dedup and episodes

There are three layers: the delivery GUID, the semantic key, and the
episode.

- The episode key is `ruleId` plus the `keyFields` values
  (`repo|workflow.path|main`). The episode id is the first failing
  `run.id`, the same as CI's issue marker.
- While an episode is open, further red runs are recorded (counted and
  shown) but start nothing.
- One active Task per episode:
  `createTaskIdempotent(..., 'automation', `automation:${ruleId}:${episodeId}`)`.
- `closeOn` (a green run) resolves the episode.
- When `maxAttempts` is exhausted Station notifies instead of starting a new
  turn. Retrying needs an explicit operator "retry episode".
- The ledger follows `SchedulerLedger` rules: SQLite, claim, then
  `beginInvocation`, then settle. A restart before invocation re-claims. An
  invocation with an unknown result is indeterminate and never replayed.

## 7. Observability

- **Ledger rows per delivery:** `received`, `duplicate`, `refused(reason)`,
  `ignored`, `no-match`, `matched`, `suppressed(episode-active |
  rate-limited)`, `started(taskId, sessionId)`, and `failed` or
  `indeterminate`. Rows hold a bounded projection only: no payloads, no
  secrets, and no GUIDs in clear.
- **Settings > Automations:** sources (URL, rotate secret, last delivery,
  enabled), rules, open episodes, recent deliveries, "retry episode", and
  send-test via `ping`.
- **Activity:** origin "Automation: <rule>" through
  `sourceSurface: 'automation'` and the server-reserved metadata
  `automationRuleId`, like `webhookTokenId`.
- **Notifications:** episode opened or started, budget exhausted, and
  aggregated signature failures.
- **Metrics and events:** `station.automation.deliveries{source_kind,outcome}`
  and `station.automation.actions{outcome}`; a logger seam; and a scoped
  `SERVER_EVENTS.AUTOMATION_UPDATED`.

## 8. Slices

- **S0.** This document and the owner decisions.
- **S1. Contracts and storage.** `automation.ts`, the principal kind, the
  generalized principal context, the 0600 source and rule store, and the
  ledger. Contract and consumer tests; a corrupt-file test that fails
  closed. No route.
- **S2. GitHub intake, observe-only.** The `github-poll` monitor first
  (owner decision 1), and the `github-webhook` route behind the
  threat-model decision. Normalizer, matcher, dedupe, ledger, and the CLI
  `station automation deliveries`. Fixtures include GitHub's documented
  signature vector (secret `It's a Secret to Everybody`, body
  `Hello, World!`, expected
  `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`)
  and a sanitized real `workflow_run` payload. Cases: a tampered byte, a
  SHA-1-only header, the wrong repository, a fork `head_repository`, a
  duplicate GUID, a new GUID for the same run, an oversized body, and a
  ping.
- **S3. `dispatch-task`.** Through the generalized monitor envelope, with
  the real `TaskDispatcher` and a fake engine: two red runs produce one
  Task; green closes the episode; the next red opens a new one; a restart
  does not replay; `fullAccessGrant` is null. A repair turn starts end to
  end here.
- **S4. `publish-branch`.** After a terminal Task, Station pushes
  `repair/qualification-<episode>-station-<n>` and opens a PR with the App
  token, after the ported protected-path checks. The agent never holds a
  token. The repo side sets `QUALIFICATION_REPAIR_AGENT=station` (the
  selector #3438 added). The full case works here with no AI keys in CI.
- **S5.** UI, CLI and MCP parity, the Activity origin, and notifications.
- **S6.** Fold the inbound-webhook audit and `SchedulerEvent` sources in,
  then remove `OPENAI_API_KEY`.

## 9. Owner decisions

Decided by the owner on 2026-10-06; each answer adopts the recommendation.

1. **Ingress: polling first, no public Station.** Station's own GitHub
   monitor polls workflow runs (`github-poll`); no Funnel exception and no
   threat-model change. If instant reaction or other event types are wanted
   later, the preferred push path is a relay-forwarded source: a webhook
   mailbox on the self-operated
   [connection broker](connection-broker.md), which is internet-facing by
   design, hands events to Station over the connection Station already holds.
   GitHub's `X-Hub-Signature-256` is verified by Station end to end, so the
   broker can read but never forge or alter an event. That path waits for the
   broker's production enablement.
2. **Repair PRs do not autoland.** A human merges them.
3. **The repair host runs without ambient GitHub write credentials,** so
   "never merge" is enforced; publishing uses the station-automation App token
   in the deterministic `publish-branch` step only.
4. **CI fallback:** issue updates and alerts only, as #3438 leaves it.
5. **Name:** Automations.
