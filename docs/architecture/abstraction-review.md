# Abstraction review

Status: source observations from the documentation audit. Initial baseline:
`ff2d743b4e45605d0a8500bd15ca4e1a86185ca6`; the linked defect findings below
were also checked against `3c655ae4cb3223a5c7b5438edb95f14c7a917d94`.
Later findings name their own source revision in the linked issue.
This is an investigation guide, not a complete architecture verdict. The
[learning atlas](../learn/README.md) groups responsibilities; the
[module map](module-map.md) owns their detailed interfaces.

## What a useful boundary gives a reader

An abstraction lets a caller state an intent while its owner handles the
mechanics. Assess it through a real call: what must the caller know, what state
can it mutate, what can fail, and who cleans up? A named interface is only the
start. Its ordering, authority, error, and recovery contracts matter as much as
its parameter types.

Use these questions at each node in the atlas:

- What responsibility belongs here, and what belongs to a neighboring owner?
- Can callers use the interface without coordinating its storage or lifecycle?
- Is the concrete adapter chosen at composition, or hidden inside a caller?
- Does one authoritative state transition produce both the durable and visible
  outcome, including an uncertain external effect?
- Do tests exercise the caller's contract and a real integration boundary?
- Which apparently simple change would reintroduce a previous defect?

## Existing boundaries to learn first

| Boundary | Source observation | Why it matters | Next evidence |
| --- | --- | --- | --- |
| Session command | [SessionCommandModule](../../src-server/services/orchestration/session-command-module.ts) exposes `execute` with accepted, rejected, failed, and indeterminate outcomes; [OrchestrationService](../../src-server/services/orchestration/orchestration-service.ts) composes it | Callers receive an explicit effect/durability outcome rather than assembling a start sequence | [Command tests](../../src-server/services/orchestration/__tests__/session-command-module.test.ts), then route/tool callers |
| Session lifecycle | [SessionLifecycleModule](../../src-server/services/orchestration/session-lifecycle-module.ts) owns transitions; the [orchestration route](../../src-server/routes/orchestration/orchestration.ts) calls `sessionLifecycles.transition` | Completion and a provider turn must agree on the same lifecycle authority | [Lifecycle tests](../../src-server/services/orchestration/__tests__/session-lifecycle-module.test.ts), turn-boundary and caller integration |
| Plugin provider publication | [Provider loader](../../src-server/providers/plugin-provider-loader.ts) prepares contributions, then uses [publication fencing](../../src-server/services/plugins/plugin-installation-generation-fence.ts) | An installed package and a prepared adapter do not independently grant authority to publish capabilities | [Generation fence tests](../../src-server/services/plugins/__tests__/plugin-installation-generation-fence.test.ts), revocation/regrant integration |
| Knowledge provider choice | [KnowledgeService](../../src-server/services/knowledge/knowledge-service.ts) receives vector/embedding resolver functions from [bootstrap](../../src-server/runtime/bootstrap/runtime-service-bootstrap.ts) | The service boundary is not a guarantee of one hardcoded storage backend | Trace configured-provider and unavailable-provider behavior through document/search callers |
| CLI distribution | [distribution.ts](../../packages/cli/src/distribution.ts) admits commands according to the bundle marker and named local exceptions | The same source tree supports a published client and a checkout launcher with different capabilities | Compare command admission, help, README, and [availability reference](../reference/cli.md) |

These observations establish code structure and selected call paths. They do
not claim that all behavior tests, devices, or providers were exercised in this
audit.

## Investigation candidates

GitHub owns implementation work and current status. These sections retain the
source observations that explain each finding. Their issue links include
suggested fixes and documentation acceptance; they are not a second backlog.

### Personal Knowledge scope and Settings selection

`KnowledgeStoreProvider.generateRootId` allows `root:personal:2` and later
suffixes. The read-only `root:conversations` also has personal scope.
[KnowledgeStoreSection](../../src-ui/src/views/settings/KnowledgeStoreSection.tsx)
shows the first personal root returned by the Knowledge API that has neither
an author-private read policy nor the conversation adapter. If it finds a
match, the card stops offering creation. This selection permits multiple
registrations.

The Settings catalog calls this row `personal` and identifies the Station
operator as its manager. The configuration API and account preferences keep
their own storage scopes. The Knowledge API controls access to roots and
requires an operator for registration. [Settings scope #2192](https://github.com/kontourai/station/issues/2192)

### Capture provenance depends on mutable UI state

[Meeting Notes capture](../../examples/meeting-notes/src/CaptureModal.tsx)
retains the submitted root, text and raw record ID for each request. Editing
or changing roots clears the saved IDs, and late responses cannot restore them
or label the changed draft. Pending compilation can still finish writing its
originally submitted note. Mounted-caller regressions cover delayed save and
compile responses, plus rejected-upload recovery; they do not prove live
Agent output or external source integrity.

The compile call still does not re-read or lock the stored source. External
source edits or deletion remain outside the UI guarantee. Review whether the
record owner should supply an exact source snapshot/revision for compilation
and publication. A source link alone is not an identical-input provenance
guarantee.

Tracked in [#2729: capture source identity](https://github.com/kontourai/station/issues/2729),
with delayed-response, root-change, and source-edit acceptance cases.

### Notification suppression now shares its policy owner

The initial audit found different Android and iOS predicates. At
`3c655ae4cb3223a5c7b5438edb95f14c7a917d94`, an orchestration approval without
an activity-card marker was suppressed by FCM and accepted by APNs. That was a
classification finding, not proof of a missed alert on a phone.

The upstream fix [#2738](https://github.com/kontourai/station/pull/2738)
removed the FCM copy. Both channels now call
[card-alerted-categories](../../src-server/services/notifications/delivery/card-alerted-categories.ts),
which requires the writer's `onActivityCard` marker and handles registry twins.
The audit merged that implementation and ran the FCM/shared-predicate tests.
[#2730](https://github.com/kontourai/station/issues/2730) retains the original
finding and documentation acceptance.

The shared predicate still describes card membership, not proof that a card
alert appeared. Coalescing, delayed sends, and a disabled card can affect the
actual experience. Those remaining timing and device boundaries need their
own evidence; sharing a helper does not resolve them automatically.

### CLI request assembly and request state

The original audit at
`3c655ae4cb3223a5c7b5438edb95f14c7a917d94` found that chat could use the
checkout's directory when invoked elsewhere, silently drop continuation
workspace flags, and fold a space-separated model option into the prompt.
It also reproduced a completed chat whose JSON still named a resolved request
as pending.

The [chat caller](../../packages/cli/src/commands/core.ts) now uses the
invocation directory for new local directory-based chats, lets the server
resolve a selected Project's directory, and rejects workspace changes on
continuation. [#2733](https://github.com/kontourai/station/issues/2733)

The [argument parser](../../packages/cli/src/commands/core-api.ts) now rejects
bare and space-separated model options before chat or delegate dispatch.
[#2732](https://github.com/kontourai/station/issues/2732)

[Chat JSON](../../packages/cli/src/commands/session-client.ts) now exposes
the last opening notice as `lastObservedRequest`. A responder command in
`pendingRequest` requires a bounded Session read and exact request inspection.
Local launcher and HTTP fixture evidence covers these caller contracts.
[#2741](https://github.com/kontourai/station/issues/2741)

[Checkpoint restore](../../packages/cli/src/commands/checkpoints.ts)
takes its target, credential and deadline from the common client path. It
displays the preview and requires its ID and current-tree hash in a separate
confirmation.
[#2734](https://github.com/kontourai/station/issues/2734)

### A declared namespace and its consumer can name different stores

At the audit baseline, Enterprise Layout declared `notes` but its
[public SDK hooks](../../examples/enterprise-layout/src/data/notes-hooks.ts)
read and wrote `enterprise-notes`. The host preserved those names; fallback
storage admitted the undeclared partition, while unscoped retrieval enumerated
registered RAG namespaces. [#2735](https://github.com/kontourai/station/issues/2735)
records the correction. The [Enterprise example](../../examples/enterprise-layout/README.md#knowledge-namespaces)
now declares `enterprise-notes`. Projects keep the older namespace and its
records. Manifest validation alone does not prove that a consumer uses the
registered resource.

### Board revisions do not establish freshness of linked work

Work Board rejects conflicting Board writes, but returning to the Pane can
reuse cached observations, and a conflict does not automatically fetch the
other writer's state. Cleanup uses the last loaded missing-reference result;
its revision check covers the Board, not changes in each referenced owner.
[#2736](https://github.com/kontourai/station/issues/2736) proposes a bounded
refresh and cleanup policy. It is a product recommendation; removing a pin
does not delete its underlying work.

### Snapshot phase names are not an execution barrier

Workspace checkpoint capture is queued from turn events. Its per-thread queue
orders snapshot work, while the engine can continue changing files. A
`baseline` or `settle` label therefore does not establish exact before/after
attribution. [#2737](https://github.com/kontourai/station/issues/2737) tracks the
choice between a stronger execution-boundary guarantee and an explicitly
best-effort observation. Any stronger capture policy must measure its cost and
define refusal/failure behavior at the real engine caller.

### Observation paths need clear definitions and completeness

The [monitoring review](../guides/monitoring.md) found several independent
problems. [#2750](https://github.com/kontourai/station/issues/2750) separates
Scheduler management requests from job executions;
[#2751](https://github.com/kontourai/station/issues/2751) reconciles dashboard
queries with actual names, labels, and recording populations;
[#2752](https://github.com/kontourai/station/issues/2752) addresses failed chat
spans finalized as successful; and
[#2755](https://github.com/kontourai/station/issues/2755) addresses instruments
created before asynchronous provider registration. Configured startup now
registers providers synchronously and defers identity to resource resolution.
Its regression observes the actual exported chat counter at a loopback OTLP
receiver, including records during delayed identity I/O and refused export on
identity failure. That is transport evidence, not production collector/storage
qualification. #2752 retains its separate in-memory exporter probe.

Insights now reports retained-scan integrity through its route, typed SDK and
existing dashboard ([#2758](https://github.com/kontourai/station/issues/2758)).
Readable omissions show partial totals; unknown history and failed refreshes
hide totals. Coverage decisions follow user/tenant admission for attributable
rows. A clean scan still does not prove retention or producer delivery. A
generated [metric catalog](../reference/metrics.md) prevents declaration drift;
it cannot establish that observations were recorded, exported, or complete.

### Browser subscription state has two owners

The browser owns a PushManager subscription; Station owns its paired-device
registration. The current UI initializes its state from the browser alone.
[#2759](https://github.com/kontourai/station/issues/2759) tracks reconciliation
with the selected Station, actionable authentication errors, and clear toggle
semantics. Separately, an old send's gone-response can clear a replacement
subscription: [#2753](https://github.com/kontourai/station/issues/2753).
The channel race was exercised with synthetic state; physical browser delivery
was not. See the current [Web Push guide](../guides/web-push-notifications.md).

### Reusable prompts validate their own input

The original audit found that authored commands accepted missing and surplus
arguments and that JavaScript replacement patterns changed the expanded text
in both authored commands and command skills. Authored commands now enforce
their declared positional parameters before dispatch. Both paths share a
single literal substitution pass. Sender and preview-helper fixtures verify
the expanded bytes. [Argument validation #2764](https://github.com/kontourai/station/issues/2764),
[literal values #2763](https://github.com/kontourai/station/issues/2763),
[command guide](../guides/commands.md)

### Shortcut explanations come from registered rules

The original audit found that settings derived hints from command IDs and
that saving Space used a different spelling from the standard event key.
Settings now displays the registered rule, and capture and dispatch share
Space key normalization. A Chromium fixture exercises capture, reload,
focus eligibility and modal suppression. [Rule explanations #2767](https://github.com/kontourai/station/issues/2767),
[Space bindings #2771](https://github.com/kontourai/station/issues/2771),
[shortcut guide](../guides/keyboard-shortcuts.md)

### One HTTP origin does not expose every realtime listener

The default container mapping and lifecycle UI proxy expose HTTP and SSE through
the UI port. Voice still derives a separate WebSocket destination from the port
reported by the backend. The former deployment instructions implied that
generic proxy upgrade headers connected those paths.
[#2769](https://github.com/kontourai/station/issues/2769) tracks an authenticated,
verified ingress contract. The corrected [deployment guide](../guides/deployment.md#reverse-proxy)
states the current limit. Source inspection establishes the missing route;
this audit did not execute a new container/proxy/phone voice journey.

### Live frames and human input share a transport budget

The current live-surface hook opens a frame request per visible viewer.
Visibility and duplicate-display suppression reduce requests, and a per-origin
admission cap of two frame streams now reserves connections for input. A
real-browser HTTP/1.1 fixture reproduced the saturation without the cap and
measured millisecond input with it (see the 2026-11-02 amendment to the
[ADR0018 constraint](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md)).
There is still no shared cross-surface frame transport, and the cap does not
cover all three view-scoped event streams open at once;
[#2760](https://github.com/kontourai/station/issues/2760) tracks both. Native
and relay transports need separate qualification.

### Staging must use the candidate's dependency contract

The dogfood reconciler runs each detached candidate's
`npm run dependencies:ci` before building it. The pnpm-only fixture checks the
command and exercises missing lifecycle, install failure and build failure
while the prior release keeps serving. A disposable reconcile additionally
completed the real managed install and build. The
[deployment guide](../guides/deployment.md) describes the operator path.

### Composition owners are difficult to learn as a single page

At the baseline, `station-runtime.ts` has 4,947 lines, `runtime-routes.ts` has
8,158, and `orchestration-service.ts` has 9,780. The files contain composition
and other implementation responsibilities; counting lines cannot identify a
safe extraction boundary. The [decomposition map](../design/orchestration-decomposition-map.md)
and current module interfaces must be reconciled with real callers first.

Before extracting a module, distinguish wiring from behavior and inventory callers that still
need several services or raw storage operations for one intent; inspect state
and cleanup ownership across those calls. A proposed extraction needs a concrete
reduction in caller obligations and behavioral evidence. Do not introduce a
generic wrapper merely to shorten a file.

### Published SDK hooks need a complete host implementation

An exported hook can still be unavailable in Station's default plugin host.
The actual Pane boundary, SDK adapter, and provider do not supply several
documented context slots; some operation wrappers explicitly reject calls.
[#2780](https://github.com/kontourai/station/issues/2780) tracks reconciling the
public SDK contract with these host bindings. The bounded mounted-host probe
exercised those bindings with mocked surrounding core services; it did not
install a plugin or run a live Agent.

### Library tests can miss a broken release command

The release workflow's assembly CLI used an unimported filesystem reader, and
its validation step compared the sorted-key inventory against the
writer-ordered container descriptor byte for byte. Both commands would have
failed on every release while the nearby tests exercised only the library or
scanned the workflow text.
[#2783](https://github.com/kontourai/station/issues/2783) fixed both and added a
regression that runs the real assemble and validate commands with
`release.yml`'s arguments. That evidence is local; no hosted tagged release
has exercised it yet.

### Public configuration and runtime enforcement must agree

At the audit baseline, the Agent contract exposed `guardrails.maxSteps` while
the file schema rejected it. [#2846](https://github.com/kontourai/station/issues/2846)
records the alignment on top-level `maxSteps` for VoltAgent. The engine matrix
states that Strands and external engines use their own limits.
Retained quick prompts have no current UI consumer ([#2847](https://github.com/kontourai/station/issues/2847)),
and invalid date/time format JSON can reach prompt expansion before failing
([#2848](https://github.com/kontourai/station/issues/2848)). The
[configuration reference](../reference/config.md) describes those current limits.

### Shared CLI safeguards need to cover each caller

The Operate shell's event stream uses the same origin-bound authenticated
transport as its initial Session read. A real caller against a synthetic
protected HTTP service exercises credential transmission, cross-origin
isolation, frame parsing and cancellation.
[#2845](https://github.com/kontourai/station/issues/2845) recorded the original HTTP 401.
Home reset now acquires the home maintenance lease, rechecks lifecycle inactivity
and archives the home while holding that lease. It still does not separately
consult the home-scoped instance registry
([#2849](https://github.com/kontourai/station/issues/2849)). Maintenance excludes
cooperating leased runtimes; it does not stop writers that bypass that protocol.
No live home reset was attempted in the original review. The remaining gaps
belong in the existing owners, with actual-caller coverage, rather than another
parallel transport or lifecycle abstraction.

### Successful persistence does not establish usable presentation

Actual Task captures saved shared revisions but exposed a 176×32-pixel editor
and clipped headings ([#2844](https://github.com/kontourai/station/issues/2844)).
The Connections view's selected hover state also reduced measured label contrast
to 1.38:1 ([#2843](https://github.com/kontourai/station/issues/2843)). The
[walkthroughs](../learn/walkthroughs.md) retain the observed appearance and
distinguish real persisted state from sample connection responses. Fixes need
browser evidence alongside their state/contract tests.

### Examples need the same caller contracts as the product

The Sessions MCP example exercises authenticated list reads and distinct
failure snapshots through real stdio against a fixture API. The ElevenLabs
example exercises the documented single-use token and audio protocols with a
scripted transport. An isolated Station verified the Sessions example's
empty snapshot and refusal after Device revocation. External-host rendering
and live voice provider execution remain unverified. The registry CLI
submits an install ID without the preview consent required by the installer
([#2809](https://github.com/kontourai/station/issues/2809)). A manifest, build or
render test does not establish these end-to-end journeys.

Two SDK state-retirement findings have separate owners: clearing an active
Layout tab leaves its stored state behind
([#2806](https://github.com/kontourai/station/issues/2806)), and server voice
stubs survive the observation that registered them
([#2807](https://github.com/kontourai/station/issues/2807)). Their issues retain
the actual provider/context probes and distinguish them from live app or
physical audio evidence.

### Failed observations must remain distinguishable from empty results

Directory search catches provider failures and returns an empty success
([#2857](https://github.com/kontourai/station/issues/2857)). Plugin update
discovery loses completeness across the checker, route, SDK and management view
([#2858](https://github.com/kontourai/station/issues/2858)). These are traced
caller contracts; no directory outage or missed installed update was observed.
The fix belongs in those owners, with distinct complete, partial and unavailable
outcomes where needed. Insights and monitoring stats used to carry placeholder
zeroes for per-Agent tokens and cost; they now omit what nothing measures
([#463](https://github.com/kontourai/station/issues/463)). Neither invented
zeroes nor successful empty responses establish an observation.

### Durable operations need an operation-level outcome

`station import` can publish several records before a later write or final
ledger fails ([#2859](https://github.com/kontourai/station/issues/2859)). The
source establishes a recovery gap, not an observed data-loss incident. Decide
the import owner's recovery guarantee and test interruption between actual
writes in a disposable home.

The Survey example also needs a committed revision for save and projection
([#1359](https://github.com/kontourai/station/issues/1359)). A real route probe
accepted replacement events without a prior count; competing writers and
pending-save projection remain separate acceptance cases. Fieldwork availability
polling invokes a public export/read/event path, whose cost was not measured
([#2860](https://github.com/kontourai/station/issues/2860)). Measure that caller
and decide the public observation contract before adding caching.

### Units, lifetime and transport policy belong in shared contracts

Bedrock pricing parsers copy amounts without validating their source unit
([#1127](https://github.com/kontourai/station/issues/1127)). Pairing offers can
contain LAN HTTP URLs that the browser decoder refuses
([#177](https://github.com/kontourai/station/issues/177)). Preserve that refusal
until the producer/consumer transport policy is resolved; LAN reachability does
not establish trust.

Other owners retain independent findings: long notification timers can lose
wakeups ([#2810](https://github.com/kontourai/station/issues/2810)); mutations
need an explicit stale-connection admission policy
([#2815](https://github.com/kontourai/station/issues/2815)); and update queries
ignore a boolean currentness result
([#2831](https://github.com/kontourai/station/issues/2831)). Their evidence and
acceptance cases remain in the issues, rather than a second live status list.

### Documentation sometimes hides an abstraction that already exists

The architecture overview described knowledge as a fixed sqlite-vec store even
though the service accepts provider resolvers. CLI prose treated the published
client and checkout lifecycle surface as one capability. These are explanation
problems first. Correct the account of the current boundary before proposing
new interfaces to solve a problem the code already separates.

### A module catalog is not a complete learning model

The current map is rich in interface and failure invariants, but it also holds
implementation notes, follow-up evidence, and long history. A new reader needs
an overview and a journey before those details. The atlas adds that navigation
without asserting that every section is an independently reusable module.
Its groupings are a learning aid, not a new dependency or ownership authority.

When evaluating a journey, trace success, refusal, cancellation, restart and
reconnect. Check whether the reader can reach both the durable owner
and the UI projection. Record an absent explanation separately from missing
implementation.

### Some historical warnings should remain near the decision

In [server startup](../../src-server/index.ts), the home-schema gate precedes
creation of the durable log directory because an early write can make a fresh
home look like incompatible existing data. That comment explains a non-obvious
ordering constraint. Removing it as narration would lose useful information.

The right cleanup is to remove statements that merely repeat syntax, compress
long rationale, and preserve the invariant plus its regression evidence. No
repository-wide deletion quota follows from this review.

## Recording an improvement

For each candidate retain the observed caller burden or failure, source and
test paths, affected authority/state owners, proposed interface, rejected
alternatives, and evidence needed to establish the benefit. Label it
CONFIRMED only after the stated observation is verified; retain unresolved
architecture questions as NOT_VERIFIED. Functional changes should have their
own reviewed implementation scope.

Some recommendations already have detailed backlog owners:
[plugin secret bindings #409](https://github.com/kontourai/station/issues/409)
under [#403](https://github.com/kontourai/station/issues/403),
[Neo4j runtime configuration #29](https://github.com/kontourai/station/issues/29)
under [the Knowledge epic](https://github.com/kontourai/station/issues/1228),
and [Knowledge starter qualification #269](https://github.com/kontourai/station/issues/269)
alongside [pane migration #265](https://github.com/kontourai/station/issues/265).
Some detailed entries were closed when work was folded into epics; that status
does not establish that their acceptance conditions were implemented.

When implementing a finding, follow the
[documentation follow-through](../guides/documentation.md#turn-findings-into-maintained-improvements):
correct the current explanation in the same PR and re-review its evidence.
Keep dated audit observations as history with a link to the fix.
