# Abstraction review

Status: source observations from the documentation audit. Initial baseline:
`ff2d743b4e45605d0a8500bd15ca4e1a86185ca6`; the linked defect findings below
were also checked against `3c655ae4cb3223a5c7b5438edb95f14c7a917d94`.
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

### Notification alert suppression has two different owners

The Android [FCM channel](../../src-server/services/notifications/delivery/fcm-alert-channel.ts)
has a private `isCardAlerted` predicate. The iOS
[APNs channel](../../src-server/services/notifications/delivery/apns-alert-channel.ts)
uses [card-alerted-categories](../../src-server/services/notifications/delivery/card-alerted-categories.ts).
The shared predicate requires an explicit `onActivityCard: true` marker and
recognizes a registry approval tied to an orchestration thread. The FCM copy
uses the older category/session-kind rule without that marker.

This is a confirmed policy difference, not just similar-looking code. Calling
both channels' public `accepts` method with an `approval-request`, runtime
Session ID, orchestration request kind, and no activity-card marker yields
`false` for FCM and `true` for APNs at the audited revision. That observation
tests classification only; it does not prove a missing or duplicate alert on
a real phone.

Next implementation review: trace the notification writers and audience rules,
decide the intended cross-platform suppression rule, and place it behind one
owner with tests for ephemeral Sessions and registry twins. Changing that rule
would change behavior, so this documentation pass records the difference and
corrects the stale “same rule” comment without choosing a policy silently.

Tracked in [#2730: cross-platform suppression policy](https://github.com/kontourai/station/issues/2730)
under the notification epic. Classification proof and physical delivery proof
remain separate acceptance items.

### Composition owners are difficult to learn as a single page

At the baseline, `station-runtime.ts` has 4,947 lines, `runtime-routes.ts` has
8,158, and `orchestration-service.ts` has 9,780. The files contain composition
and other implementation responsibilities; counting lines cannot identify a
safe extraction boundary. The [decomposition map](../design/orchestration-decomposition-map.md)
and current module interfaces must be reconciled with real callers first.

Next review: distinguish wiring from behavior; inventory callers that still
need several services or raw storage operations for one intent; inspect state
and cleanup ownership across those calls. A proposed extraction needs a concrete
reduction in caller obligations and behavioral evidence. Do not introduce a
generic wrapper merely to shorten a file.

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

Next review: trace success, refusal, cancellation, restart, and reconnect for
each major journey. Check whether the reader can reach both the durable owner
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
