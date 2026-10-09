# Glossary

The canonical vocabulary for Station. Naming rules describe the intended labels;
they do not certify that every existing UI string follows them. Behavioral
definitions below link to their implementation or canonical guide.

> **Naming:** the product is **Station** — `@kontourai/station-*` packages and
> the `./station` CLI. `~/.station` is the default app-owned `STATION_ROOT`;
> `STATION_HOME` selects one runtime leaf such as
> `~/.station/instances/stable`. Do not call the shared root a runtime home.

## Station, device, client

Keep the destination, the connecting Device, its access route, and the agent app
running on a Station distinct.

- **Station** — what you connect *to*. A host instance, addressable and
  countable: `station.example.ts.net`, `laptop.example.ts.net`. Take
  an article — "a Station", "this Station", "the Station" — because there is
  rarely only one. Capital S; it is the product name doing double duty.
- **Device** — what you connect *from*. A phone, a laptop, a browser. Yours,
  transient, pairs and unpairs. This is the pairing domain's established word:
  `deviceName`, `/api/pairing/devices`, `paired-devices.json`, "Pair this
  device".
- **Broker** — an optional service that helps a Device reach a Station when a
  direct path is unavailable. One broker may serve many Stations and Devices;
  it handles bounded routing/signaling metadata, not Project data or agent work.
- **Push gateway** — the service that forwards a Station's signed push
  requests to Google FCM or Apple APNs using the publisher's credentials.
  Notification content is sealed to a registered phone; routing metadata and
  fixed alert categories remain visible to the gateway and push provider.
  It is not a
  Broker and not a relay: those let a Device reach a Station; the push gateway
  lets a Station wake a Device.
- **Route grant** — a separately issued, revocable broker credential kept by a
  client to reach one Station enrollment. Browser v1 grants bind a client
  Origin; native v2 grants bind an approved install proof key and native app
  surface. Neither binding proves a person's identity. A route grant does not
  approve the Station signing key, pair a Device, sign a person in, or grant
  Project access.
- **Client** — an agent app a Station runs, such as Claude Code or Codex.
  See [engine names](../packages/contracts/src/engine-display.ts) and the
  [Connections guide](guides/connections.md).

> **Do not call a device a "client".** The word is already taken by the agent
> apps above, and a sentence containing both meanings cannot be read twice the
> same way. A phone is a **device**.

> **Do not use bare "Station" where you mean one instance.** "Pair this device
> to Station" reads as a brand and hides that there are several; "…to a
> Station" is what is actually happening. Bare Station is correct only for the
> product itself — "Station tried to restart it", "Station's local service".

For the distinct machine, instance, saved-entry, environment, Project, room,
and offer concepts, see [Station topology](design/station-topology.md). The
technical phrase **Station client role** may describe a connection initiator in
architecture text, but it never shortens to **Client** and never replaces the
user-facing **Device** noun.

## Agents and engines

An **engine** executes an Agent. Its binding is a property of the Agent, not a
permanent category:

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

Within Connections, **Models** and **Engines** cover model and agent setup.
**The tab owns the noun** (#592): the Models tab's user-facing objects are **Model connections**
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

Both engine families can offer model selection. Station's engine selects from
a Model connection; an external engine can expose its own model and
effort/thinking options. An engine that reports no catalog may use its own
default. The distinction is which engine owns the loop, not whether its UI has
a model picker. The [engine capability matrix](../packages/contracts/src/engine-capability-matrix.ts)
records delivery differences.

**Capabilities** describe what a connection can do (`llm`, `tool-calls`, `approvals`, …) — orthogonal to the Model/engine-connection split.

## Work identities

- **Project-owned agent** — an agent whose record names an owning project (`AgentSpec.project`, `agent-engine-unification.md` §3.3, station#1004 unification slice 7). Appears only inside its owning project (never subject to `ProjectConfig.agents`, never visible elsewhere, including the global/no-project context); deleting the owning project orphans it visibly (a validation state naming the missing project) rather than deleting it. Distinct from `ProjectConfig.agents`, which only opt-in-filters GLOBAL (unowned) agents.
- **Task** — a durable work identity owned by a Project. A Task can retain an exact workspace binding and typed references and can be reopened after Station restarts.
- **Task workspace** — the `/tasks/:taskId` surface for one durable Task. It keeps identity, files, diffs, artifacts, receipts, and exact Session correlation in context.
- **Task experience** — a working mode inside one Task workspace. **Direct** is Station-owned; **Deliver**, **Learn**, and **Operate** name intended Builder Kit, Knowledge Kit, and Console integrations. Installed, enabled plugin capability declarations make the optional tabs visible. Their current panels describe the integration boundary; visibility does not prove an operational integration. See [the Task experience resolver](../src-ui/src/views/task-experiences.ts) and [Task workspace](../src-ui/src/views/TaskWorkspaceView.tsx).
- **Session** — one bounded execution episode. A Task may have no Session or correlate an exact Session; a Session is not itself a durable Task.
- **Draft** (session state) — a Session that nothing has been sent to: no turn has started and no send was attempted anywhere in its conversation's lineage, nothing in that lineage produced output, and it carries no history from elsewhere (attached, adopted, a Station-dispatched delegation, or a fork, which carries copied messages). The server derives it (`OrchestrationSessionSummary.draft`, #2310) so every device computes the same answer from the same read; a Draft is listed under **Drafts**, never under a live lane. A send that was attempted and did not take, with no activity since, is not a Draft either — that Session reads **Failed** with the reason ("Station refused the send before it started", or "The send failed and no activity has been recorded since", since a failed send may still have reached the engine); activity landing later clears it, and a send refused because the caller may not act on the Session changes nothing. The first turn ends a Draft: the sending device re-reads at once, other devices on their next session-list read (live push to other devices depends on #2307 and #2309 Phase B). **Discard draft** (#2312) deletes a Draft on the server — the whole conversation, since the Draft fact is conversation-wide — so every device's next session-list read agrees; the server re-derives the fact and refuses anything that is not a Draft. Drafts created more than 24 hours ago fold under "N older drafts" (creation, because a Draft's other clocks move without anyone touching it — a stop rewrites `updatedAt`) in each Drafts group; nothing is deleted automatically. Not the same thing as a composer draft — unsent text in a chat's input, kept per device; an inbox row whose open chat holds one on this device carries an **Unsent draft** cue.
- **Live lanes** — the unfinished work every inbox surface (Home, the Activity list, the project live-work badge, the chat dock inbox and the phone picker) lists, split by what is happening, from one derivation (the status ladder, [`workStatus`](../src-ui/src/views/home/work-status.ts), whose words are the shared `SESSION_STATUS_WORDS` in [`session-attention`](../packages/contracts/src/session-attention.ts), the table Station Control's `list_project_activity` also words a Session from): **Needs you** (an approval, question, review or block you can answer, or a send of yours queued while offline that waits on the connection), **Running** (a turn or reported child work is in flight) and **Idle** (not finished, nothing in flight, nothing asked of you — including a request nothing here can answer, which reads *Elsewhere* with its basis in the hover card). Idle is not "your turn": an idle session may already be done from your point of view. The retired single "Active now" lane counted idle sessions as active. The same call that files a row under a lane also writes the row's one **status line**, and it is the ONLY source of status words on these surfaces (the Activity list, the session detail header, the Plan panel's strip and the chat status pill read it too; `session-state-word-consistency.test.ts` fails on a synonym). The lane is decided by the item's state alone (an owed decision outranks running because the shared attention fold files an awaiting session ahead of an active one, even while its turn is still open); facts derived beside the item only choose the words inside that lane. The words: *Needs approval* (an open approval, permission or confirmation request), *Needs answer* (an open question), *Interrupted* (a turn cut short by a restart), *Blocked*, *Queued to send*, *Waiting on you* (owed something whose kind nothing recorded); *Running* (with the current tool, then how long the turn has run, e.g. `Running · Bash · 1m`), *N sub-agents*, *No progress · 4m* (the turn-stall watchdog's own marker, its duration how long the run has been quiet, with the running tool between when there is one, `No progress · Bash · 4m`: still in the Running lane because the turn is open, drawn in the caution tone with a clock icon and never called stalled, since a quiet run can be expected; the chat's banner says the same in one sentence, "No progress for 4m"); *Idle*; *Done*, *Stopped*, *Failed* (with its cause); *Draft*; *Elsewhere* (started in another app, or a request nothing here can answer — the reason is the hover card's and the Details sheet's, never the row's). The lanes are named the same on every surface: Needs you · Running · Idle · Just finished · Snoozed · Earlier · Drafts. A heading that shows a count reads `Needs you · 2` everywhere, as visible text in the UI face ([`WorkGroupLabel`](../src-ui/src/components/inbox-row/WorkGroupLabel.tsx)); Earlier shows none, and is one flat list, newest first, with no dated sub-headings on any surface — each row's time says when. Times on these surfaces take one compact relative form (`now`, `2m`, `1h`, `2d`, then a short date past a week; the absolute instant is a tooltip, and no row says "ago" or "last activity"). A duration takes the same coarse form — `12s` under a minute, then `4m`, then `1h 4m` ([`formatDuration`](../src-ui/src/utils/relativeTime.ts)) — and a live one counts off one shared clock (`useElapsedClock`), so one item reads the same duration on Home, in the dock and in Activity at the same instant; a stopwatch (`m:ss`) is a different thing. Nothing reports whether a sub-agent itself needs approval, so the ladder has no such rung.
- **Agent run** — one agent working through a request from start to stop: the thing a step limit counts steps of, an output-token ceiling bounds, and a workspace is chosen for. It is the vocabulary the product already uses in its own settings help ("Station stops an agent run once it has taken this many steps",
  `defaultMaxTurns` in `packages/contracts/src/settings-registry.ts`), and #2182 makes the Settings card that holds those controls say it too — **Agent runs**, not "Defaults". A run is carried by a **Session**, and where the two could both be said, Session names the execution episode Station records and Agent run names what the agent is doing inside it. **"Profile" never names this** (see Saved Stations, above), and neither does **"Agents"** — that word is the entity list at `/agents`, and a Settings strip cannot carry two rows reading "Agents" that go to different places.
- **Activity** — the one surface that lists this Station's Sessions (its own and read-only attached ones from other apps) to answer "what is running, what needs me, and what happened" ([the Activity list](../src-ui/src/views/SessionsView.tsx)). It groups by **state**, through the same classifier Home uses (`partitionSessionLanes` → `partitionHomeWorkItems`), never a second one: the lanes and their headings are that classifier's (`SESSION_LANE_ORDER`, `SESSION_LANE_LABELS`), live lanes first, then Just finished and Earlier — the same lane names as Home and the chat dock inbox, with each row's own time saying when. Kind (conversations or delegated tasks), project, and where work was started from (the recorded turn origin, "Started in <engine>" for an attached transcript, or "Origin not recorded" — never a guess) are **filters**, not groupings; the project filter's **No project** option lists the Sessions no project claims, including attached transcripts from a folder in no project's repository (#3386). A row's state word comes from the same fold as its lane, so a standalone row never contradicts its heading. A delegated **Run** is the one exception, and it says so: it renders in the most urgent lane any of its members is in, so a finished root can sit under a live lane because a subtask needs attention, and the run's label names that ("2 subtasks · 1 needs you"). An Activity status reports what Station recorded about a Session and is not proof the underlying work is correct.
- **Run** (delegated run) — a Session plus the delegated tasks it started, directly or through its own delegated tasks, shown together in Activity: the root row leads, and its **subtasks** fold under it with a count ("2 subtasks") and a per-state summary of those subtasks ([run grouping](../src-ui/src/views/sessions/run-groups.ts)). A task joins a run only through a recorded parent link (the parent's thread id, or a task id that matches exactly one scoped owner); shared characteristics never join unrelated work. Not the same as an **Agent run**, which is one agent's work inside one Session.
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
| `executionMode: 'runtime'` | **external**; the old value is retired, with no read-time normalization shim |
| `executionMode: 'provider-managed'` | **station**; the old value is retired, with no read-time normalization shim |

## Capabilities (Station agents own these; External agents can opt in to MCP or skills passthrough)

These extend **Station agents**; External agents bring their own (the app owns them) —
with two explicit, structurally identical exceptions, both off by default and never silent:

- **Skill** — a reusable bundle of instructions/behavior an agent adopts. THE one authored concept: a skill may declare itself runnable as a `/command`, which is what the retired "Prompt"/"Playbook" noun used to name. The word "playbook" survives only as accurate history (the `migrated-playbook` skill origin, `station doctor --migrate-playbooks`).
- **Integration** — an MCP server that exposes tools.
- **Tool** — one callable: a function from an integration, or a `station-control` platform function.
- **Command** — a slash command.
- **Plugin** — an installable platform extension (layouts, agents, integrations, providers, …).
- **Plugin visibility** — which installed plugins one principal may see and compose a Board or a personal agent from (#2067). Installation stays instance-wide: visibility is a *projection* of that one installed set onto one person, derived from the operator's grant record plus the live inventory, never a stored `visible` label. The operator sees everything; anybody else sees only what they have been granted, and a plugin outside their projection is absent from their plugin list rather than flagged. It is a listing and composition projection only — the execution authority for a plugin remains its permission grants, which every invocation rechecks.

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
  *Stations*; the affordances are "Connect a Station", "Edit Station", and
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

## Placement: Region, Surface, Layout, Pane, Pane host, Arrangement, Panel

Seven words for seven levels of the interface. Each names exactly one thing
that exists in source; [`docs/design/placement.md`](design/placement.md) is the
design record and `src-ui/src/__tests__/placement-vocabulary.test.ts` pins the
retired names.

- **Region** — a fixed shell slot: `main`, `left`, `right`, `bottom`
  (`REGION_IDS`). The shell owns their placement and chrome.
- **Surface** — a thing registered to occupy a region, with an id, title,
  icon, optional keyboard chord, default region and who offers it
  (`REGION_SURFACE_REGISTRY`; `exposure`). Chat, Activity and, since #2047,
  the docked Terminal, Diff and Files are surfaces; the last three are
  **catalog-only** — offered by a dock region's "+" (the **dock catalog**)
  rather than the toolbar, and bound to the dock's active project. "Surface"
  means this in the region model and its chrome; older prose still uses the
  lowercase word for any page or area, and the Kontour product Surface is
  always written with its product name. The navigable places the
  palette and sidebar send you to are **destinations**
  (`APP_DESTINATION_REGISTRY`).
- **Layout** — a named view the sidebar navigates between: Coding, Tasks,
  Session board, or a plugin's (`LayoutConfig`, a server record whose `type`
  selects the renderer). A Layout is owned by a project, a principal, or the
  Station instance (`LayoutOwner`; derive it with `layoutOwner`, never by
  reading `projectSlug`) — a principal-owned Layout is a **Board**
  ([design/shell-ownership-and-boards.md](design/shell-ownership-and-boards.md),
  decision D1). Use **Layout** for the product object and its
  chooser, editor, sources and persistence. Do not use it for the map of
  which surface sits in which region (that is the arrangement) or for the
  split/tab tree inside a view (that is a pane host). Lowercase "layout" may
  still describe spatial arrangement in developer prose, and internal widget
  names such as `SplitPaneLayout` describe implementation, not another
  product object. A project Layout may also be held by a dock region as a
  pane (`layout:<projectId>/<layoutId>`, #2157;
  [design/placement.md](design/placement.md)) — Coding and Chat kinds render
  in the main region only.
- **Board** — a Layout owned by a principal: the viewer's own, project-less
  page, listed in the left panel's `Boards` section between Activity and
  Projects and rendered by the same layout renderer a project Layout is
  (#2062; [design/shell-ownership-and-boards.md](design/shell-ownership-and-boards.md),
  decision D1). A Board can be **promoted** — MOVED into a project, where it
  becomes that project's Layout under the same id; the personal record is gone
  afterwards, so promote is never a copy. A Board may also be held by a dock
  region as a pane beside Chat (`board:<layoutId>`, #2157;
  [design/placement.md](design/placement.md)).

  Board has other qualified meanings in this codebase: the **Session Board** (`BUILTIN_SESSION_BOARD_LAYOUT`,
  a layout `type`) and the **board face** (`NavigationView`'s `board` member at
  `/board/task/…`, archive#4079) are unrelated objects that share the English
  word. A Board in the D1 sense routes at `/boards/:slug` and its view type is
  `personal-board`; prefer the qualified name in code.
- **Personal scope** — the fourth ownership scope, keyed by principal and
  stored server-side under the Station home (`layouts/personal/<principal-key>/`),
  so what a person owns follows them across their devices. It is the scope
  Boards live in, and it is neither of the two things "personal" used to mean
  in Station: not **instance** scope (which only reads as personal on a
  single-operator Station) and not **device** scope (the arrangement, which is
  a property of the screen you are sitting at). Reached over HTTP at
  `/api/me/*`, where no path segment, body field or query parameter names a
  principal — the owner comes from the request's own authentication, which is
  what makes one person's records unaddressable by another.

  Instance-owned Layouts are a sibling scope that exists in the contract
  (`LayoutOwner`'s `{kind:'instance'}`) and in storage (`layouts/instance/`)
  and has no route, no client and no UI: "instance-shared Boards" are designed
  (D1) and not shipped.
- **Pane** — the smallest addressable UI unit; what plugins contribute
  (`WorkspacePaneDescriptor` and its instances). A pane hosts content such as
  chat, files, terminal, or a plugin contribution, and knows nothing about
  where it is. Use **Workspace Pane** when a developer contract needs to
  distinguish this extension point from an ordinary UI area.
- **Pane host** — a tree of panes arranged as `split` and `tabs` nodes, inside
  a region or a layout (`WorkspacePaneHost`; persisted as a
  `WorkspacePaneHostDocument`). A tab group is a container inside a pane host,
  not a layout. The legacy plugin `layout.json` `tabs` array maps onto a pane
  host whose root is one tab group.
- **Arrangement** — the user's placement choices: which surface occupies
  which region, each region's size and visibility, which region (at most one,
  never `main`) is maximized, and each pane host's tree
  (`RegionArrangement` for the region half). It is persisted per device (the
  `regionArrangement` device setting): a property of the screen you are
  sitting at, never of a project or a layout.
- **Panel** — a bounded visual grouping of controls or information within a
  page or pane, such as a Trust panel or inspector panel. A Panel is not
  persisted and is not a synonym for a pane.

> **Composition:** the **shell** has regions; a region holds a **surface**;
> a surface or a layout holds a **pane host**; a pane host holds **panes** in
> tab groups and splits; a pane or page may hold **panels**. The user's choices
> across all of that are the **arrangement**.

## Shell kernel and distribution manifests (designed, not built)

These terms name accepted design in
[design/shell-plugins-distributions.md](design/shell-plugins-distributions.md).
Nothing computes them yet except where an entry says so. Use them only for
that design until their slices ship.

- **Distribution** — always qualify it. **Release distribution** is how Station
  binaries reach users: trains and channels
  ([ADR 0020](adr/0020-distribution-two-trains-channels-as-pointers.md)). A
  **distribution profile** is the layout-catalog policy that exists today
  (`DistributionProfile`; [guide](guides/distribution-profiles.md)). A
  **distribution manifest** is a designed plugin package. It pins plugins and
  keys, and sets defaults, setup, branding and policy for a Station. Its
  catalog section produces a distribution profile.
- **Kernel** — the fixed part of the shell: the plugin host and installer,
  trust and grant records, sign-in, pairing and connection recovery, Settings
  and the plugin manager, server-side authority over agent actions and
  approvals, safe mode, and the required slots. Everything else a user works
  in is a plugin contribution. Do not use "core" for this.
- **Required slot** — a kernel position that always has a filler, such as
  Home. A distribution manifest or the operator may override the default
  filler but never remove it. A failed or removed override falls back to the
  default filler. Today's Home-role grant is the existing partial case
  ([`workspace-home-role.ts`](../packages/contracts/src/workspace-home-role.ts)).
- **Safe mode** — a kernel boot state that loads no plugin browser code and
  shows sign-in, Settings and the plugin manager. It is not built. It is
  unrelated to the `--safe-mode` flag that `station triage` passes to the
  Claude CLI.
- **Layout subject** — the project a Layout is *about*, separate from its
  owner (`LayoutOwner`). A project layout's subject is its project; a Board
  has none; a personal project layout is principal-owned with a project
  subject. No subject field exists yet.

## Browser pane, live surface, control lease

The design began in
[ADR 0019](adr/0019-host-the-browser-pane-server-side-behind-a-host-adapter.md).
The current code composes the Browser pane and live-surface routes on personal
hosts; hosted tenant runtimes do not mount those routes. The ADR retains its
original design and verification gaps and is not a current availability report.

Use the [Browser workspace guide](guides/browser-workspace.md) for acquisition,
profiles, target access and Agent permissions, the
[Device guide](guides/mobile-device-workspace.md) for simulator/emulator setup,
and the [module map](architecture/module-map.md#shared-live-surface) for shared
frame, input and lifecycle ownership.

- **Browser pane** — a Workspace Pane that displays a browser session running
  on the Station host. Authorized Devices view its streamed frames. The
  Station operator can view and control sessions across profiles; active
  Project admins and owners are restricted to sessions in their own profile.
  Agent operations need a separately verified grant. Pane state `2.0` stores
  the Project ID and browser-session reference. Opening a legacy `1.0` Browser
  Preview record restores or opens a server session for its URL and saves the
  new reference after attachment.
- **Live surface** — the host-neutral primitive behind a streamed pane: one
  producer's frames fanned out to any number of viewers, a typed input
  channel, and a control lease. Browser and Device sessions use it. It is a
  developer-contract term. Always write it as the
  two-word phrase. It is **not** a placement **Surface** (a thing that
  occupies a region) and it is not the Kontour product Surface. Never shorten
  it to "surface".
- **Control lease** — the right to send input to a live surface. At most one
  holder (a human on one Device or an agent Session) controls it at a time;
  watching needs no lease. Human input can claim control when its observed
  **epoch** is current; a stale epoch is refused. The epoch advances when a
  different controller takes over, not when the same holder renews or returns
  after a lapse. A separate **fence** advances on every holder change,
  including release and expiry, so work from an earlier claim cannot become
  valid when the same agent reclaims control. An agent cannot preempt a live
  human lease. The holder can release it explicitly (the Browser pane's driver chip,
  **Hand back to agent**); otherwise a human hold lapses. A keep-alive (sent
  while a person is shown a page's held dialog) is not input: it extends only
  their own current hold, capped from their last real input. Viewing and
  controlling are authorized separately.

Follow the implementation through
[runtime composition](../src-server/runtime/routes/runtime-routes.ts),
[pane state and migration](../src-ui/src/workspace-panes/BrowserPreviewWorkspacePane.tsx),
[browser authorization](../src-server/services/browser/browser-live-surfaces.ts),
and the [lease state machine](../src-server/services/live-surface/control-lease.ts).
The [runtime route tests](../src-server/runtime/routes/__tests__/runtime-routes-live-surface.test.ts)
exercise caller admission and the hosted-mode boundary; the
[lease tests](../src-server/services/live-surface/__tests__/control-lease.test.ts)
cover takeover, stale input, renewal, release, and expiry. These checks do not
establish physical-device operation, browser availability on every host, or
release delivery.

## User-facing labels

| Concept | Show to users |
|---|---|
| agent run by Station's engine | **"Station" engine chip** + agent name |
| agent run by an external engine (incl. ACP) | **engine chip** naming the engine ("Claude Code", "Codex", "OpenCode · GLM-4.7") |
| A configured LLM endpoint | **Model connection** (Connections › Models) |
| A configured agent CLI or custom engine | **Engine** (Connections › Engines) |
| A selectable inference option within a connection | **Model** |
| This device's saved binding to one Station | **Station** (verbs: Add / Edit / **Forget**) |
| A project's named view | **Layout** |
| A place at the edge of the window a surface can occupy | **Region** |
| A thing that can occupy a region (Chat, Activity) | **Surface** |
| The smallest addressable unit of workspace UI | **Pane** (developer contract: **Workspace Pane**) |
| Visual grouping inside a page or pane | **Panel** |
| The one place listing what needs a person's decision (tool approvals, device pairing, proposed changes, paused gate reviews) | **Notifications** (the **attention inbox**; the footer bell counts its pending items) |
| Durable work identity | **Task** |
| Execution episode | **Session** |
| One agent working through a request from start to stop | **Agent run** (the Settings card is **Agent runs**) |
| An authored instruction a user or agent can reuse (some are runnable as `/command`) | **Skill** — the page is **Skills** (`/guidance`, with a Commands tab) |
| `missing_prerequisites` | name what's missing (e.g. "AWS credentials required") |

## Persisted identity records

- **`config/agent-registry.json`** — the sole authority for engine-connection identity and its owned default Agent. An external connection and its default Agent intentionally share the same clean text ID while remaining distinct typed namespaces (`EngineConnectionId` and `AgentId`).
- **`station`** — the persisted, non-deletable default Agent. Its engine is selected in Station settings, separately from the Agent record. There is no hidden `default` alias.
- Default Agents are records, not readiness projections. Disabled, degraded, disconnected, and unprobed engines retain their Agent; availability is an explicit field and reason.

## Rename status

This is the current vocabulary. The
[home-schema gate](../packages/shared/src/station-home-schema.ts) checks
compatibility before application data is loaded. At schema version `2`, a
home with existing data but no valid marker, or a version below `2`, requires
explicit archive-and-reset (`STATION_HOME_RESET_REQUIRED`). A home from a
newer schema instead fails with `STATION_HOME_SCHEMA_DOWNGRADE_REFUSED`; it
is not treated as a reset candidate. Fresh, recognized bootstrap scaffolding
can receive the current marker. The production migration registry is empty.
See the [schema tests](../packages/shared/src/__tests__/station-home-schema.test.ts)
and [reset command](reference/cli.md#home-reset) for the separate outcomes.

- **User-facing labels:** the Connections tab owns the noun (#592) — **Model
  connection** on the Models tab, **Engine** on the Engines tab, **Model** for
  the option selected within a connection. Station/external and model/agent
  distinctions remain execution properties.
- **Guidance → Skills (#2144):** the page a reader reaches at `/guidance` is
  labelled **Skills** — in Customize, in the command palette, and
  as its own `h1`. The rename is user-facing only: the `/guidance` route, the
  `guidance` navigation view, the `guidance` destination id and the tab memory
  key are unchanged, `/skills` still redirects to `/guidance?tab=skills`, and
  "guidance" survives as a palette keyword so the retired word still finds the
  surface. Commands remains a tab on that page, not a separate label.
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
