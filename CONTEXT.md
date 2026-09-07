# Station Context

Station is Kontour's reference agent runtime: a local-first agent workspace where work ships with receipts. It is the place where agent work happens under evidence, process, and governance rather than being trusted because the agent says it is done.

This file is the broad domain glossary for the whole repo. `docs/glossary.md` is the compact product-label reference for user-facing names and retired wording; when a user-facing label conflicts, `docs/glossary.md` wins and this file should be updated to match it.

## Codebase design

Before changing a caller family, use the [Module map](docs/architecture/module-map.md). It records the intended Module, its caller Interface, the composition Seam, concrete Adapters, and the real test surface. Preserve depth: hide sequencing, storage, and provider detail behind an intent-shaped Interface; do not replace that locality with raw stores, callback bags, or post-construction setters.

## Language

### Product Identity

**Station**:
Kontour's local-first agent workspace and reference runtime. Station hosts agent work, observes it, gates completion, and preserves receipts.
_Avoid_: generic workbench

**Kontour primitive**:
A standalone Kontour product that Station consumes through its published contract. Surface, Flow, Veritas, Survey, Flow Agents, Console, and Kontour UI are primitives, not Station internals.
_Avoid_: internal dependency, privileged integration

**Published contract**:
The public shape Station is allowed to consume from a Kontour primitive: package exports, CLIs, MCP servers, file formats, documented HTTP surfaces, or versioned resource shapes.
_Avoid_: sibling repo internals

**Station core**:
The foundational runtime, routing, streaming, storage, provider registry, and platform substrate that lets plugins and layouts run. Station core should stay vendor-neutral and should not own vertical domain semantics.
_Avoid_: product brain, vertical logic

**Station surface**:
A user-facing workspace view where a person observes or directs work. A surface may be a layout, a plugin-provided vertical, a built-in panel, or a hosted MCP-UI panel.
_Avoid_: page, screen, dashboard when the trust context matters

**Evidence-shaped workspace**:
A Station surface where claims, evidence, gate verdicts, and receipts are visible in the workflow itself. This is Station's product shape, not decorative chrome.
_Avoid_: flexible workspace when the evidence layer is the point

**Local-first workspace**:
A Station installation where user data, agent sessions, evidence, reports, plugin state, and project state live on the user's machine by default.
_Avoid_: cloud workspace unless a deployment explicitly changes ownership

### Work And Receipts

**Work**:
An agent-assisted activity that can be inspected after the fact. In Station, work should end as passed evidence, an explicit exception, or NOT_VERIFIED.
_Avoid_: task when the evidence lifecycle matters

**Task**:
A durable, user-addressable work identity in Station. A Task belongs to a Project, may retain an exact workspace binding and typed references, and can outlive any individual agent session. Creating a direct chat or Session does not silently create a Task.
_Avoid_: chat, session, or inferred work item

**Task workspace**:
The `/tasks/:taskId` Station surface that reopens one Task's identity, workspace binding, references, changed files, receipts, and available execution correlation. The surface composes published capabilities; it does not take ownership of Flow, Builder, Knowledge, or Console semantics.
_Avoid_: session detail, project layout

**Task workspace binding**:
Station's captured identity snapshot for the Project working directory and, when present, its Git top-level, worktree, and branch. Station derives the authoritative binding from current Project and Git state, records whether reopening is `available`, `ambiguous`, or `unavailable`, and never treats caller-supplied paths as proof.
_Avoid_: arbitrary cwd, trusted client path

**Task reference**:
A typed relation from a Task to an artifact, receipt, external item, file, session, run, or other supported entity. References preserve exact identity; title or path similarity is not correlation.
_Avoid_: attachment when relation type and provenance matter

**Agent session**:
A bounded episode of agent work in Station. An agent session can be run by a Station agent or by an External agent, and can be associated with a project, a layout, an agent, and a Flow run.
_Avoid_: chat when the lifecycle matters

**Turn**:
One user-to-agent interaction inside an agent session. A turn may stream text, reasoning, tool calls, approvals, and terminal or artifact events.
_Avoid_: message when the runtime lifecycle matters

**Run**:
A tracked execution instance from orchestration or scheduling. A run has status, retry eligibility, attempt count, output references, and failure classification.
_Avoid_: session when referring to execution accounting

**Agent run**:
An orchestration-backed run tied to an agent session. It records which provider or agent app produced the work and whether it was a Station-agent or External-agent execution path.
_Avoid_: Flow run unless referring to evidence gates

**Scheduled run**:
A run produced by a scheduled job rather than an interactive agent session.
_Avoid_: cron entry when referring to execution output

**Flow run**:
The evidence-gated process record for work. A Flow run owns the gate path, verdicts, route-back state, exceptions, and reports for a piece of work.
_Avoid_: task status, checklist

**Gate**:
A condition in a Flow run that must be satisfied by evidence, routed back, blocked, or explicitly excepted. A gate is about work readiness, not agent confidence.
_Avoid_: approval if the result is computed from evidence

**Gate verdict**:
The outcome of evaluating a gate or run. Station uses pass, wait, route-back, block, and exception paths rather than treating completion prose as proof.
_Avoid_: done, success, green unless evidence-backed

**Evidence**:
An artifact that supports or refutes a claim about work. Evidence can come from commands, files, tests, readiness checks, human attestations, trust artifacts, platform mutations, or hosted-panel tool calls.
_Avoid_: note, log, proof when the artifact has not been evaluated

**Command evidence**:
Evidence derived from a command or tool execution result. Station attaches command evidence to Flow runs when the command output can satisfy or explain a gate.
_Avoid_: console output when it is being used as a receipt

**Readiness evidence**:
Evidence derived from Veritas merge readiness. Station asserts a `governance.merge-readiness` claim over the Veritas evidence record because Flow does not natively accept Veritas records as trust artifacts.
_Avoid_: Veritas MCP evidence

**Receipt**:
The durable record that connects a claim, its evidence, and the resulting verdict. A receipt is what lets a future reader inspect why work was allowed to continue.
_Avoid_: summary, transcript

**Report**:
A rendered artifact for a Flow run or verification process. A report is a receipt presentation, not the source of truth if the structured evidence is available.
_Avoid_: proof by itself

**Route-back**:
A gate outcome that sends the work back to an earlier or more specific recovery step. Route-back means the work can continue, but not as complete.
_Avoid_: failure if the process defines a retry path

**Exception**:
A human-accepted override of missing or failing evidence. An exception is explicit debt in the receipt trail, not a silent bypass.
_Avoid_: skip, ignore, force-pass

**NOT_VERIFIED**:
The required statement when a claim has not been checked. NOT_VERIFIED is an honest state, not a failure by itself.
_Avoid_: probably, should be fine

### Agents And Connections

**Agent**:
The actor a user selects to perform work. Its role, capabilities, and policy
are distinct from the engine that runs it.
_Avoid_: runtime as a user-facing category

**Station agent**:
The reserved built-in Agent named Station. It owns Station Control and Station
Docs by default; a separate Station setting selects the capable engine that
executes it.
_Avoid_: managed agent

**External agent**:
An Agent executed by an external engine such as Claude Code, Codex, or Kiro.
Station owns the surrounding workspace and orchestration; the engine owns its
loop and native behavior.
_Avoid_: connected agent, ACP agent as a separate type, Agent app

**Station's engine**:
Station's native agent execution machinery over a Model connection. It can run
the built-in Station agent or another Agent, and is distinct from external
engines.
_Avoid_: runtime engine

**Connection**:
A configured backend that gives Station access to either a Model or an engine. Connections are named by what they provide, not by vendor.
_Avoid_: provider when the distinction matters

**Model**:
An LLM endpoint used by Station agents. Bedrock, OpenAI-compatible endpoints, and Ollama are Models.
_Avoid_: Agent app

**Engine**:
What executes an agent: Claude Code, Codex, a command-backed CLI (OpenCode, Kiro), or Station's own engine (VoltAgent/Strands driving a Model connection). Station's engine keeps its name — it is one engine among peers, not a privileged type. Every resolved agent shows an engine chip naming its engine.
_Avoid_: runtime, provider, Agent app (retired — absorbed into Engine)

**Engine connection**:
An external agent program that runs its own loop, configured as a connection: Claude Code, Codex, and Kiro are engine connections; ACP is one connection method for an engine, not an agent type.
_Avoid_: runtime connection in user-facing text, Agent app

**ACP connection**:
A connection to an external engine through Agent Client Protocol. ACP lets Station drive a separate process as an External agent while preserving Station's session, streaming, approval, and persistence model. ACP is a transport detail only — never shown to users, who see the engine's name (or the "Command-backed engine" fallback when the name is unresolved).
_Avoid_: ACP agent as a third category, showing "ACP" in user-facing labels

**ACP adapter**:
The single provider adapter that satisfies Station's canonical adapter interface for all ACP connections. Connection processes, probing, and protocol handling are its implementation; orchestration sees one `acp` provider kind, with the target connection carried in session metadata.
_Avoid_: ACP bridge, per-connection adapter

**Virtual agent**:
An agent entry synthesized from an engine connection or ACP mode. It lets a user pick a concrete external mode without making Station own that mode's behavior.
_Avoid_: installed Station agent

**Provider**:
A concrete backend adapter or plugin contribution that satisfies a Station extension point. Provider is an implementation role; user-facing copy should prefer Model, Engine, Plugin, Integration, or Registry item when those are the actual concepts.
_Avoid_: backend as a catch-all when the configured thing has a precise name

**Capability**:
Something Station can attach to a Station agent. Skills, integrations, tools, and commands are capabilities of Station agents only.
_Avoid_: feature when assignment semantics matter

**Skill**:
A reusable instruction or behavior bundle a Station agent can adopt. A skill may
declare itself runnable as a `/command`; that is one authored concept with an
extra affordance, not a second one.
_Avoid_: prompt, playbook

**Integration**:
An MCP server or similar tool source that exposes tools to Station agents.
_Avoid_: plugin when it only contributes tools

**Tool**:
One callable operation available through an integration or through station-control.
_Avoid_: integration when referring to a single call

**Command**:
A slash command or named instruction entry point.
_Avoid_: tool unless it invokes a callable tool

**Guardrail**:
A limit or behavior constraint applied to a Station agent, such as token budget, temperature, stop sequences, or max steps.
_Avoid_: policy when it is a model execution setting

**Delegation**:
A controlled agent-to-agent handoff. Delegation has depth, parent session, allowed or blocked tools, and approval restrictions.
_Avoid_: subtask if the agent relationship matters

**Delegation context**:
The metadata that keeps delegated work tied to its parent agent session and prevents unbounded delegation.
_Avoid_: child prompt

### Session Lifecycle And Events

**Session lifecycle**:
The Station-owned state machine for an agent session: queued, running, needs input, review pending, blocked, completed, failed, or canceled.
_Avoid_: provider status when Station is tracking lifecycle

**Lifecycle transition**:
A state change in a session lifecycle, with a source and reason. Transitions are constrained so terminal states and illegal jumps are explicit.
_Avoid_: status update when the transition rules matter

**Transition source**:
The origin of a lifecycle transition: runtime behavior, user action, or system recovery.
_Avoid_: actor when the lifecycle source is enough

**Transition reason**:
The explanation for a lifecycle transition, such as turn completed, approval requested, runtime error, user canceled, or system recovered.
_Avoid_: free-form status text when the reason belongs to the lifecycle vocabulary

**Canonical runtime event**:
Station's normalized event shape for all agent apps and Station-agent execution paths. It lets Station apply the same session, evidence, policy, and Console projection logic across different execution sources.
_Avoid_: provider-specific event when crossing Station seams

**Plan update**:
A canonical runtime event describing an agent's current plan entries and their statuses. Plan updates are app-neutral and rendered by Station's typed plan surface rather than flattened into reasoning text.
_Avoid_: reasoning text when plan structure is available

**Extension event**:
A canonical runtime event carrying an agent app's namespaced, app-specific payload without canonical semantics. Extension events let an app surface extra behavior while keeping the canonical contract app-neutral.
_Avoid_: custom chunk, provider-specific event type

**Session board item**:
A summarized view of an agent session or terminal process for monitoring, navigation, and recovery.
_Avoid_: chat row when lifecycle and retry state matter

**Pending review**:
A session state where output or proposed changes are waiting on human decision before the work can continue or be considered complete.
_Avoid_: approval if the review is about work output rather than a tool call

**Blocked reason**:
The explicit cause that prevents a session from progressing. A blocked reason should tell the user what external input or recovery step is needed.
_Avoid_: error if the session can resume

### Projects, Layouts, And Navigation

**Project**:
A scoped workspace where Station associates files, layouts, agents, knowledge, runs, and receipts.
_Avoid_: repo when the workspace may not be only a Git repository

**Working directory**:
The filesystem location a project uses for file-backed work. It is project state, not necessarily the whole Station home.
_Avoid_: project if referring only to a path

**Project agent scope**:
The set of agents available in a project. If a project does not specify agents, all agents remain available for compatibility.
_Avoid_: global agent list when the project has its own scope

**Layout**:
A project view or standalone workspace surface. Layouts are how Station presents work context; they are not top-level products by themselves.
_Avoid_: page when plugin composition matters

**Layout tab**:
A named area inside a layout. A tab can host plugin-provided content, a built-in Station surface, or an MCP-UI panel.
_Avoid_: route when it is layout-local

**Layout action**:
A user-visible action attached to a layout or tab. It can launch a skill, inline instruction, internal Station action, or external link.
_Avoid_: command if it is not a slash command

**Layout component reference**:
The structured reference that tells Station what kind of content a layout tab hosts: plugin component, built-in component, or MCP-UI tool panel.
_Avoid_: string component name when the layout mixes host types

**Built-in layout surface**:
A Station-provided surface that layouts can mount without a plugin entrypoint, such as the default coding surface or Flow run console.
_Avoid_: core-only page

**Navigation restore**:
Station's behavior of returning the root route to the last project and layout the user viewed. Project layout navigation must persist the selected project and layout, not only change the URL.
_Avoid_: route push when project-layout state must persist

### Registry, Plugins, And Install Lifecycle

**Registry**:
The browse and install surface for agents, skills, integrations, plugins, and layouts. Registry install makes something available; it does not automatically activate it everywhere.
_Avoid_: marketplace when local install semantics matter

**Registry item**:
An installable or installed catalog entry. Registry items have lifecycle states such as draft, installable, installed, disabled, update available, or removed.
_Avoid_: plugin when the item may be an agent, skill, integration, or layout

**Registry lifecycle**:
The state model that determines whether a registry item can be installed, updated, disabled, or removed.
_Avoid_: install status if update and removal semantics matter

**Plugin**:
An installable Station extension that can contribute layouts, agents, integrations, providers, knowledge namespaces, settings, and server-side behavior.
_Avoid_: integration if it contributes more than tools

**Plugin manifest**:
The declarative file that names a plugin, version, settings, capabilities, permissions, dependencies, and contributed assets.
_Avoid_: package metadata when Station install behavior depends on it

**Plugin dependency**:
Another plugin a plugin requires to function. Dependencies are resolved during install rather than assumed to be globally present.
_Avoid_: npm dependency

**Plugin setting**:
A user-configurable plugin value persisted by Station and passed into plugin provider factories.
_Avoid_: environment variable unless it is truly process-level

**Plugin consent tier**:
The permission tier for a plugin: passive, active, or trusted. Consent tier communicates the expected risk and authority of the plugin's contributions.
_Avoid_: permission string when discussing user trust

**Plugin provider**:
A server-side contribution from a plugin into a Station provider registry, such as auth, branding, registry source, scheduler, notification, model, embedding, vector database, layout type, ACP connection, template, or settings.
_Avoid_: plugin if only the extension point matters

**Plugin preview**:
The install-time inspection of a plugin manifest, contributed components, and conflicts before Station writes installation state.
_Avoid_: dry run if conflicts and components are the point

**Conflict**:
A discovered install-time collision between a plugin contribution and an existing agent, workspace, provider, or tool.
_Avoid_: validation error if the user can resolve or accept it

### Platform Control, Approvals, And Proposed Changes

**station-control**:
Station's platform-control integration for agent-visible platform operations. Mutating station-control operations are governed work and should produce receipts when routed through gated sessions.
_Avoid_: admin backdoor

**Platform mutation**:
An agent-visible operation that changes Station state, project state, plugin state, agent configuration, or other platform configuration.
_Avoid_: tool call when the governance concern is mutation

**Approval request**:
A request for human consent before an action proceeds. Tool calls, registry installs, and MCP-UI tool calls can all route through approval machinery.
_Avoid_: review when the decision is only about allowing an action

**Approval inbox**:
The Station surface and persistence model for pending approvals. It records what needs a decision and how the decision was resolved.
_Avoid_: notification if the item requires a decision

**Approval policy**:
The rule that decides whether a tool or hosted panel call can proceed automatically, must ask, or is denied.
_Avoid_: guardrail when it specifically gates an action

**Proposed change**:
A file or content change suggested by an agent or system and awaiting a decision. Proposed changes can be create, modify, delete, or rename operations.
_Avoid_: diff if the decision lifecycle matters

**Proposed change decision**:
A human, agent, or system decision to approve, reject, or supersede a proposed change.
_Avoid_: review comment

**Superseded change**:
A proposed change replaced by a newer proposal. Superseding preserves decision history without pretending the older proposal is still pending.
_Avoid_: deleted proposal

### Trust Primitives And Governance

**Surface**:
The Kontour primitive for claims, evidence, trust bundles, trust reports, and trust state.
_Avoid_: Station trust engine

**Trust bundle**:
A Surface artifact containing claims, evidence, policies, and events. Station reads trust bundles and renders their state; Surface owns their semantics.
_Avoid_: readiness record

**Trust report**:
A Surface projection over a trust bundle, including claim status and transparency gaps. It is a readable trust-state surface.
_Avoid_: source bundle

**Transparency gap**:
A missing, stale, or insufficient evidence condition identified in trust state. Gaps are meant to be visible rather than hidden behind summary status.
_Avoid_: warning if it affects trust state

**Flow**:
The Kontour primitive for evidence-gated processes, gates, route-back, exceptions, and reports.
_Avoid_: Station workflow engine

**Flow definition**:
The declared process path and expectations a Flow run follows. A definition describes the gates and evidence shape, not the agent implementation.
_Avoid_: checklist

**Veritas**:
The Kontour primitive for repo standards and merge readiness. Veritas is consumed by Station through readiness output and evidence records, not through a Veritas MCP server.
_Avoid_: Surface, Flow

**Merge readiness**:
The Veritas-derived state of whether a repository change satisfies the configured standards. In Station, merge readiness is visible in the workspace and can be attached to Flow gates as readiness evidence.
_Avoid_: CI status when governance standards are included

**Repo standard**:
A Veritas-governed rule or expectation about a repository. Station's own protected standards are human-owned and should not be weakened without attestation.
_Avoid_: lint rule if the standard governs more than syntax

**Governance surface**:
The set of Veritas artifacts, standards, evidence, and policy checks Station uses to govern its own changes.
_Avoid_: compliance folder

**Policy change attestation**:
The record required when protected standards change. It makes governance changes explicit instead of silent.
_Avoid_: config edit when the policy surface is protected

**Survey**:
The Kontour primitive for review chains and review workbenches.
_Avoid_: generic review UI

**Review chain**:
A Survey-governed sequence of review decisions and evidence. Station can host review surfaces but Survey owns the review semantics.
_Avoid_: approval chain unless it only allows actions

**Flow Agents**:
The Kontour primitive for agent process discipline, policy classes, workflow sidecars, and canonical skills.
_Avoid_: Station's own policy language

**Policy class**:
A Flow Agents enforcement category such as workflow steering, quality gate, stop-goal-fit, or config protection.
_Avoid_: hook when discussing product semantics

**Workflow sidecar**:
A file-backed Flow Agents state record that lets workflow state survive session handoff, compaction, and agent app switches.
_Avoid_: session memory when it is process state

**Canonical skill**:
A Flow Agents skill distributed as a reusable skill bundle. Station serves canonical skills to Station agents without rewriting their meaning.
_Avoid_: Station-authored skill when it is consumed from Flow Agents

**Console**:
The Kontour operating-plane primitive for cross-product projections. Console is the enterprise/cross-product view; Station keeps the session-context workspace.
_Avoid_: Station replacement

**Console projection**:
A cross-product operating-state view derived from emitted records. It is not the interactive Station workspace.
_Avoid_: embedded Station UI

**Kontour UI**:
The shared design-system primitive for Kontour-facing surfaces.
_Avoid_: Console Kit in current documentation, except historical notes

### Hosted Panels, MCP, And UI Bridge

**MCP server**:
A Model Context Protocol server that exposes tools or resources. In Station, MCP servers usually appear as integrations.
_Avoid_: plugin unless Station installs it as a plugin

**MCP-UI server**:
An MCP server that serves a rendered panel resource for hosts to display. Kontour MCP-UI servers are a distribution path for trust surfaces.
_Avoid_: Station-only panel

**MCP-UI host**:
A host that renders MCP-UI resources inside a contained frame. Station is an MCP-UI host, but the host does not make the rendered server trusted.
_Avoid_: trusted embed by default

**MCP-UI panel**:
A rendered resource from an MCP-UI server. A panel can display data and may request host-mediated tool or resource access.
_Avoid_: iframe if discussing product behavior

**Host bridge**:
The message channel between an MCP-UI panel and Station. The bridge mediates initialization, sizing, resource reads, tool calls, and display-mode requests.
_Avoid_: direct tool execution

**Embedded dialect**:
The older MCP-UI pattern where a tool result contains a `ui://` resource instead of declaring a resource URI up front. Station supports it for compatibility under stricter assumptions.
_Avoid_: SEP-1865 if the resource comes from a tool result

**Display mode**:
How an MCP-UI panel asks to be shown: inline, fullscreen, or picture-in-picture. Display mode is a host presentation decision.
_Avoid_: route mode

**UI block**:
A chat-native structured UI element rendered by Station. UI blocks are distinct from MCP-UI panels, which are hosted external resources.
_Avoid_: MCP-UI panel

### Knowledge, Scheduling, Notifications, And Voice

**Knowledge namespace**:
A project-scoped knowledge collection with behavior such as retrieval-augmented search or prompt injection. Plugins can contribute namespaces.
_Avoid_: folder if behavior and indexing matter

**RAG namespace**:
A knowledge namespace searched semantically and returned as relevant context.
_Avoid_: injected rules

**Injected namespace**:
A knowledge namespace whose content is inserted as steering or rules rather than searched by similarity.
_Avoid_: RAG if all content is always included

**Knowledge document**:
A stored knowledge item with source, path, namespace, chunk count, metadata, and enhancement status.
_Avoid_: file when it has ingestion metadata

**Knowledge enhancement**:
An agent-assisted transformation from raw knowledge to enhanced knowledge.
_Avoid_: rewrite if Station tracks source and output status

**Scheduled job**:
A configured recurring or manual job that invokes agent work on a schedule and records job logs.
_Avoid_: cron string when discussing Station behavior

**Scheduler provider**:
A plugin or built-in scheduler implementation that runs jobs and reports capabilities such as artifacts, notifications, daemon behavior, working directory support, or command support.
_Avoid_: scheduler if the implementation can vary

**Job log**:
The durable record of a scheduled job execution, including success, duration, attempts, missed count, output, and error.
_Avoid_: console output if it is persisted as job history

**Notification**:
A surfaced event meant to inform the user. A notification may come from polling providers or system events, but it is not necessarily a decision request.
_Avoid_: approval request when the user must decide

**Notification provider**:
A plugin or built-in contributor that polls for notifications and hands them to Station's notification service.
_Avoid_: event source if it contributes user-facing notifications

**Voice session**:
A speech-to-speech interaction with a voice provider. Voice is maintained as a Station capability but is not on the trust-critical path.
_Avoid_: chat session if audio transport and voice tools matter

**Voice provider**:
A speech-to-speech backend connected through Station's provider model.
_Avoid_: model when the provider handles audio session behavior

### Files, Terminals, Isolation, And Portability

**Terminal process**:
A Station-managed terminal with project, cwd, status, process id, exit code, history, and subprocess state.
_Avoid_: shell if Station is tracking lifecycle

**File tree**:
The project file browsing and editing surface. File tree state is part of Station's project workspace, not a trust claim by itself.
_Avoid_: source of truth unless the file is the artifact being governed

**Workspace isolation**:
The policy for whether an agent session works in a shared workspace or an isolated Git worktree.
_Avoid_: sandbox when the isolation unit is the workspace

**Shared workspace**:
The isolation mode where a session works directly in the project's working directory.
_Avoid_: default safety if concurrent edits can collide

**Worktree isolation**:
The isolation mode where Station provisions a Git worktree for a session, with branch and cleanup policy.
_Avoid_: copy if Git worktree semantics matter

**Cleanup policy**:
The rule for whether an isolated worktree should be cleaned up or preserved after completion or failure.
_Avoid_: delete flag

**Portable configuration**:
Station configuration that can be exported, imported, versioned, or recreated without depending on a private machine state.
_Avoid_: backup when the goal is reproducibility

**Resource shape**:
The Kontour convention of `apiVersion`, `kind`, `metadata`, `spec`, `status`, and `proof` for cross-product artifacts.
_Avoid_: JSON blob when interoperability matters

### Observability And Verification

**Telemetry**:
OpenTelemetry counters, histograms, traces, and attributes that describe meaningful Station operations and outcomes.
_Avoid_: logging when the signal is intended for metrics

**Metric**:
A named telemetry instrument under the `station.*` namespace. New runtime behavior should count success, fallback, retry, degraded, and error paths where meaningful.
_Avoid_: console log

**Verification lane**:
A named, rerunnable command or test bucket that proves a behavior. Verification lanes are more durable than one-off manual checks.
_Avoid_: smoke note if it cannot be rerun

**Static gate**:
The non-Playwright verification gate covering rename inventory, lint, typecheck, manifest checks, and unit tests.
_Avoid_: docs-only check if type/unit failures can still block it

**Full verification gate**:
The no-shortcuts gate that includes static checks and full Playwright coverage.
_Avoid_: quick test

**Rename inventory**:
The zero-tolerance check that retired product names do not reappear in live files.
_Avoid_: grep if referring to the enforced gate

**Veritas shadow**:
The working-tree readiness check Station runs for AI governance. It may fail on evidence checks, standards checks, or protected-policy issues.
_Avoid_: advisory lint when it blocks governance readiness

### Extraction And Product Boundaries

**Extraction candidate**:
A Station subsystem that might become a standalone Kontour product after demand proves it has more than one consumer.
_Avoid_: product before there is a second consumer

**Second consumer**:
A real non-Station consumer asking for a Station subsystem. A second consumer is required before extraction becomes a product decision.
_Avoid_: hypothetical market signal

**Promotion gate**:
The S5 criteria for extracting a subsystem: second consumer, public-shaped contract, self-carried verification, and measurable Station thinning.
_Avoid_: checklist if any criterion is optional

**Station thinning**:
The measurable reduction of Station-owned surface when a subsystem becomes a dependency or is pruned.
_Avoid_: rewrite if Station keeps a parallel copy

**Prune proposal**:
An evidence-backed proposal to remove or quarantine a subsystem that has not earned its maintenance cost.
_Avoid_: cleanup if it deletes working product surface

**Upstream proposal**:
A request to change a Kontour primitive where the capability belongs in that primitive's public contract rather than Station.
_Avoid_: local workaround when every consumer should benefit

## Flagged Ambiguities

**Runtime**:
Retired in user-facing language. Use Station's engine for Station-run loops, engine (or engine connection) for external loops, Station core for the server/platform, and External agents for app-run agents.

**Prompt** / **Playbook**:
Both are retired in user-facing language for reusable instruction assets — there
is one authored concept, a Skill. Use prompt only when referring to raw model
input (an agent's system prompt, a turn's text). "Playbook" now survives only as
accurate history: the `migrated-playbook` skill origin and the one-shot
`station doctor --migrate-playbooks` helper.

**Managed / connected / ACP agent**:
Use Station agent and External agent in product language; every resolved agent additionally shows an engine chip naming its engine. Managed, connected, and ACP may still appear in internal identifiers during the scheduled data-model migration.

**Provider**:
Provider is overloaded. Prefer Model, Engine, plugin provider, scheduler provider, notification provider, embedding provider, or vector database provider.

**Done**:
Ambiguous unless tied to evidence. Use gate verdict, receipt, exception, completed lifecycle state, or NOT_VERIFIED.

**Approval / review / gate**:
Approval allows an action, review decides on output, and a gate evaluates evidence. Do not collapse these into one word.

**Run / session / Flow run**:
An agent session is the conversation/work episode, a run is execution accounting, and a Flow run is the evidence-gated process record.

**Knowledge / memory / sidecar**:
Knowledge is project content for agent context, memory is conversation or stored state, and a workflow sidecar is Flow Agents process state.

**Workbench**:
Too generic for Station positioning. Use Station surface, layout, or a specific primitive surface such as Survey Review Workbench.

**Dashboard**:
Use Console projection for cross-product operating state, Flow run console for session-context gate state, and Station surface for interactive workspace views.

**MCP integration / MCP-UI panel**:
An MCP integration exposes tools or resources; an MCP-UI panel is rendered content served through MCP. A server can do both.

## Relationships

- Station consumes Kontour primitives through published contracts only.
- A Project has zero or more Layouts and can scope which Agents are available.
- A Project has zero or more durable Tasks; a Task may correlate exact Sessions, runs, artifacts, and receipts without becoming any of them.
- A Task workspace binding is revalidated when opened. `ambiguous` and `unavailable` bindings remain visible as identity history but cannot authorize local inspection.
- A Layout contains Layout tabs; each tab hosts a plugin component, built-in layout surface, or MCP-UI panel.
- An Agent is exactly one of Station agent or External agent.
- A Station agent uses a Model and may use Skills, Integrations, Tools, Commands, Guardrails, and Delegation.
- An External agent is backed by an engine connection; ACP is only one way to connect to that engine.
- A Virtual agent can represent a mode or direct-chat path for an engine connection.
- An Agent session may create an Agent run, emit Canonical runtime events, and attach to a Flow run.
- A Flow run evaluates Gates against Evidence and produces Receipts and Reports.
- A Gate verdict can pass, wait, route-back, block, or be resolved by an Exception.
- A Proposed change belongs to a Project and Agent session and is resolved by a Proposed change decision.
- A Plugin can contribute layouts, agents, integrations, providers, knowledge namespaces, settings, and server behavior.
- A Registry item can become installed, disabled, update available, removed, or remain installable.
- A Knowledge namespace belongs to a project or plugin contribution and contains Knowledge documents.
- A Scheduled job produces Scheduled runs and Job logs.
- A Platform mutation should be governed when it is agent-visible or affects protected platform state.
- Surface describes trust state; Flow governs process; Veritas derives merge readiness; Survey structures review; Flow Agents supplies process discipline; Console projects operating state.
- Station may extract a subsystem only after a Second consumer proves demand and the Promotion gate is met.

## Example Dialogue

Developer: "Can the Codex runtime use Station skills?"

Domain expert: "Say External agent, not runtime. Codex is an engine, so it owns its own skills and tools. Station skills apply to Station agents only."

Developer: "The agent says the change is done."

Domain expert: "Done is not enough. Does the Flow run have a gate verdict with receipts, an explicit exception, or do we need to mark the claim NOT_VERIFIED?"

Developer: "This tool call needs review."

Domain expert: "If the question is whether to allow the action, call it an approval request. If the question is whether the resulting file change should be accepted, call it a proposed change decision. If the question is whether evidence satisfies process requirements, call it a gate verdict."

Developer: "Can Station call Veritas through MCP?"

Domain expert: "No. Veritas has no MCP server. Station consumes Veritas readiness output and evidence records; Surface can expose trust bundles through MCP."

Developer: "Should we move the MCP-UI host into a new package now?"

Domain expert: "Only if there is a second consumer and the promotion gate is met. Until then it is an extraction candidate, not a standalone product."

Developer: "The plugin installs a scheduler and a model provider."

Domain expert: "Say the plugin contributes a scheduler provider and a Model provider. The plugin is the installable unit; the providers are its extension-point contributions."

Developer: "A scheduled job failed. Is that a failed agent session?"

Domain expert: "It is a scheduled run failure. It may contain an agent session or agent run, but the scheduler owns the job log and retry accounting."
