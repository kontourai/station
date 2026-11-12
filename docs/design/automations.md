# Station Automations

> **Reading status: retained proposal with default-off implemented previews;
> tracked by [#3439](https://github.com/kontourai/station/issues/3439).**
> Current owners are the [Automation contract](../../packages/contracts/src/automation.ts),
> [configuration store](../../src-server/services/automation/automation-store.ts),
> [SQLite ledger](../../src-server/services/automation/automation-ledger.ts),
> [Task action runtime](../../src-server/runtime/automation-actions-runtime.ts), and
> [isolated repair controller](../../src-server/services/automation/repair-controller.ts).
> The operator repair API can create disabled poll sources/rules and enable an
> exact configuration. The original broader proposal below remains a design;
> it does not describe every currently implemented source, file or UI.
> See [bounded agent work](../guides/agent-efficiency.md#run-an-isolated-github-repair)
> for the implemented setup, review, publication and recovery path. Fixtures
> establish caller behavior; container qualification, live model/account use,
> release qualification and broader S5/S6 delivery remain separate evidence.

> **Automation is the umbrella.** Since
> [the automations decision](../decisions/automations-unify-schedules.md),
> Automations is the product surface for scheduled work: a scheduler job with
> an optional target runs each time as a turn in a conversation, on any engine,
> and agent check-backs are listed with it. That part ships. The GitHub event
> sources now have the default-off observation and bounded Task-action previews
> described below. An isolated repair/publication API preview is also available; broader sources and full management UI remain proposed. They extend
> the same Automations surface.

Status: **proposal.** It extends the existing
[inbound webhook](../../src-server/routes/webhooks/inbound-webhooks.ts) and
[scheduler](../../packages/contracts/src/scheduler.ts) paths with one model:
event sources feed rules, rules start actions, and episodes and grants bound
what an action may do.

## Observe-only GitHub preview

Enable **GitHub automation observations** in **Settings → Advanced → Feature
previews** on a personal Station. Hosted mode does not offer these observations.
The observation preview makes GitHub API requests but invokes no model,
creates no Task and publishes no branch. The separately enabled actions preview
can dispatch explicitly granted matching rules into bounded Tasks. Sources and rules
remain operator-managed private configuration; enabling the preview alone does
not configure a source or grant an action.

The runtime reads its own Station home's `security/automations.json`, validates
both source grants and every rule that is not `off`, and polls on the existing
scheduler tick.
Each source has its own interval (five minutes by default). Disabled previews
perform no polling or ledger allocation. Disabling the preview or changing a
source while its request is in flight discards that request's observations;
turning it off prevents the next operation without deleting retained history.

A poll reads at most 20 completed runs per workflow file, up to four pinned
files, or one repository-wide page when rules do not pin that bounded set.
This is a bounded observation window, not a complete repository history. A
response advertising additional runs records `partial`, retains the observations
it actually received, and does not advance the cursor. A complete response may
advance the cursor through accepted timestamps with a ten-minute overlap.
Malformed and future-dated timestamps cannot advance it. Long-running work
outside the returned page is not qualified by this preview.

`station automation deliveries --limit=50` returns an `AutomationDeliveryPage`:
`deliveries` contains bounded, payload-free records; `polls` shows each observed
source's last poll time, last accepted cursor when present, and `ok`, `partial`,
`unauthorized` or `unavailable`. A failed poll does not erase earlier evidence or
advance its cursor. Configuration/storage errors remain failures, not empty
success. This command requires management access; a disabled preview responds
with `feature_preview_disabled` and its Settings link.

Delivery deduplication, opening/closing episodes and their delivery references
commit together. A failed episode write leaves the delivery retryable after
restart. Repeat observations do not reopen or re-close episodes. An episode here
records rule matching only: it does not establish diagnosis, repair or release
completion. The separate `github-automation-actions` preview consumes retained
normalized action intents through the real Task dispatcher and durable inbox.
Signed push ingress and automatic publication remain separate.

### Bounded Task actions

Enable **GitHub automation Tasks** separately from observation. An accepted
match retains its normalized action intent atomically with delivery and episode
state. Dispatch rechecks current source, rule, grant and policy fingerprint;
capacity refusal does not spend an execution attempt. Claims fence concurrent
starts and rule rate limits. The actual provider-start boundary persists the
invocation transition before the effect; uncertain effects retain their original
identity and are not retried as fresh work.

The actions preview is global, not a per-rule dry run. While it is disabled,
intake still retains pending Task-action intents for `live` rules, and the
action runtime skips them instead of refusing them. Enabling the preview can
dispatch retained intents whose events are less than 72 hours old, whose policy
fingerprint is unchanged, and whose episode remains open, subject to the other
admission checks. To see what one rule would do without letting it act, use
its `observe` mode (below), not the preview.

### Per-rule observe mode

Each rule has a `mode` (#4509):

- `off`: intake ignores the rule.
- `observe`: the default for a new rule. Intake evaluates the rule but never
  acts on it.
- `live`: the rule acts, subject to its source grant, the actions or repair
  preview, and every consumer-time check.

A rule stored before this change has `enabled: boolean` instead. The store
reads `false` as `off` and `true` as `live`, and the next write stores `mode`.
A rule that has both fields, or a non-boolean `enabled`, makes the
configuration unreadable, so it fails closed.

Downgrade: after any write by this version, every rule in
`security/automations.json` carries `mode`. An older Station refuses that
key, so it reads the whole configuration as `policy_unavailable`. That fails
closed: its poller logs `Automation policy unavailable; poll skipped`, and
its action consumers find no readable policy, so nothing is polled or
dispatched. That holds until the file is restored or the rules are
hand-edited back to `enabled`. Its validation detail (`rules[N]: unknown field
mode`, `enabled must be a boolean`) is logged server-side only when its
delivery history route is read.

The configuration `schemaVersion` stays `1`. `AUTOMATION_SCHEMA_VERSION`
also versions retained events and intents, so bumping it would invalidate
retained intents. A separate configuration version would only change the
older Station's detail to `unsupported schemaVersion`; it fails closed
either way.

Creating a rule starts observing immediately once its source is enabled and
grants its action. An `observe` rule counts as an evaluable rule, so its
source is polled on its interval, spending GitHub API quota. Each matched run
records a delivery that holds that run's semantic dedupe key. Disable a rule
with `mode: "off"` when you do not want that polling. Set a mode through
`POST /api/isolated-repairs/configuration/enable` with
`{kind:"rule",id,mode,expectedFingerprint}`. `enabled:true` or `false` keeps
its earlier meaning there.

For an `observe` rule, intake checks the match, then the episode, then global
concurrency (`maxConcurrentActions`), then the rule's active limit
(`maxActivePerRule`), then `maxStartsPerHour`. This is not `claimAction`'s
order, which checks concurrency, the active limit and the hourly rate before
episode state. Observe checks the episode first because, for a `live` rule,
an event in an already-open episode never retains an intent at intake, so the
episode is what would stop it first. Observe does not open an episode, take a
claim, consume an attempt, or retain an intent, so neither the native Task
runtime nor the isolated-repair controller can start work for the rule. The
episode check covers two cases:

- an unclosed real episode for the key, for example one left while the rule
  was `live`, gives `episode-indeterminate`, `episode-exhausted` or
  `episode-active`;
- the rule's own observe marker gives `episode-active` for a recurring failure
  after the first `would-start`.

The concurrency and active-limit checks read the claims and active intents of
`live` actions only. An observe rule's `would-start`s never count as active,
so these checks do not model what the rule itself would be running had it
been `live`: two quick failures in different episodes can both record
`would-start` where a `live` rule would have waited on `maxActivePerRule`.
The hourly count includes the rule's invoked `live` starts and its own
earlier `would-start` decisions. A matching `closeOn` clears the
marker. It also closes a real episode the rule left open while `live`, because
a stale episode would suppress the rule's next failure once it is `live`
again; closing starts nothing.

Each matched non-notify rule gets one row in `automation_rule_decisions`,
keyed by delivery and rule. The row records the mode, an outcome, an optional
suppression reason, and a snapshot: rule id and name, action kind, Project,
Agent, and episode id. It never holds instructions or event fields. The
outcomes are:

- `would-start` (observe only);
- `suppressed` with a reason;
- `intent-retained` (live: the intent was retained in the same transaction).

`rule-active-limit` and `concurrency-limit` mean the action would have waited
at the time of evaluation; a `live` action held by those limits waits and is
admitted later. `GET /automations/deliveries`, `listAutomationDeliveries` and
`station automation deliveries` return the rows as `decisions` on each
delivery. The delivery's own `ruleId` names the first matching `live` rule
when there is one.

Switching a rule from `observe` to `live` never replays earlier events. None
retained an intent, and the observed delivery still holds its semantic dedupe
key, so a re-poll of the same run records `duplicate`. Only events that arrive
afterwards can act.

The policy fingerprint is still the hash of the whole source and rule, so it
now includes `mode`. Intake retains intents only for `live` rules, so the
fingerprint of every retained intent encodes `live`. A rule moved to `observe`
or `off` no longer matches its fingerprint, and its pending intents are refused
as `policy_changed`. Both consumers also check `mode === 'live'` directly. The
cost of hashing `mode` is a one-time effect at upgrade: an intent retained
before upgrade was hashed over `enabled: true`. If it is still pending when
first read under `mode`, it is refused as `policy_changed`, not dispatched.

Limits and gaps:

- Observe decisions do not evaluate consumer-time checks: the actions or
  repair preview, whether the Project, Agent or repair profile is current,
  and provider admission. A `would-start` means intake-time admission
  passed, not that a Task would have started.
- Observe markers are pruned after the closed-episode retention (31 days),
  while a real episode stays open until `closeOn`.
- Both consumers refuse a pending intent whose rule is not `live` on their
  next tick (`policy_changed`). A consumer whose preview is off does not tick,
  though. If a rule moves to `observe` or `off` and back to `live` while that
  preview stays off, its pending intent keeps a matching fingerprint and can
  still dispatch within its 72-hour window. Disable and re-enable behaved the
  same way before this change.

Task creation and Session seeding alone do not start a repair turn. The actions
runtime submits the framed prompt to the existing durable inbox, retaining the
server-issued intent, original turn key and automation-rule principal. Placement
and final provider admission recheck the policy. Startup restores retained
Session restrictions before scheduler polling, including when the actions preview
is disabled; an unreadable recovery journal cannot authorize a turn.
MonitorTaskTurnSupervisor owns
turn, token and wall limits; full-access grants remain absent. Token enforcement
depends on canonical provider usage arriving; missing usage is unknown, not a
hard billing reservation. A completed action records the first turn terminal,
not Task acceptance or successful repair. A green run closes
the episode and prevents later placement for it.

These Tasks can diagnose the normalized failing run. The quoted `head_sha` is
source evidence, not proof that the execution workspace is that exact checkout.
The current Task dispatcher resolves the Project workspace; source-bound repair
preparation still belongs to the workspace/preparation owner.

### Isolated repair and draft publication

The **Isolated GitHub repairs** preview (`isolated-github-repairs`) is independent
of ordinary Task dispatch. A source must grant `isolated-repair` to the same
Project/Agent pair as its rule. The rule names an enabled execution profile,
immutable Docker image, explicit model, and provider-request/wall budget. It
creates a canonical Task with a separate durable execution; it does not invent
a native ProviderSession or reuse the native Task dispatcher's token limits.

[Source preparation](../../src-server/services/automation/repair-source.ts) reads
admitted immutable Git objects from the Project's local `origin/main`. It binds
the observed failing SHA separately from that selected repair base. After the
exact owned worker is removed, regular-file bytes and modes produce both the
review patch and the expected published tree. The host never runs Git in the
model-mutated workspace. Protected policy, authority, automation and publisher
paths require owner work outside this repair path.

An operator reviews the exact binding/result digests through the private
[repair API](../../src-server/routes/operations/repairs.ts). Approval completes
the Task but grants no publication. A separate, expiring, single-use grant pins
the review and an enabled App publisher profile; the source must additionally
grant `publish-branch`. The [publisher](../../src-server/services/automation/repair-publisher.ts)
uses GitHub Git Data APIs, rechecks main/base/repository/App identity, and opens
a draft with no autoland label. It never merges or arms auto-merge. App secrets
are materialized only after admission and worker-stop verification. Provider
and App references are separate, and external secret-tool reads are bounded
asynchronous process groups.

Unknown worker or publication effects remain indeterminate. Recovery inspects
only the planned container name and exact owner/run labels and never relaunches
an unknown attempt. Explicit operator resolution can release global admission
after ownership and worker stop are settled; it retains unknown-effect evidence,
consumed grants and the no-replay fence. Disabling the preview stops new work;
operator audit, disable, revoke, cancellation, resolution and archival remain
available for cleanup. Setup writes recheck the preview inside their file lock.

The container [qualification command](../guides/agent-efficiency.md#qualify-the-container-boundary)
uses a real pinned CLI and synthetic Responses. The caller fixture uses a real
Task graph and Git source/patch application, with fixture worker and GitHub
transports. Neither establishes live inference/billing or hosted operation.
The ordinary Docker bridge permits outbound traffic; desktop UID mapping and
Windows execution remain unverified. No source or action is enabled by
installation. CI's `QUALIFICATION_REPAIR_AGENT` selector is unchanged; Station's
poller is configured independently and requires no AI key in GitHub CI.

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
   Qualification runs after main source changes with an hourly fallback
   (`17 * * * *`). A five-minute poll is a proposed observation cadence,
   not a guarantee of immediate reaction.
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
  [`unattended-principal-context.ts`](../../src-server/runtime/agents/unattended-principal-context.ts)
  (the shared `AsyncLocalStorage` for server-issued unattended contexts;
  scheduled jobs retain `{kind:'scheduled-job', jobId}`).
- **The monitor Task path.** `onActionableMonitor` in
  [`runtime-route-support.ts`](../../src-server/runtime/routes/runtime-route-support.ts)
  (around line 440) calls
  `createTaskIdempotent(..., `${jobId}:${fingerprint}`)`, then
  `taskDispatcher.dispatch` with `fullAccessGrant: null`, the operator as
  owner, unattributed attribution, a budget envelope and
  `provider: 'task-dispatch'`, so the Task gets a seeded Session and no
  engine starts: nothing on this path sends the Task's prompt as a turn, and
  a Task dispatch naming an Agent but no provider would otherwise start that
  Agent's engine ([#4005](https://github.com/kontourai/station/issues/4005)).
  `POST /scheduler/webhook` is a separate authenticated provider transport
  and stays separate.
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
  resolves the Serve origin. Automations use it only for that address; its
  separate owned-origin answer feeds browser-origin admission, not automation
  authority.

## 3. Model

S1 proposes a new contract subpath, `@kontourai/station-contracts/automation`,
in a new `automation.ts` file under
[`packages/contracts/src/`](../../packages/contracts/src/). It would hold
types and constants only; validators would live in a new `automation/`
directory under [`src-server/services/`](../../src-server/services/).

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
- `AutomationRule` is `{ id (server-issued); name; mode: 'off' | 'observe' |
  'live'; sourceId; match; episode?; action; rateLimit: { maxStartsPerHour }
  }`. A pre-#4509 `enabled: boolean` is read as `off`/`live`; see
  [Per-rule observe mode](#per-rule-observe-mode).
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
  rules, and are the automations users see today. A job's `target` (an
  existing or dedicated conversation) is the delivery an `agent-turn` rule
  action would reuse: a framed Station turn on the conversation's inbox, as
  [ScheduledConversationRuns](../../src-server/services/scheduling/scheduled-conversation-runs.ts)
  sends it. `SchedulerEvent`s such as `job.failed` become `station-event`
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
- **Who can create rules: an agent proposes, a person confirms.** This
  reverses the earlier rule, which allowed only operator surfaces (owner
  decision 2026-11-12,
  [#4830](https://github.com/kontourai/station/issues/4830); see
  [the decision record](../decisions/agent-proposed-automations.md)). An
  agent in a person's chat may call `propose_automation_source` or
  `propose_automation_rule`. Station validates the proposal and writes a plain
  description: what it watches, what it opens, which agent it wakes and with
  what authority. Nothing is created until a person confirms the card in that
  chat. Confirming needs the Station operator in person. It decides the
  proposing chat's scope again, and requires each Agent named to be
  unchanged (slug, Project, definition digest), inside the store's lock. It
  creates the source or rule through the ordinary store, under an id derived
  from the proposal so a retry never duplicates it
  ([routes](../../src-server/routes/orchestration/automation-proposals.ts),
  [validation](../../src-server/services/automation/automation-proposals.ts)).
  A proposal never grants more than the proposing chat holds:
  - every Project/Agent pair it names must pass that chat's dispatch scope
    rule;
  - it may name only `dispatch-task`;
  - a rule never pins `auto` approval;
  - `fullAccessGrant`, a credential, a secret, `enabled` and `mode` are
    refused as escalations;
  - only credential-free `github-poll` sources can be proposed.

  A proposal from a conversation that had read untrusted content
  ([#3483](https://github.com/kontourai/station/issues/3483)) is labelled
  so on the card. Sources are moving to
  [Telltale](https://github.com/kontourai/telltale)
  ([#4832](https://github.com/kontourai/station/issues/4832)). A Telltale
  source type's `plan()` should then write the "watches" text. Today's
  proposals use Station's own GitHub poll.
- **Default deny.** Sources are created disabled and rules in `observe`
  mode, which records decisions but never acts. This also holds for a
  confirmed proposal, unless the person ticks "Turn it on now" in the same
  confirmation. No grants means no actions. A corrupt config or ledger fails
  closed with `policy_unavailable`.
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
  grants. This includes proposing them. Proposals are gated on the calling
  turn being person-authored: it must carry the shared person-authorship
  mark (#4848), meaning a person typed it into Station's composer. Station
  infers the calling turn from Session state (the running turn by its
  persisted lifecycle fold); a start not yet stored refuses, and the
  decision is made again in the transaction that writes the proposal.
  Everything else refuses, including a delegated child's result that
  continues in the person's chat with `dispatchOrigin: interactive`.
  - **Known race.** A concurrent steer, failed or accepted, clears an
    in-flight delegated continuation's pending reservation, so an agent
    continuation can create a proposal card. The operator's in-person
    confirmation remains required and is the authority boundary.
  - **Known false refusal.** An invocationless legacy start can leave the
    Session stuck `pending`, refusing proposals until it exits.
  - The fix for both is a turn-bound station-control credential
    ([#4882](https://github.com/kontourai/station/issues/4882)).
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
- **Per-rule decisions per delivery:** `would-start`, `suppressed(reason)` or
  `intent-retained` for each matched `observe` or `live` rule, with a bounded
  action snapshot ([Per-rule observe mode](#per-rule-observe-mode)).
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
