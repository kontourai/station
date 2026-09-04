# Glossary

The canonical vocabulary for Station. This document is the source of truth — when usage elsewhere conflicts, fix the other usage. One word per concept, one concept per word.

> **Naming:** the product is **Station** — `@kontourai/station-*` packages and
> the `./station` CLI. `~/.station` is the default app-owned `STATION_ROOT`;
> `STATION_HOME` selects one runtime leaf such as
> `~/.station/instances/stable`. Do not call the shared root a runtime home.

## Station, device, client

Three nouns for three things. They are easy to blur and the product already
distinguishes them, so keep them distinct.

- **Station** — what you connect *to*. A host instance, addressable and
  countable: `station.example.ts.net`, `laptop.example.ts.net`. Take
  an article — "a Station", "this Station", "the Station" — because there is
  rarely only one. Capital S; it is the product name doing double duty.
- **Device** — what you connect *from*. A phone, a laptop, a browser. Yours,
  transient, pairs and unpairs. This is the pairing domain's established word:
  `deviceName`, `/api/pairing/devices`, `paired-devices.json`, "Pair this
  device".
- **Client** — an agent app a Station runs: Claude Code, Codex, opencode,
  cursor-agent. See `bin/clients/`, `station_require_dogfood_client`,
  `client-preflight.sh`.

> **Do not call a device a "client".** The word is already taken by the agent
> apps above, and a sentence containing both meanings cannot be read twice the
> same way. A phone is a **device**.

> **Do not use bare "Station" where you mean one instance.** "Pair this device
> to Station" reads as a brand and hides that there are several; "…to a
> Station" is what is actually happening. Bare Station is correct only for the
> product itself — "Station tried to restart it", "Station's local service".

**Host** and **client** as a topology pair are accurate and dull, and they make
the reader think about architecture at the moment they only want their phone
connected. The station metaphor already does that work: a station is somewhere
you dock, and devices arrive, pair, leave, and come back.

## The one question: what runs the agent?

Every agent is executed by an **engine** — that's still the one question ("what runs
the agent?"), but the answer is a **property of the agent** (which engine it binds to),
not a type the agent belongs to:

- **Engine** — what executes an agent: **Claude Code**, **Codex**, a custom CLI engine
  (**OpenCode**, **Kiro**, …), or **Station's engine** (VoltAgent/Strands driving a
  Model connection). Station's engine keeps its name — it is one engine among peers,
  not a privileged type.
- **Agent framework is not a product concept** — VoltAgent or Strands is an
  implementation detail underneath Station's engine. It is persisted for
  development and boot configuration, but is not a user-facing setting; any
  meaningful behavioral difference belongs in the engine capability matrix.
- **ACP is not an engine** — it's a transport detail of *how* Station reaches some
  engines (native SDK vs. launched-as-a-command over ACP). Users never see "ACP"; they see the
  engine's name.

The UI may describe an agent as a **Station agent** (run by Station's engine)
or an **External agent** (run by any other engine), but engine selection is a
property of the agent rather than a permanent type chosen from a type picker.

The reserved agent named **Station** is a role, not the Station-engine category.
It owns Station Control and Station Docs by definition, while its engine is a
separate Station setting: Station's engine, Claude Code, Codex, or a capable
custom engine may execute it. A label must therefore read like “Station ·
OpenCode”, never infer the engine from the agent's name.

## Connections

The Connections tabs are **Models** and **Engines**, and **the tab owns the
noun** (#592): the Models tab's user-facing objects are **Model connections**
(list title, add flow, delete confirm — all say "model connection"); the
Engines tab's objects are **Engines**. "Provider" is no longer a user-facing
object name anywhere — it survives only as the brand/service word inside
descriptive copy ("Pick the name you recognize…") and as the internal kind
vocabulary below. People still choose the thing they recognize first and a
model second; the tabs, not an umbrella noun, do the classifying.

The internal connection model retains two kinds where execution needs the
distinction:

- **Model provider** — an LLM endpoint: Bedrock, OpenAI, OpenAI-compatible,
  LiteLLM, **Ollama**. Powers **Station's engine**. *(`kind: 'model'`.)*
- **Agent provider** — how Station reaches an external engine: Claude Code,
  Codex, or a custom CLI engine (OpenCode, Kiro). *(`ConnectionKind` is
  `'agent'`.)*
- **ACP** — transport detail only, never a connection *kind* users choose or see named: how Station drives some external engines (OpenCode, Kiro) as a subprocess over the Agent Client Protocol, as opposed to a native SDK. Users see the engine's name ("OpenCode"); when a custom engine's name can't be resolved, the displayed default is **"Custom engine"**, never "ACP" and never "command-backed" — "command-backed" described the launch plumbing, which users read (wrongly) as a capability claim (owner feedback, 2026-08-22). "Custom engine" names what it is to the user: an engine they connected themselves by giving Station its command. `/connections/acp` remains only as a URL redirect to `/connections/engines` (the route itself is retired); labels never say ACP.

> **The kind vocabulary is internal.** Ollama and Bedrock are model providers
> (`kind: 'model'`); Claude Code and Codex are agent providers
> (`kind: 'agent'`). The interface calls the first pair **Model connections**
> and the second pair **Engines**, and reveals setup differences only when
> they matter.

> **Choosing a model is universal — it is not what separates the two.** Every agent picks a model: an agent on Station's engine picks from its **Model** connection (`qwen3-vl`, `claude-sonnet`, `nova`…); an agent on an external engine picks from that **engine connection** (Claude Code's `sonnet`/`opus`, Codex's tiers). The dividing line is **who runs the loop**, not who has models — Station's engine drives a Model connection directly, while an external engine runs its own loop and Station hands it a model (plus effort/thinking). So "Model connection" names *where Station runs inference*, not "the connection that happens to have models."

**Capabilities** describe what a connection can do (`llm`, `tool-calls`, `approvals`, …) — orthogonal to the Model/engine-connection split.

## Work identities

- **Project-owned agent** — an agent whose record names an owning project (`AgentSpec.project`, `agent-engine-unification.md` §3.3, station#1004 unification slice 7). Appears only inside its owning project (never subject to `ProjectConfig.agents`, never visible elsewhere, including the global/no-project context); deleting the owning project orphans it visibly (a validation state naming the missing project) rather than deleting it. Distinct from `ProjectConfig.agents`, which only opt-in-filters GLOBAL (unowned) agents.
- **Task** — a durable work identity owned by a Project. A Task can retain an exact workspace binding and typed references and can be reopened after Station restarts.
- **Task workspace** — the `/tasks/:taskId` surface for one durable Task. It keeps identity, files, diffs, artifacts, receipts, and exact Session correlation in context.
- **Task experience** — a working mode inside one Task workspace. **Direct** is Station-owned; **Deliver** is Builder Kit-owned; **Learn** is Knowledge Kit-owned; **Operate** is Console-owned. The labels are provisional while #495 is experimental.
- **Session** — one bounded execution episode. A Task may have no Session or correlate an exact Session; a Session is not itself a durable Task.
- **Direct chat** — an immediate conversation entry point. Starting a direct chat does not silently create or infer a Task.
- **Workspace availability** — `available`, `ambiguous`, or `unavailable`. Only `available` permits local inspection; the other states preserve the captured identity without claiming the path is still safe or current.

## "Runtime" — retired

We do **not** use "runtime" as a user-facing word; it meant too many things. Each former use now has a precise term:

| Old "runtime" use | Now |
|---|---|
| the VoltAgent/Strands engine | **Station's engine** |
| the `src-server` orchestrator | **Station core** / the server |
| a `kind:'runtime'` connection | **Engine** connection |
| "Runtime Chat" picker group | per-**engine** groups (§8.3) |
| `executionMode: 'runtime'` | **external** (shipped, slice 6/station#1003 — the VALUE itself is now `'external'`; a read-time shim normalizes older `'runtime'`-valued `agent.json`/remote payloads) |
| `executionMode: 'provider-managed'` | **station** (shipped, slice 6/station#1003 — same shim covers `'provider-managed'` → `'station'`) |

## Capabilities (Station agents own these; External agents can opt in to MCP or skills passthrough)

These extend **Station agents**; External agents bring their own (the app owns them) —
with two explicit, structurally identical exceptions, both off by default and never silent:

- **Skill** — a reusable bundle of instructions/behavior an agent adopts. THE one authored concept: a skill may declare itself runnable as a `/command`, which is what the retired "Prompt"/"Playbook" noun used to name. The word "playbook" survives only as accurate history (the `migrated-playbook` skill origin, `station doctor --migrate-playbooks`).
- **Integration** — an MCP server that exposes tools.
- **Tool** — one callable: a function from an integration, or a `station-control` platform function.
- **Command** — a slash command.
- **Plugin** — an installable platform extension (layouts, agents, integrations, providers, …).

> **MCP passthrough (exception 1):** an ACP-connected External agent's connection can
> explicitly opt in to receiving Station's stdio MCP tool servers inside its own
> sessions (`ACPConnectionConfig.provideToolServers`, off by default — never silent). See
> `docs/design/connections-onboarding.md` §5. This is provisioning, not ownership: the
> agent app still owns behavior, permissioning, and which passthrough tools it actually
> calls — Station is not executing inside its loop.
>
> **Skills passthrough (exception 2):** a `claude` connection can explicitly opt
> in to a list of Station skill ids (`AgentConnectionSettings.config.provideSkills`, off
> by default — never silent). Station materializes the opted-in skills into
> `<cwd>/.claude/skills/<skill-id>/` so Claude Code's native skill loader discovers them
> with no Station involvement at chat time
> (`src-server/providers/adapters/claude-skills-materialization.ts`, wired in
> `station-runtime.ts`). Same shape as MCP passthrough: provisioning, not ownership.

## Tasks & work items

- **Task** — Station's friendly label for a work item plus its dispatch affordance (the Tasks board on a project's page): create it, assign an agent/skill, and dispatch it into a session. Its statuses (`TaskStatus` in `@kontourai/station-contracts/task-graph`) are aligned to the flow-agents neutral work-item vocabulary — `todo`, `ready`, `triage`, `in_progress`, `blocked`, `review`, `verification`, `done` — with `canceled` kept as a documented **Station-local extension** (a task a user abandons before completion; the neutral contract itself has no such state).
- **Work item** — the provider-neutral unit from `@kontourai/flow-agents`' work-item contract (`schemas/backlog-provider-settings.schema.json`, published by that package — not a file in this repo): a piece of backlog work identified independent of any one tracker (e.g. a GitHub issue). A Station `TaskRecord` may carry `sourceProvider`/`workItemRef` to reference the work item it originated from, without Station reaching into that provider's internals.
- The direction of travel from the Session Board to a Console board (a work-item-aware view) is governed by epic **#580** — this glossary entry documents the vocabulary alignment (issue **#581**); the board convergence itself is tracked separately under that epic.

## The three "planes"

"Plane" names three unrelated things across Station's docs and the Kontour suite. Keep them apart (issue **#587**, `docs/design/work-plane-composition.md` Decision 10):

- **Console operating plane** — Console's own read-only, cross-product aggregation: `OperatingState` (processes, gates, claims, evidence, timeline) folded from product-owned Console events/projections (console ADR 0001, "Console owns the integrated operating plane"). Console never holds semantic authority here — the producing product does (Surface owns claim trust state, Flow owns gate/run state, ...); Console only aggregates, correlates, and routes through that authority (console ADR 0002). Station builds this in-process via `@kontourai/console-core`; no hub is required at runtime. Not the same split as Console's separate **view plane / act plane** (`docs/design/work-plane-composition.md`): the operating plane is the projected *data*; view/act are how a host renders and routes intents against it.
- **Emitter-sink control/record plane** — a data-taxonomy distinction inside a Console producer's emission pipeline, not a service boundary: every record is either **control-plane** (semantic, product-owned — events, projection snapshots, evidence refs, identity links, decisions, gates, `learning.*`) or **telemetry-plane** (operational — traces, metrics, logs, delivery diagnostics; never authoritative for product truth). Defined in console's Emitter/Sink/Plane contract (`docs/specs/emitter-sink-plane-contract.md` in the `kontourai/console` repo); `KontourEmitter`/`LocalFileSink`/`CompositeSink` are control-plane-first delivery roles. A shared `correlationId` may link a control-plane record to its telemetry without transferring authority between the two planes.
- **Station's control plane** — the `station-control` execution surface: Station's own MCP-exposed platform-management tools (`src-server/tools/station-control-*.ts`) that let a Station agent inspect/reshape the workspace (projects, agents, skills, integrations) the same way the UI does. Unrelated to both Console planes above — it is Station-local execution authority, not a suite-wide projection or a data-classification scheme. Station's board/task act-plane handlers instead use the in-process host-command catalog in `src-server/capabilities/station-descriptor.ts` and Console's `HostIntentBinding` resolution. They do not claim a CLI-routable executable until Station ships one.

## Saved Stations — how a device reaches a Station

A device keeps a local, renameable entry for every Station it can reach: a
name, one endpoint origin, and a reference to a credential held by the
platform credential store (internally `StationProfile`,
`packages/contracts/src/station-profile.ts`). The entry answers "which
Station am I talking to, and as whom" — it deliberately does not describe
where an agent executes (an **Environment**) or how it is executed (an engine
connection). Trust grants (e.g. remote extension bundles) are stored **per
Station on this device**, so trusting one Station never extends to another.

- **The user-facing noun is just "Station."** The switcher and manager list
  *Stations*; the affordances are "Add a Station", "Edit Station", and
  **"Forget Station"** — the Wi-Fi pattern: *forget* says the removal is
  local to this device, so no separate record-noun ("profile", "host",
  "connection") is needed to distinguish the entry from the server.
- **"Profile" never names this record.** That word belongs to the user's own
  account surface (`/profile`, `ProfilePage`). The internal identifiers
  (`StationProfile`, `SavedConnection`, `useConnections`,
  `activeConnection`) are the pre-vocabulary names — migrate them
  opportunistically; new code says `station`/`savedStation` for the concept.
  A qualified technical noun may still use the provider's established term,
  such as an AWS, Apple provisioning, SSH, engine app-home, or
  credential-recovery profile; never shorten one of those to an unqualified
  “profile” in user-facing Station copy.
- **"Connection(s)" never names this record in user-facing copy either.**
  That word is taken by the provider hub (Model and engine connections,
  above). The plain-English *connectivity* sense stays legitimate where it
  means reachability, not the record: "checking the connection to this
  Station" is fine; "Edit connection" for the saved entry is not.
- **"Host" is not introduced.** It would be a user-facing synonym of Station
  (the glossary already defines Station as the host instance), and one
  concept gets one word. Nothing scans copy for it, so it drifted back in
  three times: the pairing states are now worded once, in
  `packages/contracts/src/pairing-copy.ts`, whose own test asserts this rule
  over every entry (station#3849). Copy shared across the package boundary
  belongs there — it is the only module both `packages/connect` and `src-ui`
  may import.
- Every surface that introduces the concept carries a one-line, plain-language
  explanation at point of use (the manager: "Stations this device can reach.
  Forgetting one only removes it from this device."). The glossary is the
  source of truth; the UI is where users actually learn the vocabulary.

## Layout, Pane, Panel

These three words describe different levels of the interface. Do not use them
as interchangeable names for “the thing on screen.”

- **Layout** — a saved or project-owned workspace composition. A Layout decides
  which workspace regions exist and how they are arranged. Use **Layout** for
  the product object and its chooser, editor, sources, and persistence. Ordinary
  lowercase “layout” can still describe spatial arrangement in developer prose;
  internal component names such as `SplitPaneLayout` describe implementation,
  not another product object.
- **Pane** — one renderable workspace region inside a Layout. A Pane has one
  placement in the composition and hosts content such as chat, files, terminal,
  or a plugin contribution. Use **Workspace Pane** when a developer contract
  needs to distinguish this extension surface from an ordinary UI region.
- **Panel** — a bounded visual grouping of controls or information within a
  page or Pane, such as a Trust panel or inspector panel. A Panel is not a
  persisted Layout and is not a synonym for a Workspace Pane.

> **Composition:** a **Layout contains Panes; a Pane or page may contain
> Panels**. A list/detail shell may also have lowercase left and detail panes,
> but those implementation regions do not become saved Workspace Panes unless
> they participate in the Layout contract.

## User-facing labels

| Concept | Show to users |
|---|---|
| agent run by Station's engine | **"Station" engine chip** + agent name |
| agent run by an external engine (incl. ACP) | **engine chip** naming the engine ("Claude Code", "Codex", "OpenCode · GLM-4.7") |
| A configured LLM endpoint | **Model connection** (Connections › Models) |
| A configured agent CLI or custom engine | **Engine** (Connections › Engines) |
| A selectable inference option within a connection | **Model** |
| This device's saved binding to one Station | **Station** (verbs: Add / Edit / **Forget**) |
| Saved workspace composition | **Layout** |
| One renderable region in a Layout | **Pane** (developer contract: **Workspace Pane**) |
| Visual grouping inside a page or Pane | **Panel** |
| Durable work identity | **Task** |
| Execution episode | **Session** |
| `missing_prerequisites` | name what's missing (e.g. "AWS credentials required") |

## Persisted identity records

- **`config/agent-registry.json`** — the sole authority for engine-connection identity and its owned default Agent. An external connection and its default Agent intentionally share the same clean text ID while remaining distinct typed namespaces (`EngineConnectionId` and `AgentId`).
- **`station`** — the persisted, non-deletable default Agent owned by Station's engine. There is no hidden `default` alias.
- Default Agents are records, not readiness projections. Disabled, degraded, disconnected, and unprobed engines retain their Agent; availability is an explicit field and reason.

## Rename status

This is the current pre-release vocabulary. Station does not preserve incompatible identity schemas: a non-empty unversioned or wrong-version home fails before data loading with `STATION_HOME_RESET_REQUIRED`, which names the supported `station home reset --confirm` command (station#1913) rather than requiring a manual, improvised fix.

- **User-facing labels:** the Connections tab owns the noun (#592) — **Model
  connection** on the Models tab, **Engine** on the Engines tab, **Model** for
  the option selected within a connection. Station/external and model/agent
  distinctions remain execution properties.
- **Data model:** `ConnectionKind` is `'model' | 'agent'`; Agent execution uses
  `agentConnectionId`; execution mode is `'external' | 'station'`; and adapter
  capability derives from `engineId` plus the engine capability matrix. Agent
  and engine-connection identifiers use one clean grammar with distinct
  branded types. Synthetic slugs, alias maps, promotion callbacks, and
  load-time identity normalization do not exist.
- **Engine vocabulary and identity (current):** user-facing labels, engine chips,
  the Connections hub, and new-chat grouping all name the engine. Persisted Agent
  IDs and engine-connection IDs use the clean grammar in
  `packages/contracts/src/agent-identity.ts`; the branded namespaces may share a
  text ID without becoming interchangeable types. The registry owns default
  Agents even when their engine is unavailable. The zero-tolerance inventory
  (`npm run agent-identity:inventory -- --require-zero`) rejects supported
  synthetic prefixes, alias maps, promotion callbacks, and load-time identity
  normalization.

**Routes:** canonical URLs and accepted aliases are implementation detail. See
[docs/guides/connections.md](guides/connections.md#route-aliases) for the
maintainer reference; user-facing navigation uses the labels above.
