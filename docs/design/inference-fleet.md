# Design: the inference fleet — receipted model routing across your Stations

> Status: **direction recorded (owner decisions, 2026-08-01); tracking issue
> [#1398](https://github.com/kontourai/station/issues/1398).** All nine open
> questions are resolved — see §10 and the
> [owner decision comment](https://github.com/kontourai/station/issues/1398#issuecomment-5151783495)
> on #1398 (2026-08-01). This doc is the contract for the arc: the v1 scope, the
> mesh-admission-compliance model, the privacy posture, and the slice plan.
> Revise this doc — not just the code — when direction changes.
>
> **Slice 0 has shipped** as [#1426](https://github.com/kontourai/station/issues/1426)
> (PR [#1438](https://github.com/kontourai/station/pull/1438)); §2.5 and §11
> record what that changed and the two follow-ups it surfaced
> ([#1430](https://github.com/kontourai/station/issues/1430),
> [#1431](https://github.com/kontourai/station/issues/1431)).
>
> **Slice 1 has shipped** — contribution opt-in (default off), the
> `station.fleet-contribution/v1` contributed-subset manifest, and the
> `fleetInference` handshake flag *declared but deliberately not
> advertised* until the token exists; §4.2 and §11 record the contract it
> settled and the one correction it made to the slice plan.
>
> **Slice 2 has shipped** — the `inference:invoke` scope with the default
> grant decoupled from the vocabulary, the `inference` preset, the
> `fleetInference` flag now honestly advertised, the OQ-2 leaf override on
> `GET /api/connections/model-inventory`, and the authenticated
> `/api/inference/**` serving family (manifest read + buffered completion,
> specified for streaming). It also closed the two questions slice 1 left
> open (§4.2 diagnostic text, §5.4 who may enable contribution) and two §12
> items (the SSH-loopback reach, the OQ-2 blast radius). §11 records what
> shipped differently from the plan and why.
>
> Every claim about current behavior carries file:line evidence; §12 lists what
> is UNVERIFIED. Refs #741/#819 (personal fleet), #1123 (peer pairing, slices
> 1–3 shipped), #423 (Datum routing seed), #1425 (portable project bindings),
> #1392 (multi-tenant tier / owner attestation).

## 0. Naming and sources

The reference implementation #1398 compares us against is called **"the
reference mesh"** throughout this doc. The separate attributed research record
is not required to understand or implement this design.

Where this doc asserts something about the reference mesh, it is a
code-verified reading of that implementation, not a reading of its marketing.
Those readings matter because two of them invert the naive positioning:

- The reference mesh's node capability advertisement is **entirely
  self-asserted**. Its wire type has a `capacity { vram_gb }` field; its
  producer hardcodes `capacity: None` on every publish, and no code anywhere
  probes, benchmarks, or verifies a *peer's* claims. The only health probe in
  the feature checks the node's **own** local ingress for a watchdog restart.
- Its "**join policy**" is a community terms-of-service/age-attestation
  document fetched from the relay — **not** a contributor-requirements
  manifest. There is no shipped mechanism publishing "to contribute you must
  offer X." The owner's framing in #1398 ("the join-policy pattern") is
  therefore an *extension* of that pattern into new territory, not adoption of
  a proven one. This doc treats it as such and defers it accordingly (§4.6).

Both facts are the design opening. They are also why §4 is the differentiating
section of this document rather than a compliance chore.

## 1. Problem and positioning

**The user outcome.** A person running Station on several machines has models
scattered across them: a 70B on the workstation with the GPU, a small fast
local model on the laptop, hosted frontier models behind whichever machine
holds the credential. Today, an agent can only use models the Station it is
running on can reach. The person moves the work to the model by hand, or gives
up and pays for a hosted call they did not need.

**What we build.** Route to the right model anywhere in your fleet, and keep a
receipt of why. Not "borrow the neighbor's GPU" — *"your own machines, one
model pool, and an auditable record of every routing decision, exclusion,
retry, fallback, and budget stop."*

**Why the receipt is the product, not a feature.** The reference mesh's
positioning is capacity: pool GPUs, run a model too big for one machine. That
is a real user value and we are not going to beat it on capacity — one person's
three computers is not a community's hundred. Our asymmetry is the opposite
axis: we already have a routing-receipt primitive (Dispatch), an
evidence-with-provenance primitive (Bearing), a
resolution-without-embedding-secrets primitive (Datum), and a
credentials-never-enter-records invocation primitive (Relay). The reference
mesh has none of these; its capability claims are unverified strings and its
routing decisions leave no artifact.

**Read that as "we own the primitives," not "Station uses them."** Two of the
four are not imported by Station at all and the third runs three minor versions
behind (§2.6). The asymmetry is real, but it is an asymmetry of *assets*, and
this design is largely the work of converting it into an asymmetry of *product*.
So:

| | Reference mesh | Station inference fleet |
|---|---|---|
| Tenant | A community of strangers | One owner's own machines (v1) |
| Value story | Capacity — a model too big for one box | Placement — the right model, wherever it is |
| Capability claims | Self-asserted model-name strings | Probe-verified, evidence-graded, freshness-stamped (§4) |
| Routing artifact | None | A Dispatch receipt per decision (§3.4) |
| Degraded state | Stale-status filter drops a node silently | Named degraded states, never a silent skip (§4.5) |
| Privacy bar | Prompts never transit the relay | Same bar, plus discovery-metadata minimization (§5) |

**We match their privacy bar, we do not claim to beat it.** §5 states exactly
what each participant learns, and where we are *worse* than they are today.

**Non-goal, explicitly.** Community GPU pooling and tensor-parallel model
splitting are **deferred** (§9). They serve a multi-tenant community Station
does not have yet (#1392 is P3 and sized at 2+ quarters), and the splitting
mechanics in the reference mesh are not even in that repo — they live in a
vendored SDK. Chasing them would be building the part we cannot differentiate
on, for a tenant that does not exist.

## 2. Current state, verified

Read this section before proposing anything; several plausible designs are
already foreclosed by what shipped.

### 2.1 The fleet substrate exists and is further along than #1398 assumed

`#1398` was filed when peer pairing was a spike. Slices 1–3 of #1123 have since
landed:

- **`delegation` is a real, third pairing preset** —
  `[orchestration:read, orchestration:operate]`, deliberately excluding
  `terminal:operate`, with the reasoning recorded inline
  (`packages/contracts/src/environment-security.ts:94-105`, docblock `:63-93`).
- **`DelegationTarget.kind` is `'current' | 'ssh' | 'peer'`**, and a `'peer'`
  target always carries an `Authorization: Bearer` header from a server-side
  `PeerCredentialStore` (`src-server/tools/station-control-delegation.ts:58-88`).
- **All protected callers require a credential.** Direct loopback and
  SSH-forwarded requests receive `401 authentication_required` unless they
  present a valid bearer or device-session credential. Station's exact
  per-boot internal-token attestation is a separate process credential;
  ordinary UI-proxy browser traffic remains remote.

**The documented SSH loopback auth gap in `docs/design/station-peer-pairing.md`
§4 is therefore narrowed but not closed, and this design must not build on it.**
The residual gap is stated precisely in the shipped comment
(`runtime-http.ts:175-187`): an adversary holding an SSH tunnel but no minted
credential simply *omits* the header and lands in the unconditional-pass
branch. **Consequence for this design: fleet inference must never be reachable
on a route whose only authorization is "the request arrived on loopback."** Every
inference route defined in §3 requires a presented credential and fails closed
without one — which means it also cannot be exposed over a bare SSH forward to a
peer that has not completed pairing. That is a deliberate narrowing, not an
oversight (§3.2).

### 2.2 `KnownEnvironment` is the fleet's read model, and it refuses secrets

`packages/contracts/src/known-environment.ts:82-103` is the client-side
projection that device pairing, the CLI host registry, and SSH profiles all
render into, joined by `environmentId` after a
`GET /.well-known/station/v1` handshake (`:92-97`). Its docblock explicitly
excludes two things this design will be tempted to add: **launch** (`:24-28`)
and **secrets** (`:30-35`). Fleet inference must not put a model catalog,
a credential, or an inference endpoint on this type. It is a display model.

### 2.3 Station already has a capability manifest — `station.model-inventory/v2`

This is the most important existing asset for #1398 and it is easy to miss.
`LaunchableModelInventory` (`packages/contracts/src/model-inventory.ts:64-71`)
already carries, per model:

`connectionId`, `providerId`, `runtime`/`adapter` component identity,
`model { id, revision, quantization }`, exact `providerModel`, `aliases`,
`displayName`, **`locality: 'local' | 'remote' | 'unknown'`**,
**`availability: 'available' | 'stale'`**,
**`freshness: 'live' | 'cached' | 'configured' | 'built-in' | 'stale-snapshot'`**, `observedAt`,
`effectiveContextTokens`, `toolSurface` (`null` = unknown, `[]` = known-empty),
`supportsVision`, plus a `diagnostics[]` channel with codes
`disabled | not-ready | catalog-unavailable | stale-catalog | refresh-unavailable | discovery-limited`
(`:52-63`).

It is served today at `GET /api/connections/model-inventory`
(`src-server/routes/connections/connections.ts:87-99`).

**Design consequence: the "capability manifest at join" the owner asked for is
already specified. Do not invent a second one.** A fleet capability manifest is
a `LaunchableModelInventory` fetched from a peer and attributed to its
`environmentId`. The `locality`/`availability`/`freshness`/`diagnostics` fields
are exactly the honest-degraded-state vocabulary §4.5 needs, and they were
designed under #423's handoff contract to be *observations*, not assertions
("preserves unknown runtime or tool surface as null; an empty tool array remains
known-empty" — #423 handoff contract).

**But note the exposure this creates immediately** (§5.3): `/api/connections` is
a route family classified at `orchestration:read`
(`src-server/security/pairing-route-scopes.ts:143`, `:518`). Any peer holding a
`delegation` credential can already read this Station's entire model inventory
today, with no separate consent. That is not a new hole this design opens, but
fleet inference makes it load-bearing — which is why §5.3's narrowing is a
recorded decision (§10 OQ-2), not a suggestion.

**Two known defects in this manifest must be fixed before it crosses a machine
boundary.** Both were surfaced by the slice-0 arc (§2.5) and are the reason
"reuse the existing manifest" is not the same as "the existing manifest is
ready":

- **[#1430](https://github.com/kontourai/station/issues/1430) — `toolSurface` is
  always `null`.** No LLM provider populates `supportsTools`
  (`src-server/providers/llm/model-provider-types.ts:17` is declared but unset by
  bedrock/ollama/openai-compat/anthropic/google; bedrock has a pinned test
  asserting its absence), so `unanimous()` in `launchable-model-inventory.ts`
  yields `null` for every model connection. A fleet manifest whose tool-surface
  column is structurally unknowable cannot support tool-capability routing at
  all — and per §10 OQ-5, v1 contributes **models only**, which is partly why
  that resolution is the right one now rather than a compromise. #1430 also
  records a second gap that matters more at fleet scale:
  `getCachedLaunchableModelInventory()` is populated only as a side effect of
  the `GET /api/connections/model-inventory` route and invalidated on every
  connection mutation, so **capability derivation currently depends on whether
  someone visited the Connections page**. A peer's manifest must never be a
  function of the peer operator's browsing; slice 1 needs the deterministic
  accessor #1430 calls for.
- **[#1431](https://github.com/kontourai/station/issues/1431) — evidence is
  frozen at model construction.** Grades do not re-resolve on smoke or
  connection change (§2.5). Locally that is a staleness bug; across a machine
  boundary it becomes a *false claim about another machine*, since the consuming
  Station cannot distinguish "B says confirmed" from "B said confirmed
  yesterday and never re-checked." Whatever staleness semantics #1431 settles,
  fleet routing inherits them — so it is a dependency of slice 3, not an
  unrelated follow-up.

### 2.4 Station already has a four-level evidence ladder for connections

`ConnectionEvidenceLevel = 'discovered' | 'prerequisite-ready' |
'catalog-ready' | 'smoke-passed'` with an explicit
`ConnectionSmokeEvidence { status, freshness, testedAt, freshUntil, provider,
model, durationMs, reasonCode, reason, action, turnLimit: 1 }`
(`packages/contracts/src/tool.ts:210-255`), computed at
`src-server/services/connections/connection-readiness-evidence.ts:20-60` with a
five-minute catalog freshness window (`:11`), and a bounded one-turn smoke as
the only thing that earns the top level.

**Design consequence: the admission-compliance ladder in §4 is this ladder,
lifted to the fleet.** Station has already answered "what counts as proof that a
model connection actually works," has already refused to let a catalog listing
count as a working chat turn, and already ships the copy for each degraded
state. Reusing it makes admission compliance a *projection* problem, not a new
verification stack.

### 2.5 Dispatch is wired, single-host, and unsurfaced — and self-asserted its evidence until #1426

`createConfiguredDispatchModel`
(`src-server/runtime/conversation/dispatch-model-policy.ts`) is opt-in per agent
via `execution.modelOptions.dispatch`, builds an ordered candidate list from
local model connections, and persists a `DispatchReceipt` per invocation.

**The defect this design found, and slice 0 fixed.** Before
[#1426](https://github.com/kontourai/station/issues/1426) (PR
[#1438](https://github.com/kontourai/station/pull/1438)), every candidate was
built with `evidence: { level: 'declared', capabilities:
['structured-tools','abort','usage'] }` — a constant, identical for the primary
and every alternate. `minimumEvidence` accepts `'confirmed'`, but no code path
ever produced a `'confirmed'` candidate, so the knob was dead: setting it
excluded everything. That is the exact failure mode admission compliance exists
to prevent, present *inside our own process*, and a fleet that routed on
Station-declared capability strings would have been the reference mesh's
self-assertion problem with more ceremony.

**What shipped.** Candidate evidence now derives from the connection's live
`ConnectionEvidenceLevel` through a documented mapping
(`dispatch-model-policy.ts:90-98`):

| `ConnectionEvidenceLevel` | Dispatch `EvidenceLevel` |
|---|---|
| `discovered` | `unavailable` |
| `prerequisite-ready` | `declared` |
| `catalog-ready` | `declared` |
| `smoke-passed` | **`confirmed`** — the only level backed by a real bounded completion |

with a one-rank defensive stale downgrade (`:101-105`), a fail-closed
`unavailable` for an unknown level, an `EVIDENCE_SOURCE_ID` stamped on every
derived `CapabilityEvidence.source` (`:45-66`), batched single-`listConnections()`
resolution, and an operator-legible warning when a policy-carrying call path has
no evidence source wired (`:264`). `minimumEvidence` discriminates for the first
time.

**Three facts remain load-bearing for this design:**

1. **Receipts still go to a file and a counter, and nowhere else.**
   `persistDispatchReceipt` appends NDJSON to
   `<projectHome>/monitoring/model-dispatch-receipts.ndjson` (mode `0600`) and
   increments the `modelDispatchReceipts` counter. There is **no API route, no
   UI surface, and no signature**; repo-wide, the only non-test references are
   this module and `metrics.ts:60`. The #1398 headline — *"here's the signed
   receipt of why"* — is today **neither surfaced nor signed** (§10 OQ-3;
   surfacing is slice 4).
2. **`structured-tools` was removed from derived capabilities, deliberately, and
   the gap it exposed is open.** No Station provider populates `supportsTools`,
   so `toolSurface` is `null` for every model connection and no consumer can
   truthfully assert the capability
   ([#1430](https://github.com/kontourai/station/issues/1430)). Asserting it
   would have been an unearned capability claim stacked on an honest evidence
   level. Candidates now assert `['abort','usage']`, or `[]` at `unavailable`
   (`:159-180`).
3. **Cost is operator-typed, not observed.** `estimatedUsdPer1kTokens` comes
   straight off the agent's config, validated only as a non-negative number.

**And one new one:** evidence is resolved once at model construction and frozen
into a static plan for the built agent's lifetime
([#1431](https://github.com/kontourai/station/issues/1431)) — so a `confirmed`
grade can outlive its `freshUntil` by up to a day, and an operator who runs a
smoke to earn `confirmed` sees no effect until an unrelated rebuild. §4.3's
freshness requirement is therefore not yet met even locally; see §2.3 and §11
slice 3 for what that means when the same evidence crosses a machine boundary.

### 2.6 The building blocks: what is wired, and at what version

This is the section most likely to be skimmed and most likely to invalidate a
plan. The authority boundary in #1398's first comment describes six owners;
**Datum and Bearing are not direct Station dependencies; Conduit remains on its
older host-hook contract; Dispatch and Relay are pinned at the versions used by
the implemented fleet path.**

**Declared vs. resolved vs. installed:**

| Package | `package.json` | lockfile (root) | installed in this tree | published latest |
|---|---|---|---|---|
| `@kontourai/conduit` | `0.2.1` (`:204`) | 0.2.1 | 0.2.1 | **0.6.0** |
| `@kontourai/dispatch` | `0.5.0` (`:208`) | 0.5.0 | 0.5.0 | 0.5.0 |
| `@kontourai/relay` | `0.6.0` (`:212`) | 0.6.0 | 0.6.0 | 0.6.0 |
| `@kontourai/datum` | *not declared* | 0.7.0 (transitive) | 0.7.0 | 0.7.0 |
| `@kontourai/bearing` | *not declared* | 0.2.0 (transitive) | 0.2.0 | 0.2.0 |

Version drift between a pin and the install is guarded by
`packages/cli/src/__tests__/kontour-dependency-drift.test.ts`.

- **Datum and Bearing are present but unused.** They arrive transitively
  (Bearing is a hard dependency of Datum; both are optional peers of Dispatch)
  and **no Station source file imports either** — repo-wide, the only
  non-`node_modules` mentions are in `package-lock.json`. #423's Datum routing
  is unimplemented; Station's own `resolveManagedModelBinding`
  (`src-server/runtime/plugins/runtime-provider-resolution.ts`) is a separate,
  Station-owned resolution path, not Datum's. "Datum resolves configured
  candidates" is a **target state**, not current architecture.
- **Relay is a declared runtime dependency and has direct Station consumers.**
  Fleet inference imports Relay's `ModelInvocationError` and
  `ModelInvocationErrorCode` in
  `src-server/runtime/conversation/fleet-inference-model.ts` to project peer
  refusals into Dispatch's typed retry/failover contract. Its routing and
  policy tests also use Relay's `FakeModelRuntime`. This is intentionally not
  delegated to Dispatch's transitive installation: Station imports Relay's
  public error vocabulary directly, so the root declaration pins the contract
  the fleet path executes.
- **Station's Dispatch integration now includes the composition points this
  design needs.** Dispatch 0.5.0 ships exactly the bridges §3.1's authority boundary
  assumes — `bindDatumResolvedRef(role, resolvedRef)` (maps a Datum
  `ResolvedRef` to a candidate, carrying *auth references and availability
  only, never credential values*), `capabilityEvidenceFromBearing(candidate,
  catalogDigest)`, `withCapabilityEvidence(candidates, source)` — plus
  `ExecutionAuthorization` / `AuthorizationLedger` (`reserve`/`settle`/
  `release`, with a mode-0600 `FileAuthorizationLedger`), a **durable,
  cross-call spend ceiling**. Station pins and runs Dispatch 0.5.0.
- **Conduit is wired, but only for the agent-host hook seam.**
  `conduit-framework-adapter.ts:1-9` projects Station's `IAgentHooks` through
  Conduit's lifecycle contract; `probeHostConformance` is called from
  `scripts/generate-runtime-conformance.mjs:7` and the adapter's test, emitting
  committed evidence that `verify:static` checks for staleness
  (`docs/design/conduit-runtime-integration.md:31-35`). At 0.6.0 that probe is
  a **behavioral** suite (`capability-completeness`, `install-fidelity`,
  `secret-free-install-receipt`, and per-phase `lifecycle-*`/`decision-*`/
  `context-*` checks) run against an `AgentHostAdapter` — it characterizes an
  *adapter*, not a host's tooling inventory. Conduit's stated non-goals
  explicitly exclude **model routing**. §4.3 borrows one specific idea from it
  (the `evidenceScope` distinction), and should not be read as claiming
  conduit probes fleet tooling today.
- **Station is an OpenAI-compatible *client*, never a server.**
  `src-server/providers/llm/openai-compat-provider.ts:18-40` and
  `ollama-provider.ts` dial `<baseUrl>/v1/chat/completions` outward. Station
  exposes no inference endpoint of its own. §3.2's core decision follows from
  this.
- **The pairing scope vocabulary is a closed, fail-closed set.**
  `PAIRING_SCOPES` has exactly four members, and `parsePairingScope` returns
  `null` — rejecting the whole string — on any unknown token
  (`environment-security.ts:38-52`, `:116-135`). Adding an `inference:*` scope
  is therefore **not silently additive across mixed versions**: an older host
  handed a scope string containing it rejects the entire grant. §3.3 handles
  this.
- **`StationCapabilityFlags` are compile-time constants, all `true`.**
  `src-server/capabilities/station-capability-flags.ts:20-35`. Nothing in the
  handshake is currently *runtime*-derived. Fleet inference needs both a
  protocol-support flag (static) and a participation fact (runtime); §3.3
  keeps them distinct.
- **Mobile Station is a WebView shell, not a server.**
  `src-desktop/tauri.conf.json` ships `frontendDist: ../dist-ui` with no
  sidecar or bundled binary; the Android build "wraps the same web UI in an
  Android WebView" (`docs/guides/android-build.md`). There is no Station server
  process on the phone. §7 rests on this.

### 2.7 A Dispatch-routed turn does not stream today

`createConfiguredDispatchModel` declares `capabilities: { structuredTools: true,
streaming: false, abort: true, usage: true }`
(`dispatch-model-policy.ts:91-96`). That is not an oversight in Station: Relay's
own contract has no native streaming, and its docs are explicit that its
compatibility path buffers a complete invocation and emits a stream afterward,
and **must not be described as live token streaming**.

**This is the single largest product risk in the whole feature and it is
independent of the fleet.** "Send my chat to the workstation's GPU" that
returns a wall of text after twenty seconds of nothing is a worse experience
than the local model it replaced, and users will read it as the fleet being
slow rather than as a streaming gap. Any UX evaluation of fleet routing that
does not account for this will mis-measure it.

Consequences for this design:

- The candidate set must record *whether the routing path can stream*, and the
  UI must not silently switch a streaming conversation to a non-streaming one.
- The fleet inference route (§3.2) is specified with a streaming response shape
  from the start even though Dispatch cannot consume it yet — retrofitting
  streaming onto a serve route is expensive; retrofitting it onto a Dispatch
  integration is upstream work in a sibling package.
- **Decided (§10 OQ-8): v1 scopes fleet routing to non-interactive work**
  (subagents, scheduled jobs, background delegated turns) where buffering is
  acceptable. Interactive chat is gated on streaming support landing upstream,
  and because the serve route is streaming-shaped from day one, enabling it
  later is a client change rather than a route redesign.

## 3. v1 scope: receipted personal-fleet routing

### 3.1 The contract in one paragraph

An operator marks specific local model connections on Station B as
**contributed to the fleet**. Station A, holding a peer credential for B
(#1123's mechanism), discovers B's contributed models as a fleet capability
manifest, verifies the claims it will route on, and can then run an agent turn
whose model executes on B. Every routing decision, exclusion, retry, fallback,
and budget stop is recorded as a Dispatch receipt attributing the chosen
candidate to an `environmentId` and a verification level. Nothing is contributed
by default; nothing is routed to unverified; nothing degrades silently.

**Authority boundaries** (from #1398's first comment, mapped onto §2's reality):

| Owner | Owns | Status today |
|---|---|---|
| `KnownEnvironment` | Host execution authority, environment identity | shipped (§2.2) |
| Bearing | Evidence-backed capability observations | installed transitively, **zero imports** (§2.6) |
| Datum | Resolving configured candidates | installed transitively, **zero imports** (§2.6) |
| Dispatch | Ordered routing/fallback receipts | wired at 0.5.0 with fleet routing receipts (§2.5/§2.6) |
| Relay | Invocation without credential leakage | pinned at 0.6.0; direct error-vocabulary imports in `fleet-inference-model.ts` and fake-runtime imports in routing tests; no native streaming (§2.6/§2.7) |
| Station | Availability, consent, mobile control, presentation | shipped |

Datum and Bearing remain transitive-only; the implemented fleet path directly
uses current pinned Dispatch and Relay contracts.
**This doc does not pretend otherwise, and the slice plan in §11 sequences the
composition rather than assuming it.** In particular, slices 1–4 deliberately
ship on Station-local evidence plus the Dispatch integration that exists, and
defer the Datum/Bearing composition to slice 6, so the first useful increment
does not block on a dependency bump plus two package integrations.

### 3.2 Decision: how a contributed model is actually reached

Two shapes are available, and the choice is not cosmetic.

**Option A — Station B serves an authenticated inference endpoint.** A new
route family on B (`POST /api/inference/...`, OpenAI-compatible request shape)
that B's own provider layer fulfills against the contributed connection.

**Option B — Station B hands A the upstream endpoint, and A dials it.** B
returns the contributed connection's `baseUrl` (e.g. the Ollama host) and A adds
it as an `openai-compat` model connection.

**Decided: Option A** (§10 OQ-1). Option B is less code and is wrong:

- It hands A a **raw, unauthenticated, unrevocable** path to B's inference
  backend. Ollama on a LAN has no auth; once A has the URL, revoking A's
  pairing credential revokes nothing. This directly contradicts #741's R3
  ("enrollment is one-time and revocable") and the constraint that discovery is
  not authentication.
- It cannot produce a receipt on B's side, so B has no record of what it
  served — which is the same "no artifact" posture we are differentiating
  against.
- It leaks B's network topology to A as a side effect of a capability listing.
- If B's contributed model is a *hosted* provider (a Bedrock or OpenAI
  connection), Option B degenerates into shipping a credential, which
  auth-by-reference forbids outright.

Option A costs Station a first inference-serving surface (§2.6: it has never
been one), and that surface must be treated as a genuine new attack surface:
bounded request size, bounded concurrency, no tool execution, no filesystem
access, no session creation. **Deliberately narrow: the fleet inference route
serves model completions only. It is not `delegate_task`.** Delegating a whole
*task* to another Station already exists and has a different trust story
(`docs/guides/machine-relationships.md:20-27` — the work runs there, with that
machine's agents, credentials, and workspace, and persists in its event store).
Fleet inference is the opposite: the *agent loop, tools, files, and event
record stay on A*; only the token generation happens on B.

That distinction should be stated in the guide, because it is exactly the kind
of thing users conflate — the same guide already had to correct one such
conflation (`machine-relationships.md:43-49`).

### 3.3 Decision: the authorization scope

`orchestration:operate` is **not** acceptable as the gate. It authorizes
starting arbitrary agent sessions and driving turns on B
(`pairing-route-scopes.ts` families; §2.1). "Let my laptop use my workstation's
GPU" must not imply "let my laptop run agents on my workstation."

**Decided: a fifth scope, `inference:invoke`, plus a fourth preset
`inference` = `[inference:invoke]`** — the authorization half of §10 OQ-1's
Option A. Consequences, all forced by §2.6's closed-set finding:

1. `parsePairingScope` rejects an unknown token by returning `null` for the
   whole string (`environment-security.ts:116-135`). A new token is therefore a
   **coordinated** contract change: an older host handed
   `"orchestration:read inference:invoke"` rejects the grant entirely rather
   than degrading.
2. So the mint side must be gated on a handshake flag. Add
   `StationCapabilityFlags.fleetInference` — meaning *"this build understands
   the `inference:invoke` token"*, a static protocol fact, `true`
   unconditionally like its four siblings
   (`station-capability-flags.ts:20-35`). A Station never mints a grant
   containing `inference:invoke` against a peer whose handshake omits the flag.
3. Keep **participation** separate from **protocol support**. Whether this
   Station is *currently contributing anything* is a runtime fact and must not
   be advertised in the public, unauthenticated handshake — that would let any
   unauthenticated LAN scanner enumerate which machines have GPUs (§5.2).
   Participation is discoverable only *after* authentication, on the
   fleet-manifest route.

The `/api/inference/**` family gets its own route-table entry requiring
`inference:invoke` and nothing else. Because the table classifies at
route-*family* granularity and a new endpoint under a covered prefix silently
inherits its family's tier (`docs/security/remote-access-threat-model.md`
"leaf override" discussion), a new top-level prefix is the correct shape here,
not a leaf under `/api/connections`.

### 3.4 The receipt

**What `DispatchReceipt` actually carries** (schemaVersion 1, read from the
package): `planDigest` and `requestDigest` (SHA-256 over canonicalized,
secret-free plan/request), `role`, `outcome`
(`succeeded | aborted | exhausted | budget-exceeded | no-eligible-candidates`),
`attempts[]`, `totalElapsedMs`, `totalTokens`, `estimatedCostUsd`, and — at
0.5.0 — an optional `authorization { id, invocationId, outcome }`. Each attempt
carries `candidateId`, `runtimeId`, `outcome`, `elapsedMs`, token counts,
`estimatedCostUsd`, `errorCode`, `retryable`, and reservation state.

Two gaps matter, and neither is a bug in Dispatch — they are boundary
consequences:

1. **There is no `environmentId`, and no place for one.** Dispatch's
   `candidateId`/`runtimeId` are plan-local strings. Fleet attribution needs
   either a Dispatch change or a Station-side envelope wrapping the receipt with
   the routing context. **Decided: a Station-owned
   `station.fleet-routing-receipt/v1` envelope that embeds the verbatim
   `DispatchReceipt` and adds the fleet facts.** Rationale: it keeps Dispatch's
   boundary intact ("Dispatch does not own credentials, provider SDKs, or model
   capability claims"), it does not block on a sibling release, and the embedded
   receipt stays byte-identical so its digests remain checkable.
2. **There is no exclusions channel.** `attempts[]` records only candidates that
   were *launched*. Exclusion reasoning lives upstream, in Datum's
   `CapabilityRoleResult.exclusions` / `alternatives` / `uncertainty` — which
   Station does not use (§2.6). So "why *not* that machine" cannot be answered
   from a Dispatch receipt alone, at any version. Until slice 6, the envelope
   carries Station's own exclusion records; after it, they come from Datum and
   the envelope cites both.

The envelope must be able to answer:

- **Where** it ran — `environmentId`, plus the environment's display label at
  decision time (labels change; the id is the join key,
  `known-environment.ts:92-97`).
- **Why that candidate, and why not the others** — the considered set with
  per-candidate exclusion reasons. Not-selected must be as legible as selected;
  #423's AC already demands "selection reasons, exclusions, evidence snapshot
  age/digest, uncertainty, and fallback posture," and Datum's
  `CapabilityRoleResult` already has that exact vocabulary (`posture:
  override | durable | fallback | unavailable`, plus `exclusions`,
  `advisories`, `uncertainty`) — adopt it rather than invent a parallel one.
- **On what evidence** — the level, `observedAt`, and evidence digest of the
  claim routed on (§4). This is the field that makes
  `minimumEvidence: 'confirmed'` meaningful for the first time (§2.5).
- **Under what constraint** — any binding-aware constraint that filtered the
  set (§6.3).
- **Whether the path could stream** (§2.7).
- **What it cost and what stopped it** — budget consumption and the terminal
  reason (`maxAttempts`/`maxElapsedMs`/`maxTotalTokens`/`maxCostUsd`,
  `dispatch-model-policy.ts:148-150`). Dispatch 0.5.0's
  `AuthorizationLedger` is the natural home for a *fleet-wide* ceiling that
  survives across calls and processes — worth noting now, unreachable at 0.2.0.

**Receipts must become readable.** An NDJSON file under `~/.station` that no
surface reads is not a receipt, it is a log. Slice 4 (§11) adds a bounded read
route and a monitoring surface.

**"Signed" means hash-chained in v1 (§10 OQ-3).** #1398's headline says *signed*
receipt. **No cryptographic signing exists anywhere in the building block
layer** — not in Dispatch, Relay, Bearing, Datum, or Conduit. Every "receipt,"
"observation," and "conformance evidence" record in all five is plain structured
JSON integrity-protected only by SHA-256 content digests
(`planDigest`/`requestDigest`/`invocationDigest`; Bearing's
`EvidenceDigest { algorithm: 'sha256', value }` and catalog `digest`; Conduit's
`digest()`): deterministic hashing that detects content change, with no keypair,
no signer identity, and no verify function. Producing a *signed* receipt is
**new work in a sibling repo**, not an integration.

So v1 extends that same digest discipline into a hash-chained receipt log,
reserves the signature field, and **says "receipted," not "signed" — including
in any external positioning.** Real signing is a recorded follow-up; Surface's
sigstore machinery is the natural donor when it is picked up.

**Both sides record.** B writes its own serve-side receipt for what it served
to whom. One-sided receipts are exactly the provenance shape past reviews have
flagged: a consumer-authored record of a producer's behavior is a claim, not
evidence.

## 4. Mesh admission compliance

The owner's frame: *capability manifest at join → evidence-backed verification
of claims → router routes only to verified capabilities → honest degraded
states → community-published join policy for contributor requirements.*

### 4.1 Boundary first (this is the load-bearing constraint)

**Compliance applies only to capabilities a node claims to execute LOCALLY.**

A node contributing "I can run `qwen3:8b` locally" is making a checkable claim
about *this machine*: the weights are here, the runtime is here, a turn can be
proven to complete here. That claim is admissible only with local evidence.

A node "offering" a hosted model or a remote tool is making a completely
different claim — *"I hold a reference and a credential for a thing elsewhere."*
That is a **datum auth-by-reference** question: does the reference resolve, and
is the credential present and valid? It is **never a local-capability check**,
and a probe that "verifies" it would be measuring the upstream vendor's uptime,
not this node's compliance. Conflating the two produces the worst possible
outcome: a compliance system whose green checkmarks are mostly assertions about
third parties.

Concretely:

| Claim | Kind | Admission treatment |
|---|---|---|
| "I run `qwen3:8b` on local Ollama" | local capability | probe-verified (§4.3), routable |
| "I have a Bedrock connection configured" | reference + credential | resolvable/unresolvable, **contributable but never probe-graded** |
| "I have MCP server `foo` running locally" | local capability | conformance-probed (§4.3), routable |
| "I have an API key for hosted tool `bar`" | reference + credential | reference-resolution only |

Hosted capabilities are still *contributable* — routing a peer's request through
a machine that holds a credential the requester lacks is a legitimate and
valuable fleet behavior (it is arguably the single most useful thing a
personal fleet does). The rule is only that **its receipt must say
`reference-resolved`, never `probe-verified`**, and that no probe result may
ever be manufactured for it.

**Datum already has the exact primitives for the reference branch**, which is
the strongest argument for composing rather than inventing:

- `resolveRef(ref)` returns `{ provider, kind, baseUrl?, model, auth:
  AuthStatus, apiKeyEnv?, apiKeySet }` — **without materializing the secret**.
  `apiKeySet`/`auth` is precisely the "does the credential resolve" answer
  §4.1 needs, and nothing more. (`resolve()` materializes; the fleet path must
  use `resolveRef()`.)
- `AuthRef = { env } | { keychain } | { op }` — never a literal, with a
  validator that rejects key-shaped literals outright.
- `CapabilityProviderBinding` carries `auth: { kind: 'host', ref, available }`,
  explicitly so an embedding host supplies provider identity **without Datum
  ever seeing a credential value**. That is the seam through which Station hands
  Datum its own connections.
- Dispatch's `bindDatumResolvedRef` then maps a `ResolvedRef` into a candidate
  carrying "auth references and availability only — never credential values."

So the honest hosted-contribution manifest entry is a *reference plus an
availability boolean*, end to end, with no place along the path where a secret
could enter a record even by accident. Note Datum's own non-goal while
composing: it is **not a router at call time** — "it does not load-balance,
retry, or fail over live requests." Datum resolves; Dispatch routes. Do not
push fleet failover into Datum.

### 4.2 The manifest at join

The join-time manifest is a `LaunchableModelInventory` (§2.3), filtered to
contributed connections, plus a tooling section. It is fetched over the
authenticated fleet route, never read from the public handshake. It carries no
credentials, no base URLs, and no filesystem paths — the same discipline
`KnownEnvironment` already enforces (`known-environment.ts:30-35`).

Filtering matters and is not automatic: today's inventory route returns
*everything* the Station can launch. A contributed-subset projection is new work
(slice 1), and the un-projected route staying at `orchestration:read` is the
exposure noted in §2.3/§5.3.

**Shipped in slice 1 as `station.fleet-contribution/v1`**
(`packages/contracts/src/fleet-contribution.ts`): the projection carries each
contributed model's identity, `locality`/`availability`/`freshness`/
`observedAt`, `effectiveContextTokens`, and `supportsVision`, plus a
four-state `participation` field and a `diagnostics[]` channel. It carries no
credentials, no base URLs, no filesystem paths, no capability columns, and no
self-asserted `environmentId` — see §11 slice 1 for the reasoning on each
omission. The tooling section this section anticipates is out of v1 scope
(§10 OQ-5) and would be an additive field.

**Two timestamps, deliberately not both called `observedAt`.** The envelope
carries `projectedAt` (wall-clock time the projection ran) and
`sourceObservedAt` (the underlying inventory's own observation), and only the
second is a freshness input. Every other `observedAt` in this stack — the
inventory envelope's, and the per-model one this manifest carries through —
means observation age, so an envelope field named `observedAt` would read as
"this evidence is current" to a consumer that had learned the convention,
while always being roughly `now`. §4.3's freshness requirement is a claim
about `sourceObservedAt` and the per-model `observedAt`, never about
`projectedAt`.

**The diagnostic vocabulary is closed.** `station.model-inventory/v2` is an
internal contract that may grow a code; `station.fleet-contribution/v1` is
peer-facing and may not grow silently. The carried subset is frozen as
explicit literals with a compile-time assertion that fails the build if the
inventory gains a code, so widening the wire enum is always a version
decision. An unrecognized code is renamed rather than passed through or
dropped.

**Decided in slice 2 — bound the text, keep the code authoritative.** The
remaining half was what to do when a manifest read across a machine boundary
renders *another Station's* message strings: render them verbatim, normalize
to the code, or bound them. Dropping the text loses the exact wording an
operator already recognizes from their own Connections surface, which is most
of its value when two people are debugging one fleet. Passing it verbatim
lets a remote Station decide how many bytes the response costs and hands the
consumer's renderer an unbounded foreign string. So the serving boundary
truncates each message (240 characters) and bounds the diagnostic and model
counts, reporting any truncation through the existing `inventory-truncated`
code rather than by returning a shorter list — a shorter list is the silent
degradation §4.5 bans. A consumer branches on the closed `code`; the message
is supporting prose it renders as prose.
(`boundFleetContributionManifest`, `fleet-inference-service.ts`.)

### 4.3 Verification: the ladder, lifted

Reuse `ConnectionEvidenceLevel` (§2.4) rather than inventing a fleet ladder:

| Level | Fleet meaning | Produced by |
|---|---|---|
| `discovered` | The peer names it; nothing checked | manifest read |
| `prerequisite-ready` | Peer reports required prerequisites satisfied | peer-reported, **peer-trusted** |
| `catalog-ready` | A live catalog on the peer lists this exact `providerModel` | peer `freshness: 'live'` |
| `smoke-passed` | A bounded one-turn completion actually ran on the peer for this model | peer smoke evidence, `turnLimit: 1` |

Two honesty constraints that must survive review:

1. **Levels above `discovered` are the PEER's observations, relayed.** A
   verifies that B *reports* a passing smoke with a fresh `testedAt`; A did not
   itself watch B run it. This is strictly better than the reference mesh's
   position (B ran a real turn rather than typing a model name) and strictly
   weaker than independent attestation. The receipt must say which, and the
   field name must not imply more than it delivers. Call it
   `peerAttestedLevel`, not `verifiedLevel`.

   **There is direct precedent for this distinction in our own stack:** Conduit
   tags conformance evidence with
   `evidenceScope: 'adapter-contract' | 'host-bound'`, and states that
   adapter-contract rows "prove the projection and redaction contract, not a
   live host" — a consumer must record `host-bound` evidence with real bindings
   before using results for runtime selection. That is exactly the
   peer-attested-vs-path-verified split, already named and already enforced by a
   sibling package. Reuse the shape and the discipline.

   Note the gap does **not** close by adding Bearing: Bearing's observations are
   content-addressed, not signed (§3.4). What Bearing adds is a *disciplined
   record* of provenance, freshness, and uncertainty — not an unforgeable one.
   Independent attestation needs #1392's owner attestation and a signing story
   that does not exist yet (§6.2; §10 OQ-3 records signing as a follow-up).
2. **A is entitled to demand its own smoke.** A consumer may require a fresh
   end-to-end completion *through the fleet path it will actually use* before
   promoting a capability to routable. That is the only level A can assert
   first-hand, and it should be an explicit level: `consumer-verified`. It is
   also the only one that proves the *path*, not just the peer — a model that
   works locally on B but is unreachable through B's inference route is exactly
   the failure a manifest cannot catch.

**Tooling conformance** uses conduit's `probeHostConformance` in the same spirit
as `docs/design/conduit-runtime-integration.md` — characterize a capability and
emit portable evidence rather than assert a boolean. Be honest about the fit:
at 0.6.0 that probe runs a behavioral suite (`capability-completeness`,
`install-fidelity`, `secret-free-install-receipt`, per-phase `lifecycle-*` /
`decision-*` / `context-*`) against an **`AgentHostAdapter`**, and Conduit's
non-goals explicitly exclude model routing. Probing "is MCP server `foo`
actually available and conformant on this host" is a *new subject* for that
contract, and it also requires Station to move from conduit 0.2.1 to 0.6.0
(§2.6). **This needs Conduit's owner to confirm the contract fits before it is
depended on** (§12); if it does not, slice 5 needs its own probe contract and
grows accordingly.

**Freshness is mandatory, not decorative.** Every level carries `observedAt` and
an explicit expiry, mirroring `ConnectionSmokeEvidence.freshUntil` and the
five-minute catalog window (`connection-readiness-evidence.ts:11`). A level
without freshness is a claim about the past presented as a fact about now.
Bearing's `Freshness { observedAt, validUntil }` is the same shape, which is
what makes slice 6's migration a re-key rather than a rewrite.

**When Bearing lands, the observation record is already specified.**
`bearing.observation/v2` carries `kind: 'evaluation' | 'declaration'`,
`model { id, revision, quantization }`, an `execution` scope,
`measurements[] { key, kind: 'fact' | 'sample', value, unit? }`,
`sourceClass: 'first-party' | 'external'`,
`evidence[] { id, kind, uri, digest, observedAt }`, `freshness`, and
`uncertainty { level, basis[], gaps[] }`; `compileCatalog` produces a
deterministic, digest-addressed `CatalogSnapshot`, and `rankCatalog` evaluates
only caller-supplied inventory, applying hard requirements as exclusions before
preferences score. Two properties are worth naming because they are exactly
what fleet admission needs: the mandatory `uncertainty` triple, and the fact
that ranking **explains missing, stale, conflicting, incomparable, and
unsatisfied evidence** rather than silently dropping a candidate. The
`declaration` vs `evaluation` distinction also maps cleanly onto §4.1's
reference-vs-local split — a hosted contribution is a `declaration`, a local
smoke is an `evaluation`.

### 4.4 The router routes only to verified capabilities

The routing rule: a candidate enters the Dispatch candidate set only at or above
the policy's `minimumEvidence`, and the receipt records the level it entered at.
This is what finally makes `minimumEvidence: 'confirmed'` real (§2.5).

**This forces a local fix first.** Station's current Dispatch integration
hardcodes `level: 'declared'` with a fixed capability triple for every candidate
including the primary (`dispatch-model-policy.ts:65`, `:79-82`). Fleet candidates
graded on real evidence would sit next to local candidates graded on a constant
— and because the receipt is the product, an unearned `declared` on the local
path is a lie in the artifact we are selling. Slice 0 (§11) fixes the local
grading before any fleet candidate exists. It is small, independently useful,
and prevents the fleet work from inheriting the defect.

### 4.5 Honest degraded states

Station's precedent is strong here and should be followed literally: a
`diagnostics[]` channel with named codes plus a human `message`, never a silent
omission (`model-inventory.ts:52-63`). Fleet-specific codes, each with a summary
and an action, mirroring `connection-readiness-evidence.ts:39-60`'s copy shape:

- `peer-unreachable` — the environment is not answering.
- `peer-scope-denied` — reachable, but this Station's credential lacks
  `inference:invoke` (likely revoked, or paired before the capability existed).
- `evidence-stale` — the peer's last observation is past its freshness window.
- `probe-failed` — a verification attempt ran and failed, with the peer's
  `ConnectionSmokeFailureReason` carried through (`tool.ts:220-230`).
- `capability-withdrawn` — the peer previously contributed this and no longer
  does.
- `reference-unresolvable` — a hosted/remote contribution whose reference or
  credential does not resolve **on the peer** (§4.1), which is a different
  sentence from "the model is down."
- `below-minimum-evidence` — present and healthy, but the policy requires a
  higher level than this capability has earned.

The `below-minimum-evidence` case is the one that will be tempting to hide,
and is the one users most need to see: it is the difference between "you have no
GPU model" and "you have one and I refused to trust it yet."

Two banned behaviors, stated so review can enforce them: **never** drop an
unverified capability from the UI without a diagnostic (the reference mesh's
stale-status filter does exactly this — a node just stops appearing), and
**never** silently fall back from a fleet candidate to a hosted one without the
fallback appearing in the receipt and, when it costs money, in the UI.

### 4.6 Community join policy — the knob, and why it is a knob

The owner's scope names "a community-published join policy for contributor
requirements." Two findings shape how far this doc goes:

1. The reference mesh has **no such mechanism** (§0). Its join policy is
   terms-of-service text. There is no proven pattern here to adopt.
2. Station has **no community tenant** to publish one. #1392 is P3 and
   explicitly sized at 2+ quarters.

**Decided: design the seam in v1, ship no policy engine.** Concretely,
the admission decision is a single named function over
`(manifest, evidence, policy)` returning `admitted | rejected(reason) |
degraded(reason)`, with v1's policy being the fixed personal-fleet policy
"everything the owner contributed, at or above the owner's `minimumEvidence`."
That keeps the extension point real and honest without inventing requirements
for a tenant that does not exist.

What the seam must be *shaped* to accept later — recorded now so v1 does not
foreclose it — is a signed, versioned policy document naming required
capabilities, minimum evidence level per capability, maximum evidence staleness,
and a stated consequence for non-compliance (rejected at join vs. admitted as
consume-only vs. admitted degraded). It must be signed, because an unsigned
join policy fetched from a coordinator is a coordinator that can silently
demand more of you over time.

**Explicitly deferred: contribution-required-to-consume economics** (owner
direction). No credits, no quotas, no metering, no "you must serve to consume."
Note for whoever picks that up: the reference mesh ships a purely informational
local usage dashboard and no metering at all, and frames the whole thing as a
gift economy — so there is again no prior art to copy, and the design question
is open rather than settled.

## 5. Privacy posture

### 5.1 The bar

The reference mesh's claim is "the relay coordinates trust but never sees
prompts," and in its inference path this is **architecturally enforced**, not
merely asserted: publication of node presence to public relays is hardcoded off,
and content moves over a direct encrypted QUIC session the relay is not part of.

Station's v1 posture is **structurally simpler and therefore easier to hold**:
there is no coordinator at all. A talks to B directly over an authenticated
HTTP path it already knows how to reach (`AccessEndpoint`,
`known-environment.ts:69-80`). Prompts transit exactly two machines, both the
owner's.

Stated as the contract:

- **No third party sees prompt or completion content, because there is no third
  party in the request path.** This holds by construction in v1 and must be
  re-argued, not assumed, the moment any coordinator, relay, or directory is
  introduced (#615, #1392).
- **Station B — the serving machine — sees everything it is asked to
  generate.** It must, to generate it. This is the same bound the reference mesh
  concedes in its own vision doc: prompts go to people rather than a vendor,
  which is a different promise than "never leaves your machine." In v1 that
  peer is the owner's own machine, which is why v1 is defensible and community
  pooling is a separate consent conversation entirely (§9).
- **The serving Station logs a serve-side receipt** (§3.4), which is by design a
  record that a prompt was served — its metadata, not its content. Per §10 OQ-4
  those receipts stay **local to the machine that wrote them** in v1; whether
  they ever replicate is deferred to #741 slice 3, where replication consent
  actually lives.

### 5.2 Discovery metadata minimization

This is where the reference mesh is genuinely weaker and we should not copy it.
Its discovery note publishes, to a relay that stores and serves it to any
querier: the member's identity linked to a machine-level key, **the plaintext
list of model names served**, a dial token for the node, and — via a 45-second
heartbeat — a precise online/offline timeline for every participating machine.
Trust admission is enforced, but *observability* of the roster is essentially
public. NAT traversal additionally routes through a third-party relay pool by
default, which sees connection timing and addresses even though it cannot read
content.

Station's rules, chosen against that:

1. **Nothing about inference participation appears in the public,
   unauthenticated handshake.** `GET /.well-known/station/v1` is
   public (`pairing-route-scopes.ts:94`). It may advertise `fleetInference` as a
   *protocol-support* flag (§3.3) — it must never advertise contributed model
   names, counts, hardware, or activity. Otherwise any LAN or tailnet scanner
   enumerates the owner's GPUs.
2. **Model names are authenticated-read only**, behind `inference:invoke`, and
   contributed-subset-projected (§4.2). A model name is a meaningful signal — it
   discloses hardware class, spend, and what the owner works on.
3. **No heartbeat broadcast.** Fleet liveness is pull-based on demand from a
   peer that already holds a credential. A periodic push to any shared location
   creates the timeline the reference mesh's design leaks.
4. **No mDNS/LAN advertisement of inference capability.** `AccessEndpointKind`
   already includes `'discovered'` for unconfirmed reachability
   (`known-environment.ts:67`); that channel conveys "a Station may be here," and
   must never be extended to convey what it can run.
5. **Metadata minimization is a stated requirement of the receipt too.** A
   receipt that names every candidate model on every machine, replicated across
   the fleet (#741 slice 3), is a fleet-wide inventory disclosure by another
   route. This is why §10 OQ-4 keeps receipts **local-only in v1** and hands the
   replication question to #741 slice 3 rather than settling it here.

### 5.3 The exposure this design does not create but must not ignore

`GET /api/connections/model-inventory` is currently readable by any peer holding
`orchestration:read` (§2.3). Today that is a `delegation`-scoped peer or a
Standard paired device. That predates this design. But #1398 makes the model
inventory a *routing input*, which raises the value of the disclosure and makes
"who may enumerate my models" a question worth answering deliberately rather
than inheriting.

**Decided (§10 OQ-2): leaf-override `/api/connections/model-inventory` to
require `inference:invoke`, and serve the contributed-subset projection there.**
The precedent is exact: `GET /api/environments/ssh/sessions` was deliberately
raised above its family's tier for cross-station data, using the route table's
longest-prefix leaf-override mechanism, with the reasoning that tightening now
is reversible and discovering the exposure later is not
(`docs/security/remote-access-threat-model.md`, "Cross-station reads"). This is
a scope-narrowing change to a shipped route, so it lands in slice 2 alongside
the scope it depends on, and its blast radius is still un-enumerated (§12).

### 5.4 Who can actually turn contribution on

This doc says "an operator marks specific local model connections as
contributed" (§3.1), and slice 1's opt-in is honest about being explicit and
default-off. But **"the operator" is not currently a narrower authority than
"any peer holding `orchestration:operate`"**: the opt-in is an `AppConfig`
field, and `PUT /config/app` sits in the `/config` family at
`orchestration:operate` (`pairing-route-scopes.ts`). So a `delegation`-scoped
peer or a Standard paired device can flip `fleetContribution.enabled` and
name connections, without any consent step distinct from the one that let it
drive orchestration.

That is not a regression slice 1 introduced — the same credential can already
edit every other Station-scope setting — but it is a **gap between what this
doc's prose implies and what the authorization actually enforces**, and
contribution is a materially different act from the rest of `AppConfig`: it
decides whether this machine will generate tokens for someone else. Stating
it plainly rather than letting "the operator names the connections" imply a
consent boundary that does not exist.

**Decided in slice 2: the existing `orchestration:operate` tier stands, and
this stays a disclosure rather than becoming a mitigation.** The question was
whether the opt-in needs a narrower write path — a local-only mutation, a
dedicated scope, or an explicit confirmation.

The reason not to add one is that the escalation does not exist in the
direction it appears to — **on one precondition, which the code now enforces
rather than assumes**. A credential that can flip `fleetContribution` holds
`orchestration:operate`, which authorizes starting arbitrary agent sessions
and driving turns on this Station — **strictly more authority over this
machine's compute than causing it to serve buffered completions**. Flipping
the opt-in grants that credential nothing, because contribution only widens
what a holder of `inference:invoke` can reach, and after slice 2's decoupling
no credential holds that scope implicitly — not an unscoped grant, not a
migrated pre-scoping credential, not the operator bootstrap credential. So a
dedicated scope or a consent ceremony would sit in front of the *lesser* of
two powers the same credential already has, and every ceremonial gate teaches
agents and operators which gates are ceremony.

**The precondition is that the flipper is not the beneficiary, and one grant
can hold both scopes.** A peer carrying `orchestration:operate
inference:invoke` could enable contribution, name a connection — including a
*billable hosted* one, since `connectionIds` rides the same write — and then
spend the owner's money through `/api/inference/**`, with no operator in the
loop at any step. That is not "less authority than running agents here"; it is
a self-authorized, self-serving budget, and the argument above does not cover
it. So the guard is placed on the beneficiary rather than on the tier: **a
presented credential holding `inference:invoke` is refused any write to
`fleetContribution`** (`routes/system/config.ts`), covering `connectionIds` as
well as `enabled`, scoped to that one field, and not applying to a caller
presenting no credential — the local operator, who is exactly who should be
deciding this. Found by the round-1 security review; the original disposition
was right about the case it considered and silent about this one.

What remains true, and is why this is recorded rather than closed: the real
defect is that `PUT /config/app` is a broad write surface at a broad tier.
Narrowing that surface generally is the honest fix; carving out one field
would leave the shape intact and the next materially-different setting would
inherit the same gap. The scope vocabulary slice 2 adds makes a later
tightening cheap. Stated in `docs/reference/api.md` under Fleet Inference so
an operator reading the route contract learns it there rather than inferring
a consent boundary that does not exist.

## 6. Trust groups, attestation, and binding-aware routing

### 6.1 Trust-group gating in v1

v1's trust group is exactly "environments this Station holds an
`inference`-scoped peer credential for." No new grouping primitive. Contribution
is per-connection and per-peer, not global: contributing a model is not
"contribute to the fleet," it is "B contributes model M to A." That keeps
revocation meaningful — revoking A's credential in B's device list ends A's
access immediately, using the existing mechanism
(`machine-relationships.md:39`), with no separate inference ACL to forget to
clean up.

### 6.2 Relationship to #1392 owner attestation

#1392's owner attestation (an agent carrying a signed authorization from its
human owner; revoking the owner instantly de-auths all their agents) is the
primitive that would let fleet inference cross an ownership boundary safely. The
composition is clean and should be recorded now:

- v1's implicit claim is *"same owner, therefore trusted."* It is enforced by
  credential possession, not by a verifiable statement of ownership.
- Owner attestation turns that into an explicit, verifiable, centrally-revocable
  statement — and, critically, gives a *serving* Station a reason to accept a
  request from a consumer it was not individually paired with.
- **Until then, this design must not introduce a "trusted group" abstraction
  that implies ownership it cannot verify.** Naming something a trust group when
  it is a credential list is the class of provenance overstatement that reviews
  in this repo consistently catch.

The reference mesh's own owner-binding scheme is worth studying when #1392 gets
there — it binds a machine-level key to a community identity with two
signatures, one of which covers the *exact advertised endpoints*, specifically so
that controlling the community key alone cannot substitute an endpoint. Its
weakness is equally instructive: revocation lags up to two poll intervals and
requires a process restart, because the trust store is fixed at node start.
Station should not adopt a design whose revocation needs a restart — #741 R2/R3
and the existing device-list revocation semantics set a higher bar we already
meet.

### 6.3 Binding-aware routing constraints (#1425)

#1425 splits a Project into a portable manifest (remote-keyed resources) and
per-Station local bindings (remote → local checkout path). Its own text names
the join point: *"run this task on whichever of my Stations has a binding for
repo X"* becomes a routing constraint with a Dispatch receipt.

For **fleet inference specifically**, the composition is narrower than it first
appears and the distinction is worth writing down:

- Fleet inference moves **token generation**. The agent loop, tools, and files
  stay on A (§3.2). A binding constraint is therefore usually *irrelevant* to
  choosing where to generate tokens — B does not need the repo to run the model.
- Where it *does* bind is the sibling case: **task** delegation (`delegate_task`,
  #1123) genuinely needs the repo present, and #1425's binding is the constraint
  that makes "route to a capable machine" honest instead of hopeful.

So: the receipt schema should carry a general `constraints[]` channel with
binding constraints as its first member, and the *router* should support them
uniformly, but v1 fleet-inference routing will rarely populate it. Building the
channel now costs little and stops #1425 and #1123 from each inventing their
own. **Claiming binding-aware inference routing as a v1 user-facing feature
would be overselling it** — the honest v1 statement is "the receipt can cite a
constraint, and task routing is where constraints do the work."

## 7. Mobile

### 7.1 Mobile as consumer — yes

A phone running the Station client benefits directly and needs nothing new: it
is already a client of a Station server, and that server does the routing. The
only mobile-specific requirements are presentational and they matter:

- A routing decision that sends the phone's chat to the workstation's local
  model must be **visible**, because it changes where the prompt goes. Silent
  cross-machine routing of a phone's conversation is a consent surprise even
  when both machines are the owner's.
- Receipt and degraded-state surfaces must work on a phone, since the phone is
  the client most likely to be the one that cannot reach the workstation.

### 7.2 Mobile as contributor — **no for v1** (decided, §10 OQ-7)

Reasons, in order of decisiveness:

1. **There is no server to contribute with.** Station's Android build is a Tauri
   WebView wrapping the same web UI (`docs/guides/android-build.md`), with
   `frontendDist: ../dist-ui` and no sidecar binary
   (`src-desktop/tauri.conf.json`). There is no Station server process on the
   phone, so there is nothing to expose an inference route from. This is not a
   small gap — it is a different product.
2. **Nothing would meet the admission bar anyway.** §4's ladder tops out at a
   completed one-turn smoke with a freshness window. A phone that is
   backgrounded, thermally throttled, on battery, or on a metered radio cannot
   hold a fresh liveness claim honestly, and #741 R4 requires offline instances
   to degrade *honestly* rather than appear routable.
3. **The reference implementation reaches the same conclusion.** Its shared
   compute is a desktop-only compile-time feature; the mobile client does not
   participate as contributor or first-class consumer, and its vision doc talks
   only about desktops and workstations. Independent arrival at the same answer
   is worth something.
4. **The value is near zero and the cost is not.** The models a phone can run
   are models any fleet member can already run better, and the routing overhead
   plus the honesty machinery to keep its state truthful would exceed the
   benefit.

**What would change the answer** (record it so the decision is revisitable
rather than permanent): a genuine on-device Station server, plus a
platform-supported foreground-service story, plus a use case where the *phone's*
model is uniquely valuable — most plausibly an on-device model with private data
locality that the owner deliberately does not want leaving the handset. That is
a different feature ("keep this on the phone") wearing the fleet's clothes, and
should be designed as such.

## 8. What "receipt" must not become

A short section because past reviews in this repo have found this class of
defect repeatedly, and this feature is unusually exposed to it: the receipt is
the product, so a receipt that overstates is a product defect, not a logging
bug.

- A receipt must never record a verification level the system did not obtain.
  Peer-attested is not verified (§4.3).
- A receipt must never attribute a *reference-resolution* to a *probe* (§4.1).
- A receipt must never omit a fallback because the fallback succeeded. Retries
  and fallbacks are the whole reason the artifact exists.
- A receipt must never be assembled by the consumer alone and presented as
  evidence about the producer. Both sides record (§3.4).
- A missing field must render as unknown, never as a default that decides
  (`docs/guides/code-quality.md`'s "a default that decides" review question).

## 9. Explicitly deferred

| Deferred | Why | Revisit when |
|---|---|---|
| Community GPU pooling (non-owner contributors) | No community tenant; consent story is entirely different when the serving peer is a stranger | #1392 ships membership + owner attestation |
| Tensor-parallel / model splitting across machines | Serves capacity, not placement; the reference implementation's own splitting lives in a vendored SDK, not something we can study or match cheaply | A concrete user need for a model no single fleet machine can hold |
| A virtual aggregate "fleet" model (mixture-of-agents style) | Presenting many machines as one model hides exactly the placement decision the receipt exists to expose | After receipts are surfaced and understood |
| Contribution-required-to-consume economics | Owner direction; also no prior art in the reference implementation | Community tier exists and free-riding is observed |
| A policy *engine* for join policy | No tenant to publish one (§4.6) | #1392 |
| Coordinator/relay-mediated discovery | v1 needs none; introducing one re-opens the entire privacy argument (§5.1) | #615/#1392, with a fresh privacy analysis |
| Fleet routing for embeddings, vision, audio | Scope discipline; the evidence ladder is defined for chat completion turns | After chat-completion routing is proven |
| Automatic/`Auto` fleet-wide model selection | #423's Auto is a local feature and is itself unimplemented; auto-selecting across machines before receipts are readable would be unauditable | #423 lands, receipts are surfaced |
| Fleet routing for **interactive chat** | A Dispatch-routed turn does not stream and Relay has no native streaming contract (§2.7); a buffered chat reads as "the fleet is slow" | Streaming lands upstream — the serve route is streaming-shaped from day one, so this is a client change (§10 OQ-8) |
| **Tool** contribution (vs. models) | Tool-surface data is structurally unknowable today (#1430), so a contributed tool could not be graded honestly (§2.3) | #1430 closes and slice 5 lands the conformance probe (§10 OQ-5) |
| Cryptographically **signed** receipts | Nothing in the building-block layer signs; v1 ships hash-chained receipts and says "receipted" (§3.4) | A signing story with a revocation path exists — Surface's sigstore machinery is the natural donor (§10 OQ-3) |
| Receipt **replication** across the fleet | A replicated receipt corpus is a fleet-wide inventory and activity log (§5.2 rule 5) | #741 slice 3, where replication consent lives (§10 OQ-4) |

## 10. Decisions recorded

All nine questions this doc raised were resolved by the owner on **2026-08-01**
([decision comment on #1398](https://github.com/kontourai/station/issues/1398#issuecomment-5151783495)),
each adopting the analysis's recommendation. The reasoning is retained below
because the decisions are only durable if the tradeoff that produced them is
still legible; the identifiers stay `OQ-n` so the doc, the issue comment, and
the slice plan refer to the same items.

- **OQ-1 — Serve-side shape. DECIDED: Option A.** Station B serves an
  authenticated inference route; **completions only, never `delegate_task`**.
  Rejected: handing the consumer the upstream endpoint (Option B), which gives
  A a raw, unauthenticated, unrevocable path to B's backend, produces no
  serve-side record, leaks B's topology, and degenerates into shipping a
  credential for hosted connections (§3.2). Cost accepted: Station's first
  inference-serving surface, which §3.2 bounds deliberately.
- **OQ-2 — `model-inventory` scope. DECIDED: raise it.**
  `GET /api/connections/model-inventory` moves from its family's
  `orchestration:read` to `inference:invoke` via the route table's
  longest-prefix leaf override. This is a **narrowing of a shipped route** and
  could break an existing paired-device consumer; accepted on the
  cross-station-reads precedent — tightening now is reversible, discovering the
  exposure later is not (§5.3). Blast radius is still un-enumerated (§12).
- **OQ-3 — "Signed" means hash-chained for v1. DECIDED: option (a).**
  **Nothing in Dispatch, Relay, Bearing, Datum, or Conduit signs anything** —
  all five are SHA-256 content-digest only, with no keypair, signer identity, or
  verify function (§3.4). v1 extends that digest discipline into a hash-chained
  receipt log, reserves the signature field, and **changes the external wording
  to "receipted," not "signed."** Real signing is a recorded follow-up, with
  Surface's sigstore machinery named as the natural donor. Rejected for now:
  signing with the serving Station's environment key, because a signature whose
  key has no revocation path is worse than an honest hash chain — and shipping
  "signed" while meaning "hashed" is precisely the provenance overstatement this
  repo's reviews exist to catch.
- **OQ-4 — Receipts are local-only in v1. DECIDED.** Receipts stay on the
  deciding Station; the replication question is deferred to **#741 slice 3**
  (owner-scoped conversation replication) rather than being settled here. A
  replicated receipt corpus is a fleet-wide inventory and activity log (§5.2
  rule 5), so it needs its own consent decision in the context that owns
  replication.
- **OQ-5 — Contribution is models only. DECIDED.** v1 contributes model
  capabilities, not tools. The §4.1 boundary (local-execution claims vs.
  reference-plus-credential) is designed and written down, but the tooling
  manifest and the conduit conformance probe do not ship until slice 5.
  Reinforced by #1430: tool-surface data is structurally unknowable today
  (§2.3), so a v1 tool contribution could not have been graded honestly anyway.
- **OQ-6 — The consumer's own smoke counts against budget. DECIDED.** A
  `consumer-verified` probe (§4.3) is a real inference call on real hardware; it
  is metered and it appears in the receipt like any other attempt. A
  verification that hides its own cost is the same class of dishonesty the
  receipt exists to prevent.
- **OQ-7 — Mobile as contributor: no for v1. DECIDED.** Reasoning and the
  explicit revisit conditions are in §7.2. Mobile as *consumer* is in scope and
  needs no new mechanism.
- **OQ-8 — v1 is scoped to non-interactive work. DECIDED: option (b).** A
  Dispatch-routed turn does not stream (§2.7) and Relay has no native streaming
  contract, so v1 fleet routing covers subagents, scheduled jobs, and background
  delegated turns, where buffering is acceptable. Interactive chat is gated on
  streaming support landing upstream. **The serve route is specified for
  streaming from day one**, so enabling interactive chat later is a client
  change rather than a route redesign. Rejected: shipping buffered interactive
  chat, which would be read as "the fleet is slow" and would mis-teach users
  about the feature on first contact.
- **OQ-9 — The Dispatch 0.2.0 → 0.5.0 bump was its own change. SHIPPED.** The
  bump unlocked `bindDatumResolvedRef`, `capabilityEvidenceFromBearing`, and
  `AuthorizationLedger` (§2.6).
  **The #1426 conformance tripwire is armed for it** — the tripwire cross-checks
  the real `dispatch()` engine's admissions against the exclusion log with no
  hardcoded oracle, so a behavior change in the bump surfaces as a test failure
  rather than as silently different routing. Tripwire hardenings **R3-a/b/c** are
  scoped to that PR.

## 11. Slice breakdown

Each slice is independently shippable and independently useful. Slices 0–4 are
the v1 product; 5–7 are the composition work that makes the authority boundary
in §3.1 true rather than aspirational.

**Slice 0 — Honest local Dispatch evidence. SHIPPED**
([#1426](https://github.com/kontourai/station/issues/1426), PR
[#1438](https://github.com/kontourai/station/pull/1438)). Candidate evidence now
derives from the connection's live `ConnectionEvidenceLevel` instead of a
hardcoded `'declared'` constant, with a documented mapping, a stale downgrade
floor, an evidence `source` stamp, batched resolution, and exclusion-legibility
logging; `minimumEvidence` discriminates for the first time (§2.5). No fleet
code, as designed — every later slice inherits this grading, and shipping fleet
routing on top of a constant would have put a lie in the artifact we are
selling.

Two follow-ups it surfaced are **inputs to slices 1 and 3, not unrelated
cleanup** (§2.3): [#1430](https://github.com/kontourai/station/issues/1430)
(`supportsTools` unpopulated → `toolSurface` always `null`, plus the
route-populated inventory cache that makes capability derivation depend on a UI
visit) and [#1431](https://github.com/kontourai/station/issues/1431) (evidence
frozen at model construction, so a `confirmed` grade can outlive its
`freshUntil`). A third residual — the conformance tripwire hardenings
**R3-a/b/c** — is scoped to the Dispatch bump PR (§10 OQ-9).

**Slice 1 — Contribution opt-in + contributed-subset manifest. SHIPPED.**
A "contribute to fleet" opt-in through the settings registry
(`AppConfig.fleetContribution`, `packages/contracts/src/settings-registry.ts`),
default off; a contributed-subset projection of `LaunchableModelInventory`
(`station.fleet-contribution/v1`,
`packages/contracts/src/fleet-contribution.ts` +
`src-server/services/connections/fleet-contribution-manifest.ts`); and the
`fleetInference` handshake flag **declared on the contract but not yet
advertised** — see the correction below. **Models only** (§10 OQ-5). No routing and no
route: the manifest is readable through
`ConnectionService#getFleetContributionManifest()` and correct before anything
consumes it — slice 2 owns the authenticated surface, because serving
contributed model names on today's `orchestration:read` connections family
would widen exactly the disclosure §5.3 narrows.

Four contract decisions, recorded because slice 2/3 build on them:

- **The opt-in is an explicit allowlist, not a mode.** `{ enabled?, connectionIds? }`;
  absent, `enabled` absent, any non-`true` `enabled`, and an empty allowlist
  all contribute nothing, and there is no value that contributes a connection
  the operator did not name. `isFleetContributionEnabled` is the single
  fail-closed read; a Station that has not opted in performs no inventory
  refresh at all.
- **No capability columns.** The projected record deliberately omits
  `toolSurface`: no provider populates `supportsTools`, so the source column
  is `null` for every model connection in production (#1430) and a
  structurally-unknowable column reads as an observation. Re-adding it once
  #1430 lands is an additive optional field. `supportsVision` IS carried — it
  has a real source (Bedrock's declared input modalities) and `null` there
  honestly means unknown.
- **No `environmentId` in the body.** A peer's manifest is attributed by the
  consumer to the environment it authenticated to; a self-asserted identity
  field adds nothing the transport identity does not already establish, and
  can only ever disagree with it.
- **Participation is a four-state fact; the empty array is never the
  signal.** `disabled` / `nothing-contributed` / `contributed-unavailable` /
  `contributing` — three of the four carry `models: []`, so `participation`
  plus `diagnostics` always name *which* empty it is. A contributed
  connection that yields no model carries the local inventory's own reason
  code through, a whole-Station degradation (`refresh-unavailable` from the
  stale-snapshot substitution or truncation) is carried at manifest scope, an
  unreadable inventory is `inventory-unavailable` ("unknown", not "empty"),
  a marked id that resolves to nothing is `contribution-unknown-connection`,
  and a non-`local` contribution is offered but flagged
  `contribution-not-local` (§4.1: a reference claim, not a local-capability
  claim). These are the **serving side's** codes, distinct from §4.5's
  consumer-side vocabulary (`peer-unreachable`, `peer-scope-denied`, …),
  which slice 3 owns.

  Two consequences for slice 3, stated so they are not rediscovered:
  **the router must not key on `participation` alone** — `contributing`
  means "at least one model projected", not "every model is healthy", so
  admission still has to read per-model `availability`/`freshness` and the
  connection-scoped diagnostics. And `contribution-unknown-connection`
  depends on `LaunchableModelRecord.connectionKind` being exactly
  `'model' | 'agent'`: "resolved but not contributable" and "did not resolve"
  are exhaustive only under that invariant, so a third kind would make a
  present-but-unclassified connection read as "no such connection".

**Correction to this slice's handshake half — the flag is declared, not
advertised.** §3.3 point 2 defines `fleetInference` as *"this build
understands the `inference:invoke` token"*. A slice-1 build does not: the
token is not in `PAIRING_SCOPES`, and `parsePairingScope` rejects the whole
scope string on an unknown token. A build advertising the flag while still
rejecting the token would invite a peer to mint
`"orchestration:read inference:invoke"` against it and have the grant
refused outright — the exact mixed-version failure the flag exists to
prevent, and an unearned capability claim of the kind #1426 removed.

Adding the token in slice 1 to make the claim true is not the alternative:
`FULL_PAIRING_SCOPE` is `PAIRING_SCOPES.join(' ')`
(`environment-security.ts`) and is issued to **three** populations — every
grant that omits an explicit scope, every credential migrated from a
pre-scoping registry, and the Station operator bootstrap credential — so
widening the set would silently grant the new scope to all three *and* make
that string unparseable by every peer that predates it. The fix is a slice-2
decoupling, specified in that slice below.

So slice 1 ships the flag's **declaration** on `StationCapabilityFlags`
(the contract groundwork a coordinated change needs) and leaves
`STATION_CAPABILITY_FLAGS` unchanged. The two halves flip together in slice
2, enforced by an if-and-only-if coupling test
(`station-capability-flags.test.ts`) that fails if the flag is advertised
without the token *or* the token lands without the flag. The §5.2
"handshake discloses nothing about participation" guard is written now,
ahead of the flag, so the flag cannot land without it.

**#1430's inventory-cache finding is honoured, not blocked on.** The slice
reads `listLaunchableModelInventory()` — compute-on-demand with a bounded
stale snapshot — never `getCachedLaunchableModelInventory()`, which is the
route-populated snapshot #1430 correctly calls nondeterministic. A peer's
manifest is therefore not a function of whether that peer's operator opened
the Connections page. #1430 remains a dependency of any *tool-surface* claim,
which is why this slice makes none.

**Slice 2 — `inference:invoke` scope + the serving route. SHIPPED.** The fifth scope, the
`inference` preset, the route-table entry, and B's authenticated completion
endpoint (§10 OQ-1). Bounded request size and concurrency; no tools, no
filesystem, no session creation. **Specified for streaming from day one** even
though v1 does not consume it (§10 OQ-8) — retrofitting streaming onto a serve
route is expensive, and this is the change that makes enabling interactive chat
later a client change. Also carries the OQ-2 leaf override raising
`GET /api/connections/model-inventory` to `inference:invoke`, since that
narrowing is only coherent once the scope exists. Includes the mixed-version
mint guard (§3.3) and a pinned regression test that an older peer's grant is
refused rather than mangled, plus the §12 test pinning that an SSH-forwarded
request with no `Authorization` header is refused by `/api/inference/**`.

*Scope-vocabulary shape — plan of record, from the slice-1 review.* Adding
the token is not just an append to `PAIRING_SCOPES`, because
`FULL_PAIRING_SCOPE` is derived from that array and is emitted to three
populations (unscoped grants, migrated pre-scoping credentials, the operator
bootstrap credential). Appending would grant fleet invocation to all three
by default and hand every older peer a scope string its `parsePairingScope`
rejects outright. So slice 2:

1. **Decouples the default grant from the vocabulary.** Replace the derived
   `FULL_PAIRING_SCOPE` with an explicit, curated four-token constant, and
   rename it to say what it actually is — e.g. `DEFAULT_GRANT_PAIRING_SCOPE`
   — since "full" stops being true the moment the vocabulary grows past it.
   Unscoped, migrated, and bootstrap grants keep emitting the **identical
   historical four-token string**, so the older-peer break disappears
   entirely.
2. **Adds `inference:invoke` to the vocabulary and an `inference` preset,
   and nothing else.** Invoking becomes operator-opt-in on the granting
   side, symmetric with contributing being operator-opt-in on the serving
   side. No existing credential silently gains it.
3. **Updates `describeDeviceScope` in `packages/connect`** so a legacy
   full-scope device does not render "Full access" for a scope that is no
   longer the full vocabulary — the label must describe the tokens held, not
   the constant's old name.
4. Treats the existing pin at `environment-security.test.ts:252-256`
   (which asserts `FULL_PAIRING_SCOPE` equals the joined vocabulary) as the
   **deliberate forcing function**: it is supposed to fail on this change,
   and editing it is the moment the decoupling gets reviewed rather than
   absorbed.

Slice 2 also owned two questions slice 1 surfaced and could not answer, both
now decided in place: the contribution opt-in keeps `orchestration:operate`
as a disclosed gap rather than gaining a narrower write path (§5.4), and a
peer-rendered manifest bounds another Station's diagnostic text rather than
carrying it verbatim or dropping it (§4.2).

*As shipped, with the deltas from the plan above.* The four scope-work points
landed as written: `DEFAULT_GRANT_PAIRING_SCOPE` is an explicit four-token
constant (no deprecated alias — every call site was renamed, since none
needed staging), `inference:invoke` joined `PAIRING_SCOPES` and a new
`inference` preset only, `STATION_CAPABILITY_FLAGS.fleetInference` flipped on
in the same change the coupling test forces, and `describeDeviceScope` now
renders the four-token grant as "Standard + device management" with "Full
access" reserved for a grant carrying every token. The forcing-function pin
was edited rather than deleted, into four pins: the default grant's literal
bytes, that it is not the vocabulary and withholds the new token, the
`inference` preset's exact contents, and an old-peer parse simulated against
the four-token vocabulary.

Four things the plan did not name that the implementation required:

- **Historical implementation note, superseded by station#2051.** Fleet
  inference formerly opted out of a generic loopback compatibility floor. All
  protected families now require a credential, while fleet inference adds its
  narrower `inference:invoke` scope. Exercising it locally requires an
  inference-preset grant.
- **`GET /api/inference/manifest` ships here, not in slice 3.** §4.2 names an
  authenticated fleet route and slice 1 explicitly deferred "the
  authenticated surface" to this slice; without it a consumer has no way to
  learn what to ask for, and the completion route's refusals reference a
  manifest that would not exist. It serves the slice-1 projection bounded for
  the machine boundary.
- **The `inference` preset is not offered in the pairing UI.** `DevicePairingPanel`
  deliberately offers only `standard`/`read-only` (it already withholds
  `delegation` on the same reasoning), and adding a fleet preset to a
  general-purpose device-pairing chooser before slice 3 has a consumer would
  be a surface with no journey. Minting one goes through
  `POST /api/pairing/offers` with an explicit scope. Revisit with slice 3/4's
  fleet surfaces.
- **The OQ-2 raise had to change the PAYLOAD, not only the tier** — found by
  the round-1 security review, which is the finding this slice most needed.
  The first cut raised `GET /api/connections/model-inventory` to
  `inference:invoke` and left it returning the full launchable inventory,
  which hands the complete enumeration to exactly the fleet-peer class the
  completion route's `model-not-contributed` parity is built to keep from
  learning what this Station withheld. Half of §5.3 shipped is worse than
  none of it: the scope raise alone *creates* the reader it was meant to
  restrict. The leaf now serves the contributed-subset projection, the same
  body as `GET /api/inference/manifest`, and the SDK's two functions were
  renamed (`fetchContributedModelManifest` /
  `useContributedModelManifestQuery`) so the payload change cannot land as a
  silent re-type. station#2051 then removed the §2.1 tunnel residue entirely:
  a credential-less SSH-forwarded reader receives `401 authentication_required`.

The mixed-version mint guard reduced to the decoupling itself, and the reason
is worth recording because the plan assumed otherwise: **no requester-supplied
scope path exists in this codebase.** `createOffer` is called from exactly two
places — `POST /api/pairing/offers` (host-side, caller-supplied scope) and
`requestAccess` (which never populates one) — and neither
`requestCurrentStationAccess` nor any CLI/SDK path lets a client ask a remote
Station for a scope. So a Station cannot today mint a grant *against* a peer
at all, and the mixed-version failure the flag guards is reachable only in the
direction the decoupling closes: an older peer parsing a default grant. When
slice 3+ adds a requester-supplied scope, gating it on the peer's
`fleetInference` handshake flag is the remaining half, and the flag is now
honestly advertised for it to read.

**Slice 3 — Fleet candidates in Dispatch + the routing-receipt envelope. SHIPPED.**
A's side: fetch peer manifests, admit candidates at or above `minimumEvidence`,
route, and emit a `station.fleet-routing-receipt/v1` envelope embedding the
verbatim `DispatchReceipt` plus `environmentId`, evidence level, considered-set
exclusions, constraints, and stream capability (§3.4 — Dispatch itself has no
`environmentId` and no exclusions channel at any version). Receipts are
hash-chained and **local to the deciding Station** (§10 OQ-3/OQ-4). B's side:
serve-side receipt. This is the first slice where the headline user outcome
works end to end. Scoped to non-interactive work per §10 OQ-8. **Depends on
#1431**: routing on a peer's evidence grade is only honest once that grade
re-resolves rather than staying frozen at model construction (§2.3).

**Slice 4 — Receipts become readable, degraded states become visible.** A
bounded receipt read route, a monitoring surface, and the §4.5 diagnostic codes
rendered wherever fleet models appear. Ship this *with* slice 3, not after: a
feature whose entire differentiator is the receipt should not ship a release
where the receipt is unreadable. External wording throughout is **"receipted,"
never "signed"** (§10 OQ-3).

*As shipped (slices 3 and 4 landed together, as this slice requires).* Seven
decisions the plan did not name that the implementation forced, recorded
because later slices build on them:

- **A peer-attested candidate is capped at `declared`, in code, by a named
  function.** `capFleetEvidenceLevel` (`packages/contracts/src/fleet-routing-receipt.ts`)
  refuses to let a peer's claim reach `confirmed` however healthy that peer
  says it is — `confirmed` in this codebase means a bounded completion was
  *observed*, and slice 3 observes nothing on the peer. The pre-cap mapping is
  deliberately written as if it could reach `confirmed` so the cap reads as a
  decision rather than as a lookup table that merely never emits the top
  value. Slice 5's `consumer-verified` smoke is what earns the raise, and
  raising it means deleting that function in daylight.
- **The peer's raw claim is stored beside the level routing used.**
  `PeerAttestedClaim` carries the manifest's own `availability`/`freshness`/
  `observedAt` plus a digest of the record it came from. Folding the two is
  exactly how "the peer says this is available" becomes "we confirmed it".
- **`FLEET_PEER_ATTESTED_EVIDENCE_LABEL` is a contract constant, and both
  surfaces render it from the stored receipt** rather than composing their own
  sentence. Two surfaces writing their own honesty wording is two places for
  it to drift; a stored label also means a receipt read months later still
  renders the claim actually made about it.
- **The fleet candidate SET is fixed at model construction; the GRADE is
  re-resolved every TTL window.** Dispatch's runtime registry takes `models`
  once, so a contribution that appears afterwards cannot become routable
  mid-life — it is reported as `not-in-resolved-set` ("routable on the next
  agent rebuild") rather than silently ignored, and one that disappears is
  reported as `capability-withdrawn` rather than vanishing from the surface.
  Re-grading per window is #1431's requirement applied to the fleet half.
- **A failure code is a claim, and `no-eligible-candidates` claims an
  exclusion.** It asserts policy removed everything, so it is emittable only
  alongside a non-empty exclusion list; §4.5's promise that the list "says why
  for each one" is otherwise a pointer at nothing. Candidates that were
  dispatched and failed are `attempts-failed` — the opposite fact, and the one
  that tells an operator to look at the model rather than at routing policy.
  A non-succeeded receipt that can support neither claim reports
  `unexplained-no-attempt` rather than borrowing a code that would.
  `FLEET_ROUTING_FAILURE_CODES` carries the semantics as data and is the
  closed-set tripwire for the union (station#1556).
- **`fell-back-to-local` is a receipt state, not a log line.** A turn that
  SUCCEEDS locally after a fleet attempt failed is the §4.5 case most likely
  to be reported as a plain success; `deriveFleetRoutingFailure` names it, and
  both surfaces print it.
- **The receipt read route is NOT under `/api/inference/**`.** That family is
  peer-facing and requires `inference:invoke`; a receipt route there would be
  unreadable by this Station's ordinary UI credential while being reachable by the peers the receipts are
  *about*. It lives at `GET /monitoring/fleet-routing-receipts`, with an
  explicit `orchestration:operate` leaf override — the receipts name other
  Stations' ids, labels, and model ids, and the peer list they derive from
  sits at `access:manage`, so inheriting the monitoring family's
  `orchestration:read` would have been a leaf quietly undercutting a higher
  gate (the `/api/environments/ssh/sessions` precedent).
- **The serve-side receipt identifies its caller by fingerprint.** B's own
  record (`station.fleet-serve-receipt/v1`) stores `SHA-256(credential)` and a
  prompt digest — never the credential, never the prompt, never the
  completion. Nothing in the request carries an environment id, and inventing
  one from the connection would assert an identity B did not verify.

*Security-review round (the findings that changed the design, not just the
code).* Six were structural enough to record here:

- **A routing snapshot must be keyed by `planDigest`, not by "most recent".**
  One built Dispatch model serves every invocation of its agent, `plan()` runs
  per invocation, and `onReceipt` fires when that invocation finishes — with
  nothing ordering them. Two turns straddling the evidence TTL resolve
  different candidate sets, and last-write-wins paired one turn's verbatim
  `DispatchReceipt` with another turn's candidates and exclusions: an
  internally consistent, individually plausible receipt that was false about
  which machines were considered. `executionPlanDigest` (exported by Dispatch)
  over the same `{...plan, request}` the engine dispatches gives the join the
  engine's own identity for the decision.
- **A failed fleet resolution is a receipted state, not an absence.** The
  re-grade failure path dropped every fleet candidate and skipped the envelope
  entirely — §4.5's first banned behavior, occurring inside the module whose
  docblock claims the shape is unrepresentable. It now emits a named
  `resolution-failed` exclusion per known peer model and still writes an
  envelope; a receipt that genuinely cannot be written is logged at error with
  its own counter. `resolution-failed` is deliberately distinct from
  `peer-unreachable`: one says a peer did not answer, the other says this
  Station could not ask.
- **The exclusion vocabulary gained an exhaustiveness tripwire.**
  `FLEET_ROUTING_EXCLUSION_CODES` is a runtime `Record` keyed by the union
  (slice 2's refusal-status map, applied to a vocabulary rather than a status),
  so a new code cannot land without someone classifying it. It was added
  *before* the code that needed a new member, which is what forced that
  addition to be a decision.
- **Withdrawal is decided before policy gets a say.** A peer that had stopped
  contributing rendered `admitted: true` beside its own `capability-withdrawn`
  exclusion, because `minimumEvidence` defaults to `unavailable` and an
  unavailable grade clears that bar. Withdrawn candidates are now
  `admitted: false` AND withheld from the router, so Dispatch cannot spend a
  budgeted attempt earning a `model-not-contributed` refusal.
- **Tail truncation needed a head anchor.** The chain catches an edited record
  (digest) and a deleted middle record (broken link), but not records dropped
  from the END — every survivor still verifies, so a trimmed log read `intact`.
  Both logs now keep a `.anchor.json` beside them (newest `receiptId` plus
  record count, rewritten atomically on append); truncation reads `broken`, and
  a missing anchor reads `unknown` rather than `intact`.
- **The receipt leaves sit at `access:manage`, not `orchestration:operate`.**
  They name other Stations — peer ids, labels, contributed models, and the
  fingerprints of peers that called in — and their source, the outbound peer
  registry, is gated at `access:manage`. At the lower tier a `standard` or
  `delegation` device could read fleet topology here while being refused it at
  the source, which makes the higher gate decorative.

*Round-two delta (three regressions the fixes themselves introduced, plus the
standing residuals).* Recorded because two of the three were introduced BY the
security round, which is its own lesson about fix-shaped defects:

- **A plan digest is pure content, so identical concurrent turns collide by
  design.** `executionPlanDigest` hashes the canonicalized plan plus the
  request digest — no nonce, no timestamp — so two turns with the same agent,
  prompt and grades share one digest deterministically. That is the normal
  shape of a scheduled job, a retry, and a fan-out. Deleting the snapshot on
  first read therefore gave the first receipt its envelope and the second
  `routing-snapshot-lost` with none: for that case, worse than the
  last-write-wins code the digest map replaced. Snapshots are now retained and
  reclaimed only by the bounded FIFO eviction, and a colliding digest keeps the
  FIRST snapshot (a colliding plan is by definition the same plan).
- **Read the anchor BEFORE the log.** The two reads race a concurrent append.
  Log-first makes the anchor the fresher of the two, so a healthy log reads as
  "truncated" on both surfaces — a false tamper alarm, which is exactly what
  the module's own docblock says trains readers to ignore verdicts.
  Anchor-first skews the only way that stays honest: the log can only be
  AHEAD, and `totalRecords >= recordCount` never trips the truncation branch.
- **A gate that cannot scan must not report clean.** `git grep` exits 1 for "no
  matches" and 128 for "could not run" (git built without PCRE, bad pathspec,
  unreadable index). Catching both and returning `[]` was a fail-open in the
  gate that exists *because* a scanner silently skipped a file. Exit 1 is
  clean; anything else fails the gate with git's own stderr surfaced.

*Post-hoc correction from the slice 5.5 review (finding 2), recorded here
because it is a slice 3 defect rather than a 5.5 one.* `fell-back-to-local`
was **unreachable in production** from the day it shipped.
`FleetInferenceRoutingError` extended plain `Error` with a `refusalCode` and
neither `code` nor `retryable`, and Dispatch's `normalizeInvocationError`
honors only a real `ModelInvocationError` or a duck-typed object carrying a
`code` from its closed set AND a boolean `retryable`. Every fleet refusal
therefore normalized to `RUNTIME_FAILURE`/non-retryable, and the engine's
`if (!typed.retryable && !plan.policy?.retryRuntimeFailures) break;` stopped
the loop before any local candidate was attempted. The state existed, the
surfaces rendered it, and nothing could produce it. It is not a 0.5.0
regression — 0.2.0's catch reaches the same place by a shorter path.

The lesson is about the coverage, not the mapping: the only tests of this
state fed `onReceipt` a hand-built `attempts` array, so they asserted a
receipt shape the engine could not emit. A fixture that constructs the very
artifact under test can only ever confirm the fold, never the reachability.
The fix makes the error extend `ModelInvocationError` with a per-refusal-code
projection onto Relay's vocabulary and `retryable: true` throughout —
"retryable" in the engine means "try the NEXT candidate", which is always
right after one peer declines — and the coverage is now an end-to-end failover
through the real engine plus a control asserting that a non-legible error
still halts the loop, so a revert to a plain `Error` subclass goes red.

**Standing residuals, disclosed rather than closed:**

- **A peer's own refusal code does not reach the Dispatch attempt row.** The
  receipt records the projected Relay code (`PROVIDER_UNAVAILABLE`,
  `RATE_LIMITED`, …), because `errorCode` is Dispatch's field and it copies
  `typed.code`. So `fell-back-to-local`'s message names the projection rather
  than "the peer said `model-not-contributed`". Closing it means threading the
  attempt's refusal code back from the fleet model into the routing snapshot,
  which is a channel this branch did not open; filed rather than expanded.
- **The head anchor is a tripwire, not tamperproofing.** An attacker who can
  edit the log can edit the anchor; a coordinated edit of both still verifies
  `intact`. Its job is to make truncation take two consistent edits instead of
  one `head -n -1`, and to make a REMOVED anchor read `unknown`. Real
  tamper-evidence needs signing (§10 OQ-3), which does not exist anywhere in
  the building-block layer.
- **More than 32 plans awaiting a receipt evicts the oldest**, which loses that
  turn's envelope. Bounded and loud (`fleetRoutingReceiptFailures{reason:
  'snapshot-evicted'}` plus an error naming the digest), never silent.
- **The repo-wide control-character scan will trip on any future tracked
  artifact that captures raw terminal output** — a recorded VHS/asciinema
  cast, a saved ANSI transcript. That is the gate working as designed; the
  disposition is an extension entry in its `BINARY_EXCLUDES`, decided at the
  time, not a loosening of the pattern.
- **L-3 replica divergence** is carried on the dispatch 0.5.0 conformance
  tripwire: if a future engine admits a candidate this Station's replica of the
  eligibility predicate considered excluded, the envelope renders
  `selection: null` on a turn that demonstrably succeeded.
- **Windows nit:** the anchor's atomic write fsyncs a read handle after
  `writeFileSync`, which is portable but not the tightest ordering; the rename
  is what provides atomicity either way.

**Deviation against #1410, recorded explicitly.** `TurnProvenanceRoutingReceiptRef`
carried the claim "Station has no per-turn routing receipt today". That is no
longer true — a fleet-routed turn has one, with a `receiptId` of exactly that
ref's shape. What is still missing is the **join**: a `DispatchReceipt` carries
no session or turn identity at any version (§3.4), so nothing links an envelope
to its turn except position in time, and #1410 AC4 requires these refs to be
exact rather than positional. A positional join was considered and rejected —
manufacturing provenance from timestamps is the failure mode this envelope
exists to prevent. So the ref stays an admitted gap with its reason narrowed
from "no receipt exists" to "no exact join exists", it applies only to
fleet-routed turns, and `appendReceipt` now returns the sealed envelope so
whoever closes the join has the `receiptId` to work with. Closing it needs
either an identity carried through Dispatch (a sibling-repo change) or a
Station-side correlation stamped at plan time.

**Slice 5 — Verification probes + tooling conformance.** `consumer-verified`
smoke through the real fleet path, **metered against budget and recorded in the
receipt like any other attempt** (§10 OQ-6); conduit `probeHostConformance`
extended to host tooling (§4.3), pending Conduit-owner confirmation; the
`reference-resolved` vs `probe-verified` distinction enforced at the type level
so the two cannot be conflated by a later edit. This is where tool contribution
first becomes possible (§10 OQ-5 keeps it out of v1), so it also depends on
#1430 making tool-surface data real.

*As shipped — the consumer-verified half only; the tooling-conformance half is
BLOCKED and is recorded as such rather than approximated.*

- **`probe-verified` is a fourth provenance, not a raised cap.**
  `capFleetEvidenceLevel` was NOT deleted (slice 4 said raising a peer means
  deleting it in daylight, and that turned out to be the wrong frame). It
  still binds every UNVERIFIED claim at `declared`, permanently. What a fresh
  passing probe changes is that the claim is no longer unverified.
  `fleetEvidenceLevelWithProbe` is the only path to `confirmed`, and it
  requires an observation that actually passed and has not expired —
  `provenance: 'probe-verified'` cannot be asserted into existence.
- **Three states, kept distinguishable on BOTH surfaces.** probe-verified,
  peer-attested, and probed-then-expired. The third is the one that would
  have been dropped: without its own clause an expired verification renders
  identically to a never-probed candidate, which is the silent degradation
  §4.5 bans wearing a different hat. Both surfaces render
  `describeConsumerProbe` from the contract, for the reason slice 4 recorded
  about `FLEET_PEER_ATTESTED_EVIDENCE_LABEL`.
- **A fresh FAILURE excludes; a stale failure does not.** `probe-failed`
  (declared in slice 3, unreachable until now) withholds the candidate from
  the router AND names it — the peer still says the model is fine, so
  dropping it silently would read as a withdrawal. But a failure past its own
  window is no more evidence about now than an expired pass, and excluding on
  it would be the mirror-image over-claim.
- **Never on a hot path, and the cache lifetime is the reason it works.**
  `observe()` is synchronous and answers only from cache; a cold entry
  schedules a detached refresh and returns the pre-probe answer, so the first
  fleet turn costs nothing. The probe cache is held for the life of the
  runtime — `fleetRouting()` rebuilds `FleetCandidateService` per resolution
  so a revoked credential takes effect immediately, and a per-call probe cache
  would have been empty on every look: an endless stream of completions that
  never upgraded a single candidate.
- **Opt-in, default off** (Settings → Feature previews → Fleet consumer probes). A probe
  spends a real completion on hardware the operator does not own; a Station
  that started doing that on upgrade would be making that decision for them.
  §10 OQ-6's "the consumer's own smoke counts against budget" only means
  something if turning it on is a choice. With the preview off the slice is
  inert.
- **The probe prompt is fixed and content-free**, never derived from the turn
  being routed: a probe carrying real user content would leak it to a machine
  the router had not yet decided to trust — the exact ordering mistake a
  verification step must not make. Nothing from the completion is recorded,
  not even a digest; the observation carries that a turn completed, how long
  it took, and which provider model the peer echoed, so a substitution is
  visible.

**BLOCKED — tooling conformance via conduit `probeHostConformance`.** §12 asked
Conduit's owner to confirm the contract fits. Read against the published 0.6.0
contract, it does not, and the gap is structural rather than a version away:

- `probeHostConformance(adapter: AgentHostAdapter)` takes a LOCAL, in-process
  adapter object — lifecycle handlers plus asset installation. There is no
  remote subject, no transport, and no model anywhere in the signature.
- Its evidence is tagged `evidenceScope: 'adapter-contract' | 'host-bound'`,
  and Conduit's own contract says adapter-contract rows "prove the projection
  and redaction contract, not a live host".
- So probing a PEER's tooling would mean fabricating an `AgentHostAdapter` to
  stand in for a remote machine and recording adapter-contract evidence about
  it. That is manufacturing a probe result for a subject nobody probed —
  precisely what §4.1's last sentence forbids ("no probe result may ever be
  manufactured for it") and precisely the outcome §4.1 calls the worst
  possible one.

Disposition: do NOT bend conduit's contract to fit. Tooling conformance needs
either its own probe contract or an upstream conduit capability whose subject
is a remote host, and it is out of v1 either way (§10 OQ-5 keeps tool
contribution out of v1, so nothing consumes it yet). The conduit bump was not
performed: Station's only conduit use is the agent-host hook seam, and bumping
it to reach a function that cannot serve this purpose would be churn.

**Slice 5.5 — Dispatch 0.2.0 → 0.5.0 (§10 OQ-9). SHIPPED.** Its own change and
verification unlocked the bridge functions and
`AuthorizationLedger`. Carries the #1426 conformance tripwire hardenings
**R3-a/b/c**; the tripwire itself is already armed and cross-checks the real
`dispatch()` engine's admissions against the exclusion log with no hardcoded
oracle, so a behavior change in the bump surfaces as a failing test rather than
as silently different routing. Can be pulled earlier — it is independent of
everything above — but must not be bundled with a feature slice.

*As shipped. "No new behavior" was wrong, and the tripwire is what proved it.*

- **The bump is NOT behavior-preserving.** 0.5.0's `eligible()` gained a
  second axis: `CapabilityEvidence.structuredToolsFidelity`, with the engine
  REFUSING any candidate whose capability list and fidelity disagree. An
  absent field reads as `'unavailable'`, so every Station candidate whose
  model catalog genuinely reported native tool calling (#1430's derivation)
  became ineligible for **every** plan, including one with no policy at all.
  Silent: no throw, no warning, a receipt reading `no-eligible-candidates`,
  and Station's own exclusion log reporting the candidate as admitted.
- **Only the R3-a hardening caught it.** The twelve pre-existing tripwire
  cases all stay GREEN at 0.5.0 — verified by running them alone — because
  none of them ever built a candidate CARRYING `structured-tools`. This is the
  concrete answer to "was the hardening worth it": without R3-a the bump would
  have shipped a silent routing regression that no test in the repo could see.
- **`structuredToolsFidelity` is derived FROM the capability list**, not
  re-derived from `(level, toolSurface)`. Two functions reading the same
  inputs can drift; a function reading the other's output cannot, and 0.5.0
  refuses exactly the disagreement drift would produce. `'native'` is the
  honest value: the only producer of the capability is a provider catalog
  reporting native tool calling, Station never prompt-scaffolds tools, and
  `'prompted'` would collide with Dispatch's implicit `'native'` floor and
  exclude every candidate under a `structured-tools` policy.
- **One replica, not two.** `admissionOf` replaced `isAdmitted` as the single
  mirror of `eligible()`; `logExcludedCandidates` had been keeping its own
  second copy, which would have needed the fidelity clauses added twice to
  stay honest.
- **`minimumStructuredToolsFidelity` is declared and validated.** The whole
  `policy` object is handed to the engine verbatim, so an unvalidated typo
  reached `eligible()` and excluded every candidate with nothing naming the
  cause.
- **`admissionOf` stays a HAND-MAINTAINED replica, and the tripwire is the
  only thing that catches drift.** That is the actual lesson of this slice,
  and it is a standing instruction rather than an observation: **any future
  Dispatch bump must widen the tripwire BEFORE the bump, not after.** Arming
  R3-a first is the only reason the fidelity regression was visible at all —
  a hardening written afterwards would have been written against the new
  behavior and would have codified it.
- **`'native'` is catalog-attested, not conformance-verified.** Station
  derives it from a provider catalog reporting native tool calling; nothing
  observes a tool call. Revisit if Relay ever ties a `structured-tools`
  fidelity conformance notion to the same word — at that point the two senses
  of `native` would have to be reconciled rather than assumed equal.
- **Dispatch 0.5.0 still exposes NO eligibility or exclusion output.**
  `dispatch`/`dispatchBatch` return only `DispatchOutcome`, and `attempts[]`
  still records launched candidates only. The exclusion log stays a replica,
  and the tripwire stays the only thing holding it honest. `receiptDelivery
  FailureMode` (new, defaults `fail-closed`) and `AuthorizationLedger` are
  now available and deliberately unused — adopting either is a decision, not
  a consequence of the bump.

**Slice 6 — Datum + Bearing composition.** `bindDatumResolvedRef` for the
hosted-contribution reference branch (§4.1); `capabilityEvidenceFromBearing` /
`withCapabilityEvidence` so candidate evidence comes from a real catalog with
provenance, freshness, and uncertainty instead of Station's constants;
`CapabilityRoleResult`'s `exclusions`/`posture`/`uncertainty` vocabulary
replacing Station's hand-rolled exclusion records in the envelope. Adds two
declared Station dependencies. **Does not close the attestation gap** — Bearing
is content-addressed, not signed (§4.3). Each half is plausibly its own arc;
sequence separately if the surface is large.

*Assessed against the published 0.7.0 / 0.2.0 contracts and STOPPED, not
attempted. The composition points exist; the SEAM between them does not.*

- **`bindDatumResolvedRef` cannot serve the consuming side at all, and the
  reason is §4.1's own boundary.** It maps a Datum `ResolvedRef` —
  `{ provider, kind, baseUrl?, model, auth: AuthStatus, apiKeySet }`. Datum
  produces one by reading the LOCAL config plus local env/keychain/op. So a
  CONSUMING Station calling `resolveRef` for a peer's hosted contribution
  would be answering "is *my* key for that vendor set", not the peer's. §4.1
  is explicit that the reference branch asks whether the credential resolves
  **on the peer**; binding a locally-resolved ref would produce exactly the
  outcome §4.1 names as the worst possible one — a compliance system whose
  green checkmarks are assertions about third parties.
- **The serving side could resolve its own references, but has nowhere to put
  the answer.** `station.fleet-contribution/v1` carries no auth reference, no
  base URL, and no availability boolean for a hosted model — deliberately
  (§4.2, and the contract's own docblock). Today a non-local contribution is
  carried with `locality: 'remote'` plus a `contribution-not-local`
  diagnostic, and the consumer excludes it `reference-unresolvable`. Making
  the hosted branch real therefore starts with a peer-facing **wire version
  decision**, which §4.2 records as deferred, not with a package integration.
- **The Bearing bridge needs a catalog nothing produces.** Note the name
  first, because it is easy to grep for the wrong thing:
  `capabilityEvidenceFromBearing` is an export of **`@kontourai/dispatch`**
  (`dispatch/bearing`), *not* of `@kontourai/bearing` — no such symbol
  appears in Bearing's own `.d.ts`. What Bearing exports is the pipeline that
  has to run first: `compileCatalog(observations) -> CatalogSnapshot`, then
  `rankCatalog` producing the `RankedCandidate | RankedCandidateV2` that
  Dispatch's bridge consumes. Datum's `loadCapabilityCatalog` needs a
  `CapabilityCatalogConfig` naming a `remoteUrl` or `localPath`. Station has
  none of it — no Datum config file, no catalog source, and no producer of a
  single `CapabilityObservation`; repo-wide there is still not one
  non-lockfile import of either package. Standing up that pipeline is the arc
  this slice's own last sentence anticipates, not a composition step.
- **`source: 'datum'` therefore still never emits.** It stays declared and
  unreachable, exactly as `probe-failed` was before slice 5 — and for the
  same reason it was right to leave it declared: the vocabulary records where
  a second producer will attach.

Disposition: slice 6 is not blocked by a missing published contract — both
functions exist and are usable. It is blocked by a missing SEAM (a manifest
field that would be a peer-facing version decision) and a missing PRODUCER (a
Bearing catalog). Sequence it as its own arc, hosted-reference half first,
since that half also has to carry the wire change.

**Slice 7 — Admission-policy seam.** The named
`(manifest, evidence, policy) → decision` function with v1's fixed personal
policy, plus the signed-policy shape recorded but unimplemented (§4.6). Deferred
behind everything else because nothing consumes it until there is a community.

**Sequencing note.** Slices 0–4 depend on nothing outside Station beyond #1123's
shipped peer credential and the two slice-0 follow-ups (#1430 into slice 1,
#1431 into slice 3). Slice 5 depends on a Conduit conversation and a conduit
bump, 5.5 on a Dispatch bump, slice 6 on two package integrations, slice 7 on
#1392. If the arc has to stop somewhere, **stopping after slice 4 leaves a
coherent, honest, shipped product** — the headline outcome works, the receipt is
readable, and every gap is named in the UI rather than hidden.

## 12. UNVERIFIED

Recording direction does not verify these. Each is a gap this doc knows it has;
several are now scheduled into a slice rather than merely disclosed.

- **The `DispatchReceipt` / Datum / Bearing / Relay / Conduit shapes cited in
  §3.4, §4.1, and §4.3 must be checked against Station's pins.** Dispatch and
  Relay are now pinned at the cited 0.5.0 and 0.6.0 contracts; Datum/Bearing are
  transitive and Conduit remains at 0.2.1.
- ~~**Whether conduit's `probeHostConformance` contract fits host-tooling
  probing.**~~ **RESOLVED — it does not** (slice 5). Read against the
  published 0.6.0 contract, the signature takes a local in-process
  `AgentHostAdapter` and its evidence is scoped `adapter-contract`, which
  Conduit itself says does not prove a live host. Probing a peer would mean
  manufacturing a probe result for a subject nobody probed. Recorded in §11
  slice 5; the conduit bump was not performed.
- ~~**Whether the Dispatch 0.2.0 → 0.5.0 bump is behavior-preserving for
  Station's existing single-host path.**~~ **RESOLVED — it is NOT** (slice
  5.5). `eligible()` gained a `structuredToolsFidelity` consistency clause
  that silently made every `structured-tools`-capable Station candidate
  ineligible for every plan. Caught by the tripwire's R3-a hardening and
  fixed; the twelve pre-existing tripwire cases would all have stayed green.
  The concern below is the one this outcome vindicates. Partly mitigated, not
  closed, by the
  #1426 conformance tripwire armed for that PR (§11 slice 5.5) — a tripwire
  catches an admissions divergence it happens to exercise, which is not the same
  as proving the bump inert.
- **Serving-side performance and concurrency.** No measurement of what happens
  when a peer's local model is already busy with the peer's own work. Queueing,
  admission control, and preemption are unaddressed and could change the route
  contract in slice 2. Worth a spike before slice 2 rather than a redesign
  during it.
- ~~**The residual SSH loopback gap's exact reach for the new route.**~~
  **Resolved in slice 2, and the reading was wrong in the safe direction.**
  §2.1 asserted the inference route is safe "because it always requires a
  presented credential" — but nothing made that true: the route would have
  inherited `runtime-http.ts`'s unconditional pass for a credential-less
  loopback caller like every other family, so an SSH-forwarded request with no
  `Authorization` header would have reached it. Requiring a presented
  credential is now a mechanism (`PAIRING_CREDENTIAL_REQUIRED_PREFIXES`,
  checked before the bypass) rather than a claim, and it is pinned by
  execution: `runtime-auth-boundary.test.ts` refuses IPv4, IPv6, and
  IPv4-mapped loopback peers on every inference route with a
  `credential_required_route` audit line, refuses a malformed
  `Authorization` header (which also resolves to "no credential"), refuses a
  default-grant credential for lacking the scope, and asserts as a control
  that the pre-existing surface keeps its floor.
- **ops#131 W6** (named in #1398's first comment as carrying the full
  requirements and acceptance criteria) was not readable from this session. If
  it contains ACs beyond #1398's issue text, this doc has not been reconciled
  against them.
- ~~**Whether any shipped consumer reads `GET /api/connections/model-inventory`
  with only `orchestration:read`.**~~ **Enumerated in slice 2 before the leaf
  override landed.** The measured in-repo blast radius is one client shape
  with zero call sites: the SDK's `fetchLaunchableModelInventory()` and
  `useLaunchableModelInventoryQuery()`
  (`packages/sdk/src/query-domains/workspaceConnections.ts`). No UI view, no
  CLI command, no `station-control` MCP tool, no Playwright spec, no plugin or
  example calls this endpoint; the `isModelInventoryConnection` hits in
  `ConnectionsHub.tsx` are a name collision over the `/api/connections` list,
  not this route. Station's own UI reaches it over loopback presenting no
  credential and never consults the scope table. The residual exposure is
  therefore an **out-of-repo SDK embedder** holding a
  `read-only`/`standard`/`delegation` credential, which now receives
  `403 insufficient_scope` — and which also sees a changed payload, since the
  leaf serves the contributed subset rather than the full inventory. Both are
  recorded for them in `docs/reference/api.md`, and the SDK functions were
  renamed (`fetchContributedModelManifest` /
  `useContributedModelManifestQuery`) so the payload change surfaces as a
  compile error rather than a runtime surprise. In-process readers are
  unaffected — the conversation-stats lookup and the manifest projection call
  the service directly.
- ~~**Ingestion is not stream-bounded.**~~ **Closed in the review's final
  round, using a tool the repo already had.** The gap was real —
  `maxRequestBytes` bounded parsing, not ingestion, so a caller that lied
  about its `Content-Length` was buffered in full before the refusal fired.
  It is closed by `readRequestText`
  (`src-server/routes/schemas/schema-validation.ts`), which refuses an
  oversized declared length before reading and otherwise cancels the reader
  the moment observed bytes exceed the cap. Worth recording as a process
  note: the "recorded follow-up" disposition was reached without checking
  whether the capability existed, and it did — `PUT /config/app` had ridden
  it since it was written, on both the node-server and harness paths. The
  disclosure was honest and the search was not thorough.
- **The old-peer parse simulation is a restatement, not the released
  parser.** `environment-security.test.ts`'s legacy-vocabulary probe
  re-implements `parsePairingScope`'s algorithm from the current source with
  the four-token set. It proves the default-grant string is parseable under
  the old vocabulary; it cannot catch a divergence in the v1 parser's other
  rules (length ceiling, duplicate handling, whitespace), because those are
  re-derived rather than copied. Pinning a byte-copy of the v1 parser as a
  provenance-noted fixture is the stronger form and is a recorded follow-up.
- **A provider that ignores its abort signal leaks its concurrency slot.**
  Stated wrong in the first draft of this entry, in the direction that
  flattered the implementation: it said "the slot accounting is fixed by the
  `finally`, but the work is not killed." **The `finally` does not run.** The
  deadline is cooperative — it fires the `AbortSignal` the provider was
  handed; it does not cancel the async generator. A provider that observes
  the signal settles, the `for await` exits, `finally` runs, and the slot is
  freed. A provider that accepts the signal and never observes it never
  settles, so the `for await` stays suspended, `finally` never runs, and
  **the slot is not freed** — which is precisely the leak
  `completionDeadlineMs` was added to prevent, relocated behind a
  worse-behaved adapter. Two such connections pin the cap permanently.
  Reachability is low and bounded: every provider in
  `src-server/providers/llm/**` passes the signal to its SDK, so this needs
  an operator to install a plugin-supplied provider that ignores abort AND
  mark its connection as contributed. Closing it means racing the iteration
  against the deadline and abandoning the generator, which has its own leak
  (an abandoned generator still holds its socket) — real work, deliberately
  not half-done here. Not exercised, and now stated straight.
- **Whether #1431's re-grade semantics arrive in a shape slice 3 can
  consume.** Named as a dependency (§2.3) but not designed yet; if it resolves
  in a way that keeps evidence frozen, slice 3 inherits a dishonest peer
  evidence grade and must be re-planned rather than shipped around. *(#1430's
  half of this bullet is resolved for slice 1: the shipped manifest reads the
  compute-on-demand `listLaunchableModelInventory()` and makes no
  tool-surface claim, so it is neither UI-visit-dependent nor dependent on
  `supportsTools` ever being populated. #1430 still gates any future
  tool-capability column.)*
