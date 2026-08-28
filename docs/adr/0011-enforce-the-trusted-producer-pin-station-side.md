# Enforce the trusted-producer pin Station-side, at attach and at completion

## Context

Station's workspace pins who may satisfy a governance claim. `.flow/config.json`
carries:

```json
{ "trusted_producers": { "governance.merge-readiness": { "producers": ["veritas"] } } }
```

Flow enforced that pin during gate evaluation up to `flow@0.1.19`
(`evidenceProducerTrusted` rejected an untrusted producer's claim with
`reason: 'untrusted_producer'`). Flow 1.3.0 dropped the check: `evaluateGate`
and `evidenceMatchesExpectation` store `entry.producer` and never read
`config.trusted_producers`. Flow 3.9.0 does not restore it — the config field
is loaded, validated, merged, and then consulted by nothing. Upstream carries
this as flow#82; the Flow 3 architecture map recorded it as **worse than
filed**, since 3.x enforces no `trusted_producers` at all.

Without Station-side enforcement, the pin is decoration: any producer —
`station/command`, an unattributed manual attach, a plugin — can satisfy
`governance.merge-readiness` and complete a gated delivery session. That is a
silent governance regression, and silence is the part that makes it
unacceptable.

Station had been re-enforcing it since the 1.3 bump, in
`FlowRunService.evaluate`: build a filtered view of the manifest with untrusted
evidence removed, re-drive `evaluateGate` over it, then persist the corrected
state with Flow's `saveRun` so the run file recorded Station's verdict rather
than Flow's.

**Flow 3 removed `saveRun` from the public surface** (unexported since 3.1.0).
Every run mutation now goes through `withRunMutationLock` inside Flow's own
store. The old mechanism cannot compile, and reproducing it would mean writing
run files behind Flow's lock — reaching past a published contract, which
constitution non-negotiable #1 forbids. A decision was unavoidable; the code
does not build without one.

## Decision

### Option (a) — drop the pin

Delete the re-enforcement, note the regression, wait for flow#82.

**Rejected.** Undisclosed it is a silent governance regression on the one claim
type Station pins. Disclosed, it is an open hole on the merge-readiness gate
for as long as upstream takes. Neither is acceptable for the control that
decides whether a delivery session may complete.

### Option (b) — enforce at attach time

Refuse the attach when evidence asserting a pinned claim type arrives from an
untrusted producer, so untrusted evidence never enters the run.

**Adopted, as one half.** It is the cheapest and most honest point of refusal:
the run's record stays clean, the caller learns immediately and by name, and no
after-the-fact reinterpretation of a stored run is required. On its own it is
incomplete — it only covers evidence that arrives through `FlowRunService`.
Flow's own CLI, a sibling tool, or a pin added to `config.json` *after* an
attach all bypass it.

### Option (c) — Station-side post-evaluation veto in the completion gate

Let Flow evaluate and record its own truth. Apply Station's policy on top: the
completion gate refuses to call the session complete when a gate reached `pass`
only on evidence from an untrusted producer, and says so by name.

**Adopted, as the other half.** This is the disposition the architecture map
recommended, and it is the one that preserves the layering the rest of the
system depends on: **the run file records what Flow decided; Station's policy
is a Station decision, surfaced as a Station verdict.** Rewriting the run to
make Flow appear to have decided something else was the previous design's real
flaw, not just its `saveRun` dependency.

**Chosen: (c) + (b), both behind one default-ON switch.** Attach-time refusal
prevents; the completion-gate veto catches what prevention cannot reach.

### How the veto avoids diverging from Flow's matching

The pin must not re-implement gate matching. Visit scoping (`enteredAt`),
freshness re-derivation, supersession, exception handling, and claim-status
acceptance are all Flow's, and all of them changed in the 3.1.2–3.1.4 range. A
Station-side re-implementation would drift on the next release, and its drift
would be invisible.

`assessProducerPin` (`src-server/services/flow/producer-pin.ts`) therefore runs
**Flow's own `evaluateGate`, twice**: once over the manifest as it stands, once
over the same manifest with the untrusted evidence for pinned claim types
removed. A violation is reported only when removing that evidence is what turns
a `pass` into a non-pass. Everything Flow considers is considered, because Flow
is doing the considering; a gate that a trusted producer also satisfies is
never vetoed.

The assessment runs against the state as it stands **before** `evaluateRun` —
the same state Flow is about to read — and evaluates against cloned state, so a
probe can never mark the run.

The probe is *not* identical to Flow's evaluation, and the difference is
recorded under Consequences below: `evaluateRun` re-derives freshness-bearing
bundle reports before its gates read them, and the probe reads the manifest as
persisted.

The alternative the map sketched — calling `evidenceMatchesExpectation(entry,
expectation, config, enteredAt)` with a hand-computed `enteredAt` — was not
taken: `currentGateVisit`, which derives `enteredAt` from the transition
history, is **not exported** by Flow. Reproducing it would mirror an unexported
internal (see archive#290's disclosed follow-up: file the upstream export request at
mirror-creation time, or do not mirror). Running `evaluateGate` gets the same
visit scoping through the published surface and cannot fall out of step with
it.

### The switch

`STATION_FLOW_PRODUCER_PIN`, **default ON**. Only an explicit off-value (`0`,
`off`, `false`, `disabled`) disables it; unset means enforced. A governance
control that fails open when someone forgets to set a variable is not a
control. Turning it off is deliberately explicit and named, so the act shows up
in a deployment diff.

## Consequences

- Attaching evidence for a pinned claim type from an untrusted producer through
  `FlowRunService.attachEvidence` fails with `FlowRunInvalidError` naming the
  claim type, the producer, and the allowlist. Nothing lands on the run.
- **Failed evidence is exempt** from the attach check. A failed entry can never
  satisfy an expectation, so it cannot launder trust; refusing it would break
  the fail-then-fix loop that route-back recovery depends on.
- `FlowRunService.evaluate` returns `producerPinViolations` alongside Flow's
  outcomes. The run file is untouched — Flow's `pass` stays a `pass` on the
  record, which is the truthful account of what Flow decided.
- `evaluateFlowCompletionGate` emits `verdict: 'block'` with
  `exceptionRequired: true`, a summary naming the violation, and a structured
  `producerPin.violations` payload on the `flow.gate-verdict` event. `block`
  rather than `route-back`: Flow has already advanced the run, so there is no
  earlier step left to route back to, and only trusted evidence or a
  human-accepted exception should clear it.
- The verdict event's `producerPin` field is **absent** when the pin found
  nothing. Absence never means "the pin is off" — whether enforcement is on is
  a deployment fact, not a per-run one, and encoding it per-run would invite
  reading a missing field as a clean bill of health.
- `station.flow.producer_pin.violations` counts violations by gate and stage
  (`attach` | `evaluate`), so a workspace that is quietly running into the pin
  is visible without reading run files.
- **A pin that could not be assessed is a refusal, not a pass.** If the probe
  throws, the gate is reported as `producerPin.unevaluated` and the completion
  gate blocks on it, with `station.flow.producer_pin.unevaluated` counting it.
  The switch was fail-closed from the start but the *enforcement* was not: a
  throw used to be swallowed and read as "no violations", so a future Flow
  change that made `evaluateGate` throw would have retired the pin with no
  signal whatsoever. Station does not know whether an unassessed pin holds, and
  must not report a result it never computed.
- **Every untrusted entry is named, for every affected expectation.** Flow's
  `matched_expectations` binds one evidence id per expectation, so reporting
  only those under-named the problem when two untrusted entries satisfied the
  same expectation — an operator would replace the one entry the verdict named
  and hit the identical refusal. The affected expectations come from Flow's own
  `filtered.missing`; a bundle asserting several pinned claim types is reported
  once per claim type.
- **Attach-time path resolution must match Flow's exactly.** The check resolves
  the evidence file with `resolve(cwd, file)`, as Flow does. `join(cwd, file)`
  is not equivalent: it mangles an absolute path, and every production caller
  passes one (`attachCommandEvidenceResult` and `FlowReadinessBridge` both
  write into `createStationTempDir()`), which made this half of the enforcement
  inert everywhere except in tests. Tests for it use absolute paths mirroring
  the real callers, because a relative-path test proves nothing about the
  shape production actually uses.
- Divergence risk is structural, not behavioral: if Flow ever restores its own
  producer-trust enforcement, the filtered evaluation and the unfiltered one
  will simply agree, and the veto will stop firing on its own. Re-checking that
  (and retiring this layer) belongs with flow#82, not here.
- **The probe reads a pre-`reDeriveBundleReports` manifest.** `evaluateRun`
  re-derives every freshness-bearing bundle report against the current clock
  *before* its gates read them (`flow-run-store.js`, `evaluateRunUnlocked`
  §1); `assessProducerPin` reads the manifest as persisted. For a claim whose
  derived status is time-dependent, the probe can therefore see `pass` where
  Flow, moments later, sees a stale claim and routes back. The same gap has a
  second form: Flow's stale-gate-recheck branch can reroute an already-passed
  upstream gate before the open gates are evaluated at all, and the probe does
  not model that branch either.
  - **It cannot manufacture a false PASS.** The veto is purely additive — it
    only ever downgrades a verdict — so a probe/Flow disagreement can never let
    untrusted evidence through. The failure mode is a *wrong-verdict*: Station
    emits `block` with `exceptionRequired` and a summary asserting the gate
    "would pass on untrusted evidence" when in fact it did not pass at all, and
    the real reason (staleness) is masked behind the pin's wording. The overlay
    (see the recovery-fields point above) keeps Flow's own verdict in the
    summary and every routing field intact, which bounds the damage to
    misleading emphasis rather than lost guidance.
  - **Bounded today, not fixed:** Station's synthetic bundles carry no
    freshness fields at all (`buildSyntheticTrustBundle` mints `createdAt` /
    `updatedAt` and nothing else), so nothing Station produces re-derives to a
    different status. The gap opens the moment a freshness-bearing producer
    (a real Veritas or Surface bundle with `expiresAt`) satisfies a *pinned*
    claim type. Closing it means either running the probe after Flow's
    re-derivation (which needs a Flow-exposed hook, since `reDeriveBundleReports`
    mutates the manifest Flow then evaluates) or accepting the divergence
    explicitly. Recorded rather than silently carried.
- **Not covered:** evidence attached out-of-band to a gate whose run never
  reaches the completion gate. Such a run's file records Flow's pass and no
  Station verdict exists to contradict it. That is the accepted limit of a
  policy layer that refuses to rewrite another system's record.

## Superseded — 2026-08-26

Flow 5.1 enforces configured `trusted_producers` and `authority_refs` during
its own gate evaluation. The policy checks the rich bundle's `producerId`,
requires a matching active and scoped `authorityTrace` for authority-reference
routes, and publishes the authoritative `claim_evaluation` diagnostics. Station
has therefore retired its attach-time precheck, pre-evaluation probe, completion
veto, metrics, and `STATION_FLOW_PRODUCER_PIN` escape hatch. `FlowRunService`
now delegates the sole policy decision to `evaluateRun`; it preserves Flow's
outcome, routing fields, reports, and evaluation references unchanged.

`FlowGateVerdictEvent.producerPin` remains a deprecated read-only historical
field for persisted events. New Station verdicts do not emit it, and its absence
does not say that a run was assessed or clean.
