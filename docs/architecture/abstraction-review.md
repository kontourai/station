# Abstraction review

Status: initial source review at `ff2d743b4e45605d0a8500bd15ca4e1a86185ca6`.
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
