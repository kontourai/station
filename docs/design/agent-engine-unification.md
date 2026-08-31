# Design: Agent–engine unification

> Status: **direction recorded (owner sessions, 2026-07-26); tracking issue #893.** One
> agent definition for all of Station, executed by an engine. This doc is the contract
> for the arc — the vocabulary migration, the unified `AgentSpec`, the engine capability
> matrix, stable default-Agent registry, and the UI convergence plan. Child slices: #894
> (engine vocabulary + chips), #895 (per-agent capability delivery), #896 (app-home
> profiles). Revise this doc — not just the code — when direction changes.
>
> Supersedes the **taxonomy** halves of `docs/design/entity-hierarchy.md` (the
> Station-agent/External-agent split as a *type system*) and ADR 0002's "two agent
> types" framing. The *ownership boundary* those documents protect ("the app owns
> behavior; Station provisions, never silently") is not weakened — it is restated here
> per-capability instead of per-type. `entity-hierarchy.md` gets revised in the same
> commits as the code that moves each boundary, per the standing rule.

## 1. The unification: one agent, executed by an engine

Station's former model was a two-type taxonomy (Station agent / External agent) with a
third shadow population of connection-shaped synthetic Agent records manufactured at
request time. That taxonomy decided everything —
editor tabs, badges, which capabilities an agent may even *have* — and it decides them
wrongly at the margins: Claude Code sessions can now receive Station skills (#897) and
ACP sessions can receive Station tool servers (#888), so "skills and integrations are
Station-agent capabilities only" is already false in shipped code.

The replacement model:

- **Agent** — one definition, everywhere: name, system prompt, MCP tool servers,
  skills, model preferences, scope (global or project). There is no "kind" field and no
  second schema. An agent is data.
- **Engine** — what executes an agent: Claude Code, Codex, an ACP CLI (OpenCode, Kiro,
  …), or Station's own engine (VoltAgent/Strands driving a Model connection). An engine
  is the thing you set up once in Connections; an agent binds to exactly one engine.
- **Capability matrix** — each engine declares which parts of the agent definition it
  can deliver, and through which channel (§4). Editors derive their tabs and fields
  from the matrix, not from a type taxonomy.
- **Capability honesty (hard rule)** — an agent configured with a capability its engine
  cannot deliver is an **authoring-time validation state**, surfaced in the editor and
  the API. It is never silent degradation at session time (§5).

What does *not* change: the engine still owns its loop. For external engines Station
remains the provisioning plane (connections-onboarding.md §5) — it hands the engine a
definition through sanctioned channels; it does not execute inside the engine's loop,
and per-tool permissioning/policy gates remain native-only. The glossary's "who runs
the loop" question stays the right question — the answer just becomes a property of the
agent (`its engine`) instead of a type of agent.

## 2. Vocabulary: "engine", phased labels-first

"Engine" becomes the user-facing word for what executes an agent, replacing the
Station/External type language and absorbing "Agent app" (a connection *to* an engine).
The Playbooks-rename precedent (#190/#204: one labels sweep + canonical routes with
tested aliases + the zero-tolerance noun gate extended in the same commit + glossary
updated together) is the template. Phasing:

- **Phase A — labels + glossary (#894).** `docs/glossary.md` defines Engine first, then
  the UI sweep in the same arc: engine chips (§8.1) supersede the External/ACP badges,
  the Connections hub's "Agent apps" section and the new-chat picker group by engine,
  `scripts/noun-consistency-gate.mjs` learns the new canon. The gate's allowlist
  (`scripts/noun-consistency-allowlist.json`) was already empty — "External"/"ACP" were
  never banned words, so there was never an allowlist entry to retire; the gate's
  guidance prose learns the new canon and the banned-word list gains nothing. No
  data-model changes; internal identifiers are mapped to the new words at the UI
  boundary, exactly like Phase 1 of the Station/External rename.
- **Phase B — internal identifiers (slice 6, station#1003, shipped 2026-07-27).**
  `ConnectionKind` is `'model' | 'agent'`; `executionClass: 'managed' |
  'connected'` became `engineId: string`; `ExecutionMode` is `'external' |
  'station'`; and `AgentType`/`resolveAgentTypeFromRuntimeConnection` are retired.
  #1417 completes the remaining synthetic-identity removal under §7. It is a
  pre-release clean break: identity-bearing homes that do not have the current marker
  are rejected, rather than normalized, redirected, aliased, or migrated on read.

Terminology fine print, decided now so #894 doesn't relitigate:

- **Station's engine keeps its name.** The glossary already says "Station's engine" for
  VoltAgent/Strands; unification makes that literal — it is one engine among peers, not
  a privileged type.
- **ACP disappears from user-facing vocabulary entirely.** It was already "a connection
  detail, not a third type"; under engines it is a *transport* detail of how Station
  reaches an engine. Users see "OpenCode", never "ACP". The `/connections/acp`
  management page keeps its URL (aliases are cheap) but its labels say command-backed
  engines by name.
- **"Connection" survives** as the configured-backend noun: a Model connection powers
  Station's engine; an engine connection is how Station reaches an external engine.
  The Connections hub remains the engine setup surface (§8.3).

## 3. The unified AgentSpec

### 3.1 What already exists

`AgentSpec` (`packages/contracts/src/agent.ts`) is already 90% of the unified
definition: `name`, `prompt`, `tools.mcpServers`, `skills`, `commands`, `model`, and
`execution.agentConnectionId` (the engine binding). The unification is an evolution of
this one type, not a new schema. What's missing or wrong:

- **No ownership.** There is no project-owned agent today at all — every record lives
  in one global root and `ProjectConfig.agents` is only an availability filter over
  global agents; the definition itself carries no scope.
- **Capability fields are honored only by Station's engine.** For external engines,
  `prompt`/`tools`/`skills` are dead weight today; the shipped passthroughs hang off
  *connections* instead (`ACPConnectionConfig.provideToolServers`,
  claude `config.provideSkills`) — one setting for every agent on that engine.
- **The adapter seam can't see the agent.** `ProviderSessionStartInput`
  (`packages/contracts/src/provider.ts`) has no system prompt, no tool servers, no
  skills, no agent identity beyond `metadata.agentSlug`; bedrock/ollama smuggle a
  system prompt through `modelOptions.systemPrompt`, claude reads `provideSkills`
  out-of-band at bootstrap, acp reads `provideToolServers` from the connection.

### 3.2 Target contract

```ts
// packages/contracts — evolution of AgentSpec, additive first
interface AgentSpec {
  name: string;
  prompt: string;                 // universal; engines that can't deliver it → §5
  description?: string;
  icon?: string;
  project?: string;               // NEW: owning project slug; absent = global scope.
                                  // Scope is derived from ownership, not a bare enum.
  execution?: AgentExecutionConfig; // engine binding: agentConnectionId + model prefs.
                                    // ABSENT = Station's engine (engineId 'station') —
                                    // "binds to exactly one engine" holds by default,
                                    // not by requiredness. In the target contract
                                    // agentConnectionId itself becomes OPTIONAL with
                                    // the same meaning (absent = Station's engine),
                                    // so `{ execution: { modelId } }` is schema-valid
                                    // — today's schema requires it, which would make
                                    // the earlier top-level-model normalization below unwritable.
  tools?: AgentTools;             // universal; delivery per engine channel (§6)
  skills?: string[];              // universal; delivery per engine channel (§6)
  commands?: Record<string, SlashCommand>;
  // …existing fields (guardrails, delegation, streaming, ui) unchanged; they are
  // engine-conditional like everything else — the matrix says who honors them.
}
```

And one additive field on the adapter seam — the structural keystone of #895:

```ts
interface ProviderSessionStartInput {
  // …existing fields…
  agent?: ResolvedAgentDefinition; // NEW: the resolved spec the session runs as —
                                   // prompt, tool servers (resolved ToolDefs),
                                   // skill dirs (resolved paths), model prefs,
                                   // and the agent's real slug.
}
```

Adapters provision from `input.agent`, each through its engine's channels (§6).
Resolution (skill ids → dirs, tool-server ids → defs, env-secret exclusion) happens
once in the orchestration layer, not per-adapter. Model precedence is decided here
too: `execution.modelId` (engine-scoped) is canonical; the earlier top-level `model`
field is normalized into `execution` on load (`migrateLegacyAgentSpec` style) and
deprecated — resolution never consults both. That normalization is only writable
because `agentConnectionId` goes optional (§3.2): an earlier `{ model }` record with no
execution block becomes `{ execution: { modelId } }`, meaning Station's engine with
that model — the same record it always was. The existing side channels
(`modelOptions.systemPrompt`, bootstrap-read `provideSkills`, connection-read
`provideToolServers`) migrate onto this field and are then retired; connection-level
settings remain as **engine defaults** that seed a new agent's spec and back the
default agents (§7), so #888/#897 users lose nothing.

### 3.3 Storage and scope

Agents stay file-based in the single existing root (`agents/<slug>/agent.json` via
`config-loader-agents.ts`) — project scope does **not** introduce per-project storage
directories. The contract:

- **Ownership, not location.** A project-scoped agent is one whose record names its
  owning project (`project: '<projectSlug>'`). No field = global. Slug uniqueness
  stays global (one namespace, one loader, no cross-project collision rules).
- **Visibility.** A project-scoped agent appears only inside its owning project; it is
  not subject to the `ProjectConfig.agents` opt-in filter (that filter selects among
  *global* agents; owned agents are implicitly available in their project and nowhere
  else). This changes the availability-check boundary: the
  `project-reference-integrity` helpers and their callers, which today see only
  `ProjectConfig.agents` + a slug, must receive **both** the current project's
  identity and the agent's ownership — availability is "owned by this project, OR
  global and passing the `ProjectConfig.agents` filter"; neither input alone can
  answer it. This boundary change ships with slice 7 (§9), which owns the `project`
  field end to end.
- **Orphans.** Deleting the owning project orphans its agents visibly (listed with a
  validation state naming the missing project), never silently deletes them.
  Save-time validation rejects a `project` value naming a nonexistent project;
  load-time normalization **preserves** whatever `project` value is on disk — it
  flags an unknown owner as the orphan state, it never rewrites or clears it (the
  same authored-content-is-never-invisible rule as §5).

## 4. The engine capability matrix

### 4.1 Contract shape

One declaration per engine, versioned in contracts, consumed by editors, validation,
and adapters alike:

```ts
type CapabilityDelivery =
  | { state: 'native' }                          // engine honors it in-loop (Station engine)
  | { state: 'session'; channel: DeliveryChannel } // provisioned per session (§6)
  | { state: 'unsupported' };                    // authoring-time validation state (§5)

type DeliveryChannel = 'wire' | 'app-home' | 'workspace-overlay' | 'flag';

interface EngineCapabilityMatrix {
  engineId: string;               // 'station' | 'claude' | 'codex' | ACP engine id
  systemPrompt: CapabilityDelivery;
  toolServers: CapabilityDelivery;
  skills: CapabilityDelivery;
  commands: CapabilityDelivery;
  modelSelection: CapabilityDelivery;   // + which knobs: effort/thinking/sandbox…
  approvals: boolean;             // session-interaction capabilities stay booleans —
  interrupt: boolean;             // they describe the wire, not agent-definition fields
  sessionResume: boolean;
}
```

Seed matrix (initial honest state — entries move as slices land):

| Capability | Station engine | Claude Code | Codex | ACP CLIs |
| --- | --- | --- | --- | --- |
| System prompt | native | session/flag — **shipped** (#895 wave B: SDK `systemPrompt` preset+append; authored prompt appends to the engine's own prompt) | session/wire — evidence-gathered, NOT shipped (#896 wave 2: `codex app-server generate-json-schema` against codex-cli 0.145.0 confirms `developerInstructions` on `ThreadStartParams`/`ThreadResumeParams`/`ThreadForkParams` — the wire channel this row names IS real — but the app-server protocol has no version/server-capability signal anywhere (`InitializeResponse` carries only `codexHome`/`platformFamily`/`platformOs`/`userAgent`; `InitializeParams`/`InitializeCapabilities` are client-declared only), so §5's version-skew honesty guard has nothing to gate on; authored prompts stay receipted `engine-unsupported` (#895 wave B) until a real signal exists) | unsupported — per-CLI initialize evidence recorded (#895 wave B probes: loadSession, mcp/prompt/session capabilities); no ACP CLI exposes a system-prompt surface; receipts unchanged |
| MCP tool servers | native | session/subprocess — **shipped** (#1157: SDK `mcpServers` wired in `claude-adapter.ts buildOptions`; station-control-only token injection, safe because the SDK spawns each MCP server itself inside Station's own process) | session/wire — **shipped** (station#1195, the Codex analog of #1157: `-c mcp_servers.<id>....` session-layer overrides appended to the `codex app-server` spawn argv, confirmed live against codex-cli 0.145.0; this superseded the app-home hypothesis this row originally seeded — `codex app-server` independently manages its own MCP connections, so the channel is 'wire' like ACP, not 'app-home'. The built-in station-control server is delivered via a per-session, short-lived, station-control-scoped bearer token riding the station-control HTTP/SSE MCP endpoint's URL query string — never env, since env can never safely cross a wire channel to an external process) | session/wire — shipped for `session/new` (#888) and `session/load` (#895 wave B) on loadSession-capable CLIs; a resume against a CLI without `loadSession` fails closed with a named error, never a silent fresh session. Authored passthrough stays stdio-only. The built-in station-control server (station#1684) is the one HTTP entry: an ACP `type: 'http'` server whose `Authorization: Bearer` header carries the same per-session token Codex carries in a URL query string — the header rather than the URL because an ACP `session/new` payload is handed to the external agent app. `basis: 'runtime_observation'`, so it is delivered only to a connection whose live `initialize` advertised `mcpCapabilities.http` |
| Skills | native | session/workspace-overlay — **shipped** (#897); app-home variant per #896 | session/app-home (if probe proves a skills surface; else unsupported) | unsupported (slash-command shims are a recorded follow-up) |
| Commands | native | unsupported (native slash commands are the engine's own) | unsupported | unsupported |
| Model + knobs | native (Model connection) | session (model, effort, thinking, fastMode) | session (model, approvalPolicy, sandbox, serviceTier) | model selection unavailable until the adapter invokes an ACP model-category configuration operation |
| Approvals / interrupt / resume | per adapter metadata (`ConnectionCapability`) | yes/yes/yes | yes/yes/yes | per-CLI probe |

### 4.1b Declared vs observed capability basis (station#1549, slice 1)

A matrix cell is *static per engine*. Some capabilities are not: ACP's HTTP
MCP transport is an **optional capability of the connected CLI**, negotiated
at `initialize` (`agentCapabilities.mcpCapabilities.http`). Writing it into
the static `acp` cell would make the picker claim something Station cannot
know until it has spawned that specific CLI — the dishonesty the matrix's own
header comment forbids.

The resolution keeps the matrix static and moves the third state into a
derivation, following the Surface spec's declared-vs-observed distinction
(`conformance/sf-runtime-observation-required.json`):

- **Policy in the cell.** `builtinStationControlDelivery` is a discriminated
  union carrying a `basis`: `'declared'` (Claude's `'env'`, Codex's
  `'url-token'` — statically reviewed engine-class facts) or
  `'runtime_observation'` (a reviewed mechanism whose use is conditional on a
  live observation of the specific subject). `'runtime_observation'` is
  `@kontourai/surface`'s own `EvidenceType` member, pinned by a type-level
  assignability test in the station tree
  (`src-server/services/orchestration/__tests__/engine-capability-basis-vocabulary.test.ts`).
  There is **no** stored `negotiated: true` marker — a marker is a label, and
  the spec defines a derivation.
- **Evidence on the connection.** `AgentConnectionView.controlPlaneObservation`
  (`{ mcpHttp, observedAt }`), projected **per connection** from the ACP probe
  cache and threaded through `ReadyEngineConnection` so the server bootstrap,
  the binding resolver and the picker all call one function with the same two
  inputs. In memory only: readiness already implies a live probe each process
  lifetime, and a durable "yes" would need identity-binding to the CLI's
  execution fingerprint plus a version-change staleness trigger to avoid
  trusting a stale answer across an upgrade. If the bootstrap window ever
  matters, that is the spec for the follow-up.
- **Capability as a derivation.** `engineControlPlaneCapability(matrix,
  observation?)` returns `'full' | 'chat-only' | 'observation-required'`. The
  third state lives in the codomain, never in the matrix.

**Doc-contract change.** The resolver's secret-boundary exemption
(`session-agent-resolution.ts`) and this predicate were previously documented
as the *same* predicate. They are now intentionally different questions —
"does a reviewed mechanism exist for this engine class?" vs "does one exist
AND is it verified for this subject?" — and they coincided in effect only
while every shipped cell was `basis: 'declared'`. Since station#1684 the
`acp` cell is observation-based, so they genuinely diverge: the resolver
exempts station-control for every ACP session, and the per-subject truth
belongs to the delivering adapter's **live** gate and its undelivered
receipt, not to either static check.

**Amendment to §4.1's #895 note.** "Probe capabilities are evidence only,
never gates the resolver's delivery map" remains true of the *session
delivery map* (`sessionDeliveryChannels`, still purely static). It no longer
holds for the *binding/picker* layer, which now consumes
`mcpCapabilities.http` as evidence. Recorded here rather than left as a
half-reversal — an unwritten half-reversal is how "ACP passthrough is
intentionally stdio-only" became a wording artifact (#1379).

Slice 1 was behaviour-neutral by construction: no shipped cell carried an
observation basis, so the derivation's second argument was never consulted on
any production surface. **Slice 2 (station#1684) shipped**, flipping the `acp`
cell in the same indivisible change as the wire code — the capability appeared
at the exact commit delivery works, in both directions. Delivery: an ACP
`type: 'http'` MCP server entry whose `Authorization: Bearer` header carries
the per-session station-control token (`acp-mcp-passthrough.ts`), gated on the
session's own `initialize` result in `acp-adapter.ts`. A connection that does
not advertise `mcpCapabilities.http` gets a working chat session without
station-control plus an `engine-capability-absent` receipt — never a failed
start, never a stdio fallback.

### 4.2 Model launch plans and receipts

Before an adapter is invoked, orchestration resolves exactly one `ModelLaunchPlan`:
`station-resolved` carries an exact selector with `catalog-pending` evidence;
the Station-model adapter changes it to `catalog-accepted` only after its own
catalog lookup succeeds. `engine-selected` carries either positive adapter
declaration evidence or the explicit `capability-absent` omission-only policy for
an undeclared third-party adapter; it deliberately has no invented model id.
`unavailable` carries a stable reason. An undeclared adapter may continue an
omitted selector for read compatibility, but an explicit override fails closed.

Bedrock and Ollama require an exact selector at start, retain the accepted
session selector for an omitted resume/turn, and revalidate an explicit
replacement. Codex may omit a selector and lets the engine select its default.
Claude and Codex declare the lifecycle points where they actually apply a
requested model. ACP has no generic override support: Station rejects a
requested ACP model before readiness probes, process/session dispatch, or model
discovery until the adapter genuinely uses ACP's model-category configuration
operation. Recovery uses this same resolution path; an earlier ACP model echo is
not replayed as a supported override.

Receipts keep three identities separate: **requested** and **applied** are typed
facts emitted at an adapter acceptance boundary; **reported** is an independent
structured runtime observation. Historical `session.configured.model` fields are
not upgraded into applied facts (in particular, ACP's old metadata echo remains
requested-only). A missing reported value never falls back to requested/applied.
The accepted start launch plan remains the session's original plan through
resume; a later supported reconfiguration may create a new requested/applied fact
but cannot rewrite historical reported identity.

Two rules carried over from shipped work:

- **Probe behavior, not advertisements.** OpenCode's `mcpCapabilities` advertises only
  `{http, sse}` yet stdio mounts fine (connections-onboarding.md §5). Matrix entries
  for ACP engines are seeded from probes (`ProviderCapabilityInventory`), and a probe
  result may *upgrade* an `unsupported` entry — never silently downgrade a session.
- **The secret boundary is part of the matrix's semantics.** An env-bearing tool
  server is never deliverable over `wire` or `app-home` to an external engine — same
  exclusion + disabled-reasoned-option UX as #888, now enforced at agent-spec
  resolution instead of per-connection.

### 4.2 Reconciling the three existing capability vocabularies

Today three unrelated "capability" systems coexist; the matrix subsumes the first, is
fed by the third, and re-keys the second:

1. `AgentCapabilityProfile` (`packages/contracts/src/agent-capability-profile.ts`) —
   editor-shaped booleans keyed on `AgentType` with a hardcoded
   `KNOWN_MANAGED_RUNTIME_IDS` allowlist. **Target: derived from the matrix.** Its
   consumer chain (`views/agent-editor/utils.ts` → `AgentEditorForm.tsx`) is already
   indirected, so re-keying is contained.
2. `ConnectionCapability[]` (`packages/contracts/src/tool.ts`, adapter metadata) —
   wire/session capabilities (`approvals`, `interrupt`, …). Stays; the matrix's
   session-interaction booleans read from it.
3. `ProviderCapabilityInventory` (`packages/contracts/src/catalog.ts`) — live probe
   results (models, native skills, slash commands). Stays; it is the *evidence* layer
   that turns matrix `unsupported`/probe entries into per-installation truth.

`executionClass: 'managed' | 'connected'` currently does double duty as loop-ownership
marker and badge discriminator, untyped inside `ConnectionConfig.config`. Engine
identity subsumes it in Phase B; until then the UI maps it to engine identity at the
boundary.

## 5. Capability honesty (hard rule)

An agent whose spec sets a capability its engine can't deliver — a system prompt on an
engine whose matrix says `unsupported`, a skill list for an ACP CLI with no skills
channel — is **invalid-as-authored**, and the system says so where authoring happens:

- **Editor — the concrete rule:** a capability surface whose matrix entry is
  `unsupported` and whose spec fields are **empty** is hidden (nothing to be honest
  about); the moment the spec **carries content** the engine can't deliver — authored
  now, authored before an engine switch, or imported — the surface renders in an
  explicit, persistent validation state naming the engine and the missing capability
  ("OpenCode can't receive a system prompt from Station"), read-only-with-diagnostics,
  with save allowed (an agent definition is portable data). Fields whose capability is
  `unsupported` never render as silently-editable-but-ignored, and authored content is
  never invisible.
- **API:** agent save responses carry the validation findings; session start against
  an invalid pairing succeeds only for the deliverable subset and records the
  undelivered fields in the session's configuration receipt (`session.configured`
  metadata) — visible in receipts, never dropped on the floor.
- **Never at session time as silence.** The one thing forbidden is the current de
  facto behavior: accepting configuration and quietly not delivering it.

This is the same trust argument as connections-onboarding.md §1 ("never silent") made
structural: honesty is a property of the contract, not a courtesy of each feature.

## 6. Per-session capability delivery and the overlay model

### 6.1 Owner policy: Station never installs into global CLI config

Base layer = the user's global engine config (`~/.claude`, `~/.codex`, XDG dirs),
**read-only** to Station — with an optional explicit *import-as-snapshot* to fork a
divergent Station-managed profile (#896). Station-managed additions stack per-session
via three channels, and only these:

1. **Wire** — config passed in the session protocol itself: ACP `session/new`
   `mcpServers` (#888, shipped), Claude SDK per-session options, Codex `thread/start`
   params. Nothing touches disk. Preferred whenever the engine offers it.
2. **App-home profile** — an env-pointed, Station-owned config home
   (`<STATION_HOME>/app-homes/<engineId>/…` via `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG
   overrides) layered for the session's process only (#896). **Wave 1 (shipped):** the
   Claude spawn boundary is closed — `ClaudeAdapter`'s `query()` call now layers
   `CLAUDE_CONFIG_DIR` onto a full `process.env` spread whenever the `claude`
   connection's `config.useAppHome` opt-in is on (absent/false is the default, off);
   the SDK's `Options.env` REPLACES the subprocess environment wholesale rather than
   merging, so the spread is load-bearing and `env` is left entirely unset when the
   toggle is off, keeping prior behavior byte-identical. **Wave 2 (shipped):** the Codex
   spawn boundary is now closed too — `codex-adapter-transport.ts`'s `codexSpawnEnv()`
   layers `CODEX_HOME` onto a full `process.env` spread, and `CodexAdapter.
   startReservedSession` resolves it via the same `getAppHomeEnv`/degrade-to-`undefined`
   contract as Claude, gated on the `codex` connection's `config.useAppHome`.
   Codex model discovery (`listModelCatalog`) deliberately keeps the byte-identical
   global env — the profile is scoped to the session's own process only. ACP/opencode's
   spawn path (`acp-process.ts`'s `ACPProcess.start`) remains full-inherit — XDG overrides
   stay to-probe, see `docs/design/connections-onboarding.md` §1.1's audit table.
   (Station does *read* `CLAUDE_CONFIG_DIR` elsewhere — transcript discovery, auth
   probing — that was never the gap; the gap was specifically the spawn boundary.)
   Session *data* writes to user paths stay acceptable and user-controllable — the
   policy targets config. **Adoption exception:** continuing a discovered Claude
   transcript never applies the app-home env — `forkSession`/`listSessions`/
   `deleteSession` are bound to the server process's own (global) config root with no
   per-call override, so forking a child under a different config home would orphan it
   there; adoption's `session.configured` receipt always reads `appHome: 'global'`. Codex
   has no analogous transcript-adoption path — its cross-config-home hazard is instead a
   documented `thread/resume` failure mode when `useAppHome` is toggled between a
   session's start and a later resume attempt (`docs/design/connections-onboarding.md`
   §1.1's toggle-boundary resume caveat).
3. **Workspace overlay** — manifest-tracked materialization into the session cwd
   (`.claude/skills/` per #897's hardened contract). Repo-rooted sessions only.

Selection order per capability, per session: **wire > app-home > workspace overlay** —
prefer the channel that touches the least state. Two hard guards:

- **Global-config refusal (shipped, #896 wave 1):** workspace materialization refuses
  any target that resolves — by real path, so a symlinked session cwd cannot dodge it —
  into global engine config, checked before any directory is created. This is a live
  hazard, not hypothetical: a dirless project or global agent defaults the session cwd
  to the user's home, where `.claude/skills/` *is* global config. Refusal is a named
  session-receipt event (`CapabilityUndeliveredReason: 'global-config-target-refused'`,
  `packages/contracts/src/provider.ts`) — wave 1 is receipt-only; the app-home channel
  is the designated (not-yet-wired) fallback for exactly this case, tracked as a wave-2
  defer so the reason taxonomy stays stable when that wiring lands.
- **The #897 hygiene contract is channel policy**, not a skills feature: per-session
  manifests, resolved-root containment, refuse-don't-follow symlinks, tracked-only
  cleanup apply to anything any engine materializes via the workspace channel.

### 6.2 #895: provisioning moves from connection to agent

The shipped opt-ins hang on the connection — one setting per engine, applied to every
agent on it. Target: the **agent spec is the provisioning source**; the connection
keeps an **engine-default** set that seeds new agents and powers the default agents.
Adapters provision per-session from `input.agent` (§3.2) — session start knows the
agent, so per-agent delivery is a resolution change, not a protocol change. Explicit
opt-in survives the move: capability delivery to an external engine remains off until
the agent's author turns it on, and the editor states the channel it will use.

## 7. Default Agents and clean identity schema

Station uses one clean, pre-release identity schema. It does not read, convert,
preserve, or repair the prior synthetic format. A non-empty Station home without the
current schema marker, or with a different marker, fails before loading or mutating
application data with `STATION_HOME_RESET_REQUIRED`, naming the supported
`station home reset --confirm` command (station#1913) rather than a manual reset.

### 7.1 Typed names and real defaults

`AgentId` and `EngineConnectionId` remain distinct branded identities.
`EngineId` is the single canonical string for an engine implementation and selects
its capability matrix; native Adapter provider, connection type, and matrix key use
that same value. `EngineConnectionId` separately identifies a configured, navigable
engine connection, which matters for engines such as ACP that can have multiple
instances. Plugins construct metadata engine identities with `engineId(...)`; the
untyped plugin loader validates the same grammar before
registration. The engine connection `codex` owns the default Agent `codex`. Generic identity envelopes use
`{ kind: 'agent' | 'engine-connection', id }`; an external custom Agent persists an
`engineConnectionId`, while a Station-engine Agent omits it.

There are no synthetic prefixes, aliases, tombstones, opaque replacement IDs,
generations, or identity-ledger records. A persisted default Agent is not an ordinary
custom Agent: it cannot be renamed, rebound, imported over, or directly deleted.

- A fresh compatible home contains the non-deletable `station` Agent.
- Every configured external agent-runtime connection owns exactly one persisted
  same-text default Agent, including command-backed engines. Model-only connections
  own none.
- Default existence never depends on readiness. Availability is derived separately
  and returned with an actionable typed reason.
- A namespace/owner collision fails before mutation. Station never suffixes, adopts,
  or manufactures an alternative ID.
- Deleting an engine connection removes only its owned default. Custom dependents
  remain stored and visibly invalid until an explicit rebind or delete.

#### 7.1.1 The `station` identity's engine is app state, not Agent state

The one exception to "`AgentSpec.execution` is the engine binding" (§3.2), recorded
here because leaving it implicit is what produced station#3662:

- **`AppConfig.builtinAgentEngineConnectionId` is the authority** for which engine
  runs the reserved `station` identity. It is a Settings field with its own editor
  (`BuiltinEngineRow`), not an Agent field.
- **It is resolved per boot, not persisted onto the Agent.**
  `resolveBuiltinAgentEngineBinding` weighs live readiness, control-plane capability
  and per-connection runtime observation, and fails safe to Station's own engine *for
  that resolution only*. Writing the resolution into `agents/station/agent.json` would
  let one boot with an unready engine destroy the user's stored choice, and would
  freeze out the recovery where the same stored choice starts resolving again the
  moment evidence arrives (station#1549).
- **The persisted record therefore never carries `execution.agentConnectionId`**, and
  that is enforced twice, not merely asserted:
  - **A submitted binding is REFUSED at the service seam.** `AgentService`'s
    `createAgent`/`updateAgent` throw `StationEngineIsAppSettingError` (HTTP 409) when
    a write names a non-empty `execution.agentConnectionId` for `station`, so REST,
    the SDK and the CLI all get the same answer and it names this setting as the
    owner. Stripping alone was a silent no-op: the caller got 2xx, and the response
    echoed the current runtime binding as if the write had taken effect. `execution:
    null` (move to Station's own engine) and a modelId-only `execution` stay ordinary
    accepted writes.
  - **The write boundary still strips**, as defence in depth for the records the
    refusal never sees: every Agent write goes through `saveAgentConfigWithOwnedLock`,
    which drops the key for this one slug, so a record written by an older build is
    corrected by its next ordinary save.

  Without the strip the projected value round-trips — the editor loads what the
  catalog served, and any unrelated save writes the runtime's current engine into the
  file, where it outlives the boot that resolved it.
- **Every read goes through the service projection.** `AgentService.getAgent` /
  `AgentService.listAgents` apply the runtime binding (and drop any binding left on a
  home that could not be healed). Routes, the CLI and MCP tools consume the service;
  none of them re-derives the overlay — they consume `agentCatalogReadSeam`, one
  named binding rather than per-route lambdas. `agent-binding-projection.test.ts`
  guards that seam behaviourally, and grep-guards only the negative claim that no
  other production file re-derives the projection.

A binding on this identity is thus derived from app state on every read, in one
place — not a second copy of the same fact stored beside the first.

### 7.2 Canonical registry and mutation boundary

`<station-home>/config/agent-registry.json` is the single revisioned authority for
engine-connection identity and owned default-Agent records. One registry CAS adds or
removes a connection together with its default Agent. `revision` rejects stale writes;
it is a write revision, not an identity generation.

The registry reuses the existing ConfigLoader pattern: expected-source-signature CAS,
cross-process file-mutation lock, same-directory temporary file, fsync, atomic rename,
and bounded retry. Mutations run through `applyAgentConfigurationMutation`, so durable
persistence precedes one runtime reload and a failed write never reloads the runtime.

Custom `agents/<slug>/agent.json` definitions and their memory stay in their current
locations. This contract neither moves nor rewrites them. The registry, rather than
`app.json` or `acp.json`, is the identity authority for engine bindings and defaults.

### 7.3 Supported-surface removal

The removal checklist lives in
[`docs/plans/agent-identity-supported-surface-inventory.md`](../plans/agent-identity-supported-surface-inventory.md).
Its executable check distinguishes existing classified work from an unclassified
synthetic identity path. Each checklist entry is deleted with its last supported
reference; the final cutover requires its `--require-zero` mode to pass with no
findings, unclassified paths, or stale entries.

## 8. UI convergence

All new controls obey the chat-composer contract: role-based semantics, real labels,
no `forceClickRole` in new specs, and API parity for every action.

### 8.1 Engine chips supersede External/ACP badges

The #881/#892 badge family (`AgentTypeBadge`: quiet "External" + "ACP" pills) is
replaced by **engine chips**: one chip naming the engine, everywhere agents render
(new-chat picker, agent lists, session tabs, hub cards) — "Claude Code", "Codex",
"OpenCode · GLM-4.7" (engine · model where the model is the distinguishing fact).
Decisions:

- **Every agent gets a chip**, including Station-engine agents. The old rule ("Station
  agents get no badge — the default case stays quiet") dissolves with the taxonomy:
  there is no default case, and the engine is precisely the fact that disambiguates
  the two-identical-OpenCodes problem the badges were built for. Visual weight stays
  quiet (the existing status-badge family); chips are informative, not alarming.
- **ACP never appears on a chip.** Transport is not identity. The engine's name and
  icon come from its connection/registry entry.
- The badge components/tests (`AgentTypeBadge.tsx`, `agentTypeBadgeKind`, their four
  call sites and four spec files) are the replacement surface — #894 converts them in
  place rather than layering chips beside badges.

### 8.2 Editors derive from the matrix

`AgentEditorForm` already derives tabs via `getAgentCapabilityProfile`; #894/#895
re-key that derivation on the engine matrix (§4.2). Target tab semantics: **Basic**
(always; includes engine selection — replacing the current "Station agent / External
agent" type `<select>` with an engine picker), **Prompt/Skills/Tools/Commands** (each
rendered per §5's concrete rule: shown when the engine's matrix entry supports it OR
the spec carries content for it; hidden only when unsupported *and* empty), **Engine**
(model + engine-specific knobs; replaces the Runtime tab),
**Connection** (read-only transport/setup info, links to the Connections hub). One
editor, matrix-driven — the third hardcoded tab set (`ACP_TABS`) disappears.

### 8.3 Connections hub and picker

The Connections hub remains **engine setup** (plus Models/Knowledge): its "Agent apps"
section becomes the engine section — cards for Claude Code, Codex, configured
command-backed engines, and detected-but-unadded CLIs (detection principle unchanged).
Agents never live in the hub. The new-chat picker groups by engine (today's
"External" + per-ACP-connection groups converge), with default agents appearing as
ordinary members of their engine's group; Recent stays first.

## 9. Slice map

| # | Slice | Contents | Depends on |
| --- | --- | --- | --- |
| 0 | **This doc** (#893) | Direction + contracts; glossary staleness fixes (internal marker, rename-status table) | — |
| 1 | **#895 per-agent capability delivery** | `ResolvedAgentDefinition` on `ProviderSessionStartInput`; move `provideToolServers`/`provideSkills` to agent spec with connection-level engine defaults; adapters provision from the agent; delivery-channel selection incl. system-prompt native flags (claude/codex) and per-CLI ACP probe; capability-honesty receipts | doc |
| 2 | **#894 engine vocabulary + chips** | Glossary "Engine" entry first; labels sweep; engine chips replace badges; picker/hub regrouping; noun-gate + allowlist updated same commit; entity-hierarchy.md revised with the code | doc (parallel-safe with #895; glossary commit lands first) |
| 3 | **#896 app-home profiles** | Per-CLI config-surface audit; `<STATION_HOME>/app-homes/<engineId>` via `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/XDG; import-from-global snapshot; global-config refusal guard for workspace materialization | doc; #895's channel selection |
| 4 | **#1417 stable default Agents** | Fresh-schema marker and registry-backed real defaults; clean typed-identity cutover removes synthetic manufacture, aliases, and promotion callbacks | #895, #894 |
| 5 | **Matrix-driven editor completion (station#975, shipped 2026-07-27)** | Engine picker in Basic; re-keyed capability profiles; validation states | #894, #895 |
| 6 | **Phase B identifier renames (station#1003, shipped 2026-07-27, §7.4)** | Engine identity (`engineId`) replaces `executionClass`; `ExecutionMode` values renamed (`external`/`station`); `AgentType` retired; #974 station-control strings. #1417 completes the remaining supported synthetic-identity removal as a clean break. | 4, 5 |
| 7 | **Project-owned agents (station#1004, shipped 2026-07-27)** | `AgentSpec.project` field end to end: schema + normalization, ownership-aware availability (the `project-reference-integrity` input-contract change of §3.3), orphan states, editor/picker surfacing | doc; #895's additive contract |

Slices 4–7 get their own issues when reached; 1–3 are #895/#894/#896 as filed.
Note #894/#895/#896 do **not** ship the `project` field — §3.3 is slice 7's contract.

## 10. Decisions

- **D1 — One `AgentSpec`, with a clean pre-release schema.** No second agent schema; the owning
  `project` field and the adapter-seam field are additions; absent `execution` means
  Station's engine; `execution.modelId` is the canonical model field. Incompatible
  pre-marker homes are rejected rather than normalized on load. (§3, §7)
- **D2 — Engine capability matrix is the single derivation source** for editor
  surfaces and validation; probes upgrade it, advertisements don't downgrade sessions.
  (§4)
- **D3 — Capability honesty is authoring-time validation, never silent degradation**;
  undeliverable fields are visible in editor, API, and session receipts. (§5)
- **D4 — Overlay model:** global engine config is read-only base; Station stacks
  per-session via wire > app-home > workspace overlay; workspace materialization
  refuses global-config targets. (§6)
- **D5 — Provisioning source is the agent; connections hold engine defaults.** (§6.2)
- **D6 — Default agents are registry records with typed identities.** The pre-release
  schema gate rejects an old identity-bearing home; no read-time aliasing or session
  migration is supported. (§7)
- **D7 — Engine chips for every agent; ACP is invisible in user-facing identity.**
  (§8.1)
- **D8 — Vocabulary migrates labels-first (Playbooks precedent), data model second.**
  (§2)

## 11. Contract impact on other docs

- `docs/glossary.md` — #894 rewrites the taxonomy sections around Engine; #1417
  removes synthetic-prefix terminology and records `AgentId` and
  `EngineConnectionId` as the clean identity boundary.
- `docs/design/entity-hierarchy.md` — status note added now pointing here; substantive
  revision lands with each slice that moves a boundary (standing rule).
- `docs/design/connections-onboarding.md` — §5 remains the passthrough mechanism
  contract; #896 adds the app-home/overlay section beside the detection principle;
  §5's per-connection opt-ins become engine defaults per §6.2.
- `docs/design/chat-composer.md` — its §3.4 badge spec is superseded by §8.1 (engine
  chips); the navigability principle and API-parity table are unchanged and binding.
- `docs/reference/session-api.md` — #1417 revises session inputs and responses to
  typed `AgentId`; synthetic `__acp:` redirects and alias-resolution behavior are
  removed with the supported surface.
- `docs/adr/0002-use-two-agent-types.md` — superseded by this doc's §1: slice 5
  (station#975) shipped 2026-07-27, retiring the editor's fixed `AgentType`-driven tab
  set in favor of the engine capability matrix. `AgentType` itself survives in code
  (validator + registry consumers) until slice 6.
