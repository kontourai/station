# Bind agent extensions to the declared mechanism, never to method names

## Context

archive#1815 asks how Station consumes ACP agent extensions — Kiro's
`_kiro/*` methods today — so that a second agent shipping a similar
capability, or ACP standardizing one, is an integration rather than a
rewrite. The issue proposed three layers and asked for one decision to be
ratified: the §4 noun cut. This ADR records the decision, amends two rows of
that cut on investigation evidence, and names the failure modes.

All wire evidence below was re-gathered live for this ADR (2026-08-03,
`kiro-cli 2.16.0`, macOS; probe scripts in the session scratchpad, results
summarized on archive#1815). Nothing is inherited from the issue text unverified.

### What the spec makes normative (fetched 2026-08-03)

Per the extensibility spec (agentclientprotocol.com/protocol/extensibility):
`_meta` exists on every protocol type; implementations **MUST NOT** add
custom fields at the root of a spec-defined type; `traceparent`/
`tracestate`/`baggage` are reserved at `_meta` root for W3C trace context;
method names starting with `_` are reserved for extensions
(implementations **MAY** call them); implementations **SHOULD** advertise
custom capabilities via `_meta` in capability objects; unknown *requests*
get the standard `-32601`; unknown *notifications* **SHOULD** be ignored.
There is **no documented path for an extension to become standard** — but
the ACP project runs an RFD process (e.g. the session-fork RFD) and has
been absorbing session lifecycle into core: `session/list`, `session/close`,
`session/delete`, `session/resume` are now core capability-gated methods
(`sessionCapabilities` in the v1 schema, present in the SDK Station already
installs, `@agentclientprotocol/sdk@1.3.0`); `session/fork` remains an
unstable RFD; session *history* is an open discussion (upstream discussions
`archive#60`, `archive#841`); a `v2.0.0-alpha` schema is reworking the lifecycle again.

So the mechanism (underscore methods, `_meta` advertisement, `-32601`,
ignore-unknown-notifications) is standard and stable; the methods are not;
and the standardization pressure that does exist flows extensions *into
core capabilities*, not into cross-vendor extension conventions.

### What the wire actually does (live evidence)

One authenticated binary, two handshakes:

- `kiro-cli acp` (v2): no `_meta` at all, `authMethods: []`,
  `mcpCapabilities: {http: true, sse: false}`. Declares **zero**
  extensions — and answers `-32601` to every extension request, including
  the methods its own docs page documents (`_kiro.dev/commands/execute`
  etc.). The docs match neither live surface.
- `kiro-cli --v3 acp` (v3 early access): `sessionCapabilities: {list, fork}`
  (core vocabulary), two `authMethods`, and
  `agentCapabilities._meta.kiro.extensionMethods` declaring seven bare
  `_kiro/`-prefixed methods (`knowledge`, `codeIntelligence`,
  `session/context`, `session/compact`, `session/export`,
  `session/history`, `config/template`) — none of which appear in Kiro's
  documentation. The declared list is the only place they exist.
- `kiro-cli --v3 --version` prints `2.16.0` — version detection reads v3
  as v2 while the two declare disjoint capability sets. **No version
  string can ever gate capability.**
- The namespace has drifted *within one vendor and within one binary*:
  docs say `_kiro.dev/`, v3 declares bare `_kiro/` methods, and v3 still
  *emits notifications* under `_kiro.dev/` (`_kiro.dev/mcp/server_init_failure`,
  observed by the archive#1684 probe). Both spellings are live simultaneously.
- **Kiro v3 does not return `-32601` for unknown methods.** It returns
  `-32603 Internal error` with vendor-internal detail
  (`[PersistenceClassification] Ext method "..." has no persistence
  classification…`) for undeclared methods — and `-32601` from v3 was
  observed on a *core* method (`session/new`) in the same session. v2
  returns `-32601` for everything. The error-code taxonomy is not a
  reliable discriminator even within one vendor.
- Declared methods answer in at least three failure dialects: JSON-RPC
  `-32000`, `{success: false, message}`, and `{success: false, error}` —
  including **success-envelope soft failures** (`_kiro/session/context`
  returns `{success: false, …}` as a JSON-RPC *result*). Declared ≠
  observed ≠ working is not a modeling nicety; it is the observed wire.
- The agent sends **extension requests to the client**:
  `_kiro/auth/getAccessToken` (twice, before answering `initialize`) and
  `_kiro/terminal/shell_type`. Station's adapter currently answers *every*
  agent→client extension request with `{}` — a fabricated empty success
  (`onExtMethod: () => ({})`, `acp-adapter.ts`). The archive#1684 security probe
  established what `getAccessToken` is: Kiro's **own AWS model credential**
  (a decoy answer was transmitted upstream as a bearer credential and
  produced a validation error, not an auth rejection). Station holds
  nothing it could legitimately hand over; answering it is a
  credential-disclosure surface. Refusing it (`-32601`) leaves v3 turns
  unable to execute — a known Kiro compatibility break that already bites
  other generic ACP clients (kirodotdev/Kiro#10416, archive#10543) and is not
  Station's to paper over.

### The ecosystem (surveyed 2026-08-03)

Roughly four vendors ship *some* declared extension surface, but they are
not four implementations of the same thing: Kiro is the **only** vendor
with a declared extension-*method* family. The others are `_meta` flags
and decorations — the Claude agent bridge's `_meta.claudeCode.*` /
`subagent-transcript` opt-in, Cursor's `clientCapabilities._meta.parameterizedModelPicker`
(consumed by Zed), gemini-cli's informational `_meta.quota`/`_meta.legacyState`.
The spec's own flagship example (`_zed.dev/workspace/buffers`) was never
built. For session lifecycle specifically, the "second implementation" of
Kiro's `_kiro/session/history`-shaped territory is **ACP core itself**
(`sessionCapabilities.list` + `SessionInfo`), which Kiro v3 already
declares alongside its private variants. No second implementation of
knowledge, code intelligence, or auth-callback extensions exists anywhere.

## Decision

Build to the mechanism, which is standard; never to the methods, which are
not. Three layers, with the noun cut amended as below.

### Layer 1 — a generic extension channel (asserts nothing)

A typed pass-through over ACP's extension mechanism, in the ACP substrate
(`ACPProcess.extMethod` already exists; the channel wraps it):

- Outbound requests/notifications are keyed on the **live session's own
  declared `extensionMethods`** — never a compiled-in constant, never a
  stored observation, never a version string. Calling an undeclared method
  through the channel is a distinct, receipt-carrying non-event
  (`not-declared`), not a wire call.
- The channel's outcome vocabulary is derived from wire facts only:
  `not-declared` / `answered` / `unsupported` (`-32601`) / `failed` (any
  other error, **including vendor dialects like Kiro's `-32603`**). It
  deliberately does not interpret result payloads — a `{success: false}`
  envelope is `answered`; deciding what "working" means is each binding's
  conformance probe (Layer 3), because the envelope dialects differ per
  method even within one vendor.
- Unrecognized inbound notifications stay ignored (per spec; already the
  adapter's behavior).
- **Inbound agent→client extension requests default to `-32601` refusal.**
  This replaces the current fabricated `{}` success. Refusals are counted
  on a metric and logged with the method name so a new inbound dependency
  (the next `_kiro/terminal/shell_type`) is observable, not silent. A
  reviewed, allowlisted handler is the only way to answer one, and the
  standing invariant is: **no Station-held credential is ever bridged into
  an agent's extension request.** This matters more after archive#1684: once
  station-control tokens ride ACP sessions, "answer the agent's auth
  request" is one lazy handler away from handing the wrong principal's
  credential to a less-trusted process.
- `_meta` discipline per spec: no custom fields at the root of any spec
  type; W3C trace keys left alone.

This layer cannot lie because it makes no claim about what a method means.

### Layer 2 — a capability record with provenance, beside the matrix

Store the raw `initialize` result's `agentCapabilities` (including its
`_meta`) **verbatim**, per connection and per session, decorated with
`observedBy` (serving instance identity, `serving-instance.ts`) and
`observedAt` — ADR 0012's pattern: a capability claim without
whose-process and when is a label.

**Beside the matrix, not in it.** `EngineCapabilityMatrix` cells are
static per engine *family*; the declared-extension set is falsified per
connection and per *invocation* of one binary (v2 vs v3 above). The
matrix's own precedent (unification §4.1b, archive#1549) already splits
policy-in-the-cell from evidence-on-the-connection for exactly this
reason — and for extensions there is not even a static per-capability
policy to put in a cell. The substrate mostly exists: the ACP probe cache
retains `agentCapabilities` verbatim with `getHandshakeObservedAt()`; the
session record holds the live `initResult`. What Layer 2 adds is the typed
projection with provenance, and the rule that **the live session's own
`initResult` is the only delivery gate** — a stored observation may make a
surface conservative or produce a skip-with-receipt, never a grant
(same rule archive#1684 pins for MCP-over-HTTP).

Three states stay structurally distinct and no path collapses them:

- **declared** — the method was in the live handshake's `extensionMethods`.
- **observed** — Station called it and it answered (any result).
- **working** — it answered and a binding's conformance probe accepted the
  contract it claims.

This is the hachure spec's `sf-runtime-observation-required`
declared-vs-observed distinction. The vocabulary is consumed, not minted:
`@kontourai/surface`'s `EvidenceType` member `runtime_observation` names
the evidence class, exactly as `BuiltinStationControlDelivery.basis`
already does, pinned the same way
(`engine-capability-basis-vocabulary.test.ts`). Status is always a
derivation; there is no stored `supported: true` marker. Absence of an
observation renders as absence — never as zero, never as "no".

### Layer 3 — the noun cut, ratified as amended

The issue's principle stands: **abstract only where a second
implementation actually exists; pass through, vendor-scoped, where it does
not.** Investigation moved four rows:

| Extension | archive#1815 §4 proposed | Decided here | Why |
|---|---|---|---|
| `_kiro/session/history` (+ listing half of `/context`) | abstract over the extension | **bind to ACP core `sessionCapabilities.list` / `SessionInfo`** | Session listing is core protocol now; Kiro v3 declares core `list` alongside its private variant. The second implementation of this noun is the spec itself. Binding the vendor spelling would build on the leg that is being standardized away. |
| `_kiro/session/compact` | abstract (Station noun: sessions + event store) | **engine-action affordance, vendor-attributed; no Station semantic** | Verified: Station owns no session-compaction noun. Its event store is append-only and replay-pure (ADR 0012 leans on that); the only "compaction" in the tree is *rendering other engines' compaction status*. `StationSessionCompact` over one implementation would mean "Kiro's compact" while claiming to mean "compact". What Station can honestly abstract is the **mechanism**: "this live session declares an invocable action; here is a button attributed to the engine; here is its raw outcome" — semantics stay the vendor's. Strongest upstream candidate. |
| `_kiro/session/export` | abstract | **Station transcript stays canonical; engine-native export is an additional vendor-attributed artifact** via the same declared-action affordance | Station already owns the canonical export of an orchestration session (the event store + replay API). Kiro's export produces a different artifact (the engine's native record, which Station never saw in full). They are related, not interchangeable — an abstraction treating them as one export would assert an equivalence nobody computed. Second-strongest upstream candidate. |
| `_kiro/knowledge` | abstract, with an authority decision | **do not bind; authority decided below** | No consumer exists, and no second implementation exists anywhere in the ecosystem. See "The knowledge authority question". |
| Slash commands | abstract | **ratified** (already true) | Commands are core ACP (`available_commands_update`) plus an adapter aggregation Station ships; the vendor notification spelling moves into the evidence-backed rendering table (below). |
| MCP OAuth / server-init notifications | abstract into MCP host infra | **ratified at the rendering layer** | Already shipped as ephemeral transcript renderings; the hardcoded `_kiro.dev` spellings move into the rendering table. Deeper MCP-host integration waits for a consumer. |
| `_kiro/codeIntelligence`, `_kiro/config/template` | passthrough | **ratified** | No Station noun. Named for the vendor (`kiro.codeIntelligence`), reachable through Layer 1, no dedicated surface until a consumer exists. Noted: ACP core is growing an NES (edit-suggestion) surface that may become code intelligence's core home later. |

**Vendor notification rendering table (implemented by archive#1824).** The two shipped functional
renderings (`_kiro.dev/mcp/oauth_request`, `_kiro.dev/compaction|clear/status`)
plus the adapter's `_kiro.dev/commands/available` mapping currently live as
string constants in three files. They become one data table of
evidence-backed `(namespace, type) → rendering` entries. Both observed
spellings are **separate entries with separate evidence** — no wildcarding,
no fuzzy namespace matching (the honesty rule: exact match or
unavailable). Whether v3 emits `_kiro/`-spelled notifications is
NOT_VERIFIED (v3 turns are blocked on the auth callback); the table's
entries carry the handshake variant they were observed against. The single
authority is `src-shared/extension-notification-bindings.ts`, consumed by both
the ACP command-state Adapter and the UI renderer. It also records the `_kiro`
v3 notification spelling as an explicit evidence gap, so absence cannot be
mistaken for a negative observation or inherited through fuzzy matching.

**Trip-wires, filed at binding time.** Kiro states these extensions are
experimental; a declared method disappearing is *expected*. Every Layer 3
binding names its required declarations, and:

- a live session whose handshake no longer declares them renders the
  affordance **absent with a receipt** (metric + log naming the binding
  and the missing method) — never an error, never a stale button;
- a test executes that rejection path per binding (remove the declaration
  from a fake agent's handshake → affordance absent → receipt emitted);
- the declared-set delta per connection is logged on probe refresh, so
  namespace migrations (`_kiro/` → `_kiro.dev/` or to core methods) show
  up as observable events, not silent no-ops.

### The trap, refused

No `StationEngineFeature` enum mapped from vendor method strings — that
asserts semantic equivalence nobody computed, the label-versus-derivation
defect at ecosystem scale. If a cross-vendor mapping is ever introduced,
it is **data with a conformance probe**: a mapping counts once something
exercises it against a live agent and observes the contract it claims,
never once someone writes it down. Today no mapping is needed because no
two vendors implement the same extension.

### The knowledge authority question (archive#1815 precondition)

Two knowledge bases exist: Station's canonical stores (ADR 0009: stores
canonical, index derived) and Kiro's engine-internal knowledge (surfaced
inside Kiro as an ordinary built-in tool call, per ecosystem survey).
Decided:

- **Station's stores are the only authority on Station surfaces.** No
  Station surface queries `_kiro/knowledge`, and nothing from it is ever
  written into or merged with Station's namespaces.
- **Kiro's knowledge surfaces only as attributed engine activity.** When
  Kiro's agent consults its own knowledge mid-turn, Station renders it
  like any other engine tool call — the engine's action, under the
  engine's name. Station cannot prevent this and does not pretend to.
- **Disagreement is therefore never adjudicated**, because the two stores
  never meet in one answer. If a future consumer wants "search the
  engine's knowledge from Station", that surface is engine-attributed
  ("Kiro's knowledge"), side-by-side and never merged — federation
  (option C) is rejected outright as the same-fact-nobody-computed defect.

This is a product call and it is reversible: option B (attributed
side-by-side query) can be added later without disturbing A; C cannot be
walked back once results have been merged into user-visible answers.

## Alternatives rejected

1. **Hardcoded vendor method constants.** Already falsified live: the
   documented prefix answers `-32601` on both handshakes, the declared
   prefix exists only in v3's handshake, and one binary uses both
   spellings simultaneously. Every constant written from the docs is wrong
   today.
2. **A semantic feature enum over vendor methods.** The §6 master defect;
   see "The trap, refused".
3. **Declared-extension capability as matrix cells.** The matrix is
   static per engine family; this capability varies per connection, per
   invocation, per process lifetime. §4.1b's own precedent keeps evidence
   on the connection. A cell would either lie (static claim about dynamic
   truth) or stop being a matrix.
4. **Abstract everything (the issue's own anti-option, confirmed).** An
   abstraction over one implementation is a rename with extra steps — and
   for `session/compact` the investigation showed Station does not even
   own the concept it would be abstracting into.
5. **Passthrough everything.** Loses the two places where a second
   implementation genuinely exists: session listing (core protocol) and
   commands (already abstracted and shipped). It would also leave the
   inbound-request fabricated-`{}` behavior in place, which is a
   spec-conformance bug regardless of any noun decision.

## Failure mode of the chosen design

The declared list is **self-reported by a less-trusted process**. An agent
can declare methods that do not work (observed live: declared methods
answering `{success: false}` envelopes), fail to declare methods that do
work (v2 declares nothing), or lie outright. The design's honesty
therefore rests entirely on never collapsing declared → working: a surface
that renders a declared-but-unprobed capability as available is this
design failing. That risk is held down structurally (three distinct
states, status-as-derivation, conformance probes per binding) but a lazy
consumer reading only `declared` remains possible — the same residual ADR
0012 accepts for `answerability.answerable`, held down the same way
(annotate-with-provenance acceptance criteria, and the backstop that a
wrong claim fails loudly at invocation, since the live call still goes
through Layer 1's gate).

Second failure mode: the rendering table and action-affordance data grow
into a de facto vendor enum — vendor sprawl arriving as data instead of
code. Bounded by the same rule that has held since ADR 0008: an entry
requires an evidenced, functional consumer; "the vendor ships it" is not a
reason to render it.

Third: refusing inbound extension requests can break an agent that
requires a client-side answer to function — Kiro v3 is *already* this case
(turns fail without the auth callback). That is disclosed as the vendor's
compatibility break (their archive#10416), not absorbed; the alternative
(answering unknowable requests with fabricated success, or with
credentials) fails worse in the invisible direction.

## What would falsify this

- **ACP ships an extension registry/standardization path** making declared
  lists normative and versioned. Layer 2 simplifies (the registry becomes
  the vocabulary authority) and Layer 3 bindings migrate to core
  capabilities — the design is built to be absorbed, so this is the good
  ending, not a rewrite.
- **A second vendor ships semantically compatible extension methods with a
  published contract** (e.g. another agent implements `_kiro/*`, or two
  vendors converge on a shared export shape). Then a semantic abstraction
  becomes derivable from two implementations, and the noun cut should be
  revisited row by row — with the conformance probe already in hand as the
  mapping's admission test.
- **Evidence that agents commonly ship working, needed extensions without
  declaring them** (the spec's SHOULD leaves room). Declared-list-only
  gating would then under-serve users; the escape hatch would be an
  explicit per-connection opt-in probe list — deliberately not built now,
  because the only evidence today points the other way (v2 declares
  nothing and answers nothing).

## Consequences

- The implementation is sliced as station issues cross-referenced on
  archive#1815 (Collaboration Channels milestone): Layer 1 channel + inbound
  refusal; Layer 2 record with provenance; core session-list binding;
  declared session-action affordances with trip-wires; the vendor
  rendering table. Each slice carries a rejection path a test executes.
- `onExtMethod: () => ({})` is retired by the Layer 1 slice. Until it
  lands, every agent→client extension request receives a fabricated empty
  success — recorded here so the interim state is a known gap, not a
  discovery.
- The upstream draft for `session/compact` + `session/export` (RFD-shaped,
  since that is the path the ACP project actually uses) is staged in
  `docs/strategy/acp-extension-upstream-proposal.md`. Filing it is an
  owner call; nothing in this arc blocks on it.
- archive#1684 is deliberately untouched: its slice remains one indivisible
  cell+wire change. The inbound-refusal invariant here *supports* its
  security posture (no credential bridging) without entering its scope.
