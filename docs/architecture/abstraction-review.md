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

### Store-index freshness lacks two identities

The [sqlite-vec index](../../src-server/knowledge-index/sqlite-vec-index-provider.ts)
records vector width but not the embedding model/configuration that produced
it. Its [migration caller](../../src-server/knowledge-index/migrate-pre-index-knowledge.ts)
also treats matching width as sufficient for vector reuse. A different model
with the same width can therefore be mixed with existing vectors without a
dimension error.

Tracked in [#2727: embedding configuration identity](https://github.com/kontourai/station/issues/2727).

The [store search route](../../src-server/routes/knowledge/knowledge-index-routes.ts)
rechecks access and record existence, but returns the index's old excerpt
beside the record's current title/category. It does not compare a record-body
revision. This differs from the older document API's content-hash validation
through [KnowledgeFileTransactions](module-map.md#knowledgefiletransactions).

Tracked separately in [#2728: source-content freshness](https://github.com/kontourai/station/issues/2728).

Next design review: give index entries explicit source-content and embedding
configuration identity, then decide how callers should see stale results and
rebuild requirements. Matching dimensions and a readable record are useful
checks, but neither establishes the meaning or freshness of an embedding.

### Personal Knowledge scope and the Settings card disagree

`KnowledgeStoreProvider.generateRootId` allows `root:personal:2` and later
suffixes; the runtime's read-only `root:conversations` also uses personal scope.
[KnowledgeStoreSection](../../src-ui/src/views/settings/KnowledgeStoreSection.tsx)
selects the first personal root and stops offering creation. Thus a scope tag
cannot tell this UI whether it found the intended writable store. Review the
desired uniqueness and adapter-capability contract before introducing another
special-case root-name check. This is an existing model/UI mismatch, not a
claim that the registry already enforces one writable store per person.

The existing [Settings scope issue #2192](https://github.com/kontourai/station/issues/2192)
now carries this model/UI clarification and documentation acceptance. Its
original per-principal uniqueness claim needs a contract decision, not just a
label change.

### Capture provenance depends on mutable UI state

[Meeting Notes capture](../../examples/meeting-notes/src/CaptureModal.tsx)
stores a raw record ID in component state after saving. Compile combines that
ID with the current textarea without rereading the stored source. Editing the
textarea clears the ID, but a delayed earlier save response can set it again;
an external source edit or deletion is also outside this UI sequence.

The compiled record can therefore name a source without proving it represents
the text sent to the extraction Agent. Review whether the record owner should
supply an exact source snapshot/revision for compilation and publication, with
late UI responses tied to the same selection. A source link alone is not an
identical-input provenance guarantee. The documentation now names this limit;
the save/compile behavior has not been changed in this pass.

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

### CLI request assembly does not always use the shared client contract

The [chat caller](../../packages/cli/src/commands/core.ts) builds workspace
selection separately from saved-Station selection. The source launcher changes
working directory, and continuation omits workspace flags without a warning.
[#2733](https://github.com/kontourai/station/issues/2733) tracks one explicit
workspace-selection contract across those paths.

The [model-option collector](../../packages/cli/src/commands/model-options.ts)
does not reject the bare flag produced by the advertised spaced syntax;
the following value becomes prompt text. A local parser/collector probe
confirmed that the equals spelling works and the spaced spelling loses the
option. [#2732](https://github.com/kontourai/station/issues/2732) tracks support
or explicit refusal, with tests through chat and delegate callers.

[Checkpoint restore](../../packages/cli/src/commands/checkpoints.ts) uses raw
fetch without the common authentication/target/deadline path and confirms its
returned preview without displaying it. [#2734](https://github.com/kontourai/station/issues/2734)
tracks the authenticated caller and visible confirmation journey. These are
source/caller findings, not proof of a real restore or engine execution.

The CLI's final JSON can also retain `pendingRequest` after that request has
resolved and the turn completed. An isolated caller/SSE probe reproduced this
combination. [#2741](https://github.com/kontourai/station/issues/2741) tracks a
response contract that distinguishes current pending work from the last notice.

### A declared namespace and its consumer can name different stores

Enterprise Layout declares `notes` but its
[public SDK hooks](../../examples/enterprise-layout/src/data/notes-hooks.ts)
read and write `enterprise-notes`. The host preserves those names; fallback
storage admits the undeclared partition, while unscoped retrieval enumerates
registered RAG namespaces. [#2735](https://github.com/kontourai/station/issues/2735)
tracks an identity correction with preservation of existing records. Manifest
validation alone does not prove that a consumer uses the registered resource.

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

### Reusable prompts have two different argument contracts

Authored Agent commands and command skills both expand prompt text, but only
the skill path rejects missing values and surplus positional words. Both use
JavaScript replacement-string semantics, so dollar patterns in a supplied
value can change its text. [#2764](https://github.com/kontourai/station/issues/2764)
tracks authored argument validation;
[#2763](https://github.com/kontourai/station/issues/2763) tracks literal-value
preservation. The [command guide](../guides/commands.md) describes the current
precedence and limits. A pure skill-helper probe reproduced the dollar-pattern
behavior; no provider completion was inferred from prompt expansion.

### Shortcut hints are separate from dispatch rules

The keyboard editor derives context hints from command IDs, while dispatch
uses registered conditions plus modal/input ownership checks.
[#2767](https://github.com/kontourai/station/issues/2767) tracks a shared source
for the visible explanation and actual availability rule. The
[shortcut guide](../guides/keyboard-shortcuts.md) now names that distinction and
the current local settings store. This is a source-confirmed explanation gap,
not a physical keyboard or native-shell failure.

A separate mounted-editor probe found that a captured Space binding is saved
under a different key spelling from the standard dispatched event.
[#2771](https://github.com/kontourai/station/issues/2771) tracks normalization
across capture, storage and dispatch, including existing saved bindings.

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
Visibility and duplicate-display suppression reduce requests, but there is no
shared cross-surface frame transport or admission policy reserving room for
input. [#2760](https://github.com/kontourai/station/issues/2760) tracks that unmet
[ADR0018 constraint](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md), with acceptance at
the actual browser input path. Finite browser connection pools make contention
a plausible concern; this audit did not reproduce saturation or measure latency.
Native and relay transports need separate qualification.

### Staging must use the candidate's dependency contract

Dogfood candidate preparation still runs raw `npm ci` before building a detached
release, while the current repository has a pnpm lockfile and managed installer.
Its fixture accepts any npm command, so a green fixture cannot establish
package-manager compatibility. [#2776](https://github.com/kontourai/station/issues/2776)
tracks the real candidate caller, a stricter fixture, and a disposable managed
installation check. This audit inspected the mismatch; it did not stage a live
release or exercise promotion/rollback. The
[deployment guide](../guides/deployment.md) retains that qualification limit.

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

The release workflow calls an assembly CLI whose `sbomContext` function uses
an unimported filesystem reader. The actual command exits before producing an
inventory, while nearby tests exercise its library or scan the workflow text.
[#2783](https://github.com/kontourai/station/issues/2783) records the reproduction
and requires a regression through both real assembly and validation commands.
This is a local caller failure, not an observed hosted release attempt.

### Public configuration and runtime enforcement must agree

The Agent contract exposes `guardrails.maxSteps`, but the file schema rejects
it; Strands also does not apply the configured step cap. [#2846](https://github.com/kontourai/station/issues/2846)
tracks a single admitted shape and engine-specific enforcement evidence.
Retained quick prompts have no current UI consumer ([#2847](https://github.com/kontourai/station/issues/2847)),
and invalid date/time format JSON can reach prompt expansion before failing
([#2848](https://github.com/kontourai/station/issues/2848)). The
[configuration reference](../reference/config.md) describes those current limits.

### Shared CLI safeguards need to cover each caller

The Operate shell's event stream bypasses the authenticated SDK transport even
though its initial Session read uses it. A real caller against a synthetic
protected HTTP service reproduced the missing credential and HTTP 401;
[#2845](https://github.com/kontourai/station/issues/2845) tracks the correction.
Home reset has a separate source-confirmed gap: it skips the home instance
registry and does not take the backup/restore maintenance lease before archiving
([#2849](https://github.com/kontourai/station/issues/2849)). No live home reset
was attempted. Both belong in the existing owners, with actual-caller tests,
rather than another parallel transport or lifecycle abstraction.

### Successful persistence does not establish usable presentation

Actual Task captures saved shared revisions but exposed a 176×32-pixel editor
and clipped headings ([#2844](https://github.com/kontourai/station/issues/2844)).
The Connections view's selected hover state also reduced measured label contrast
to 1.38:1 ([#2843](https://github.com/kontourai/station/issues/2843)). The
[walkthroughs](../learn/walkthroughs.md) retain the observed appearance and
distinguish real persisted state from sample connection responses. Fixes need
browser evidence alongside their state/contract tests.

### Examples need the same caller contracts as the product

The standalone sessions MCP reader hides failed unauthenticated reads behind
an empty panel ([#2785](https://github.com/kontourai/station/issues/2785)). The
ElevenLabs example uses an older token/audio/transcript protocol
([#2784](https://github.com/kontourai/station/issues/2784)). The registry CLI
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
outcomes where needed. Insights has separate placeholder values
([#463](https://github.com/kontourai/station/issues/463)); neither invented zeroes
nor successful empty responses establish an observation.

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
