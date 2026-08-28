# Design: Entity Hierarchy & Navigation Restructure

**Status:** Draft (updated) — **direction superseded in part:** the agent-type taxonomy
this doc is built on (Station/managed vs External/connected as a *type system*) is being
dissolved by the agent–engine unification; see
[`agent-engine-unification.md`](agent-engine-unification.md) (tracking issue #893) for
the target model. This doc remains the shipped-behavior contract for each boundary until
the slice that moves that boundary lands, and is revised in the same commits (standing
rule). **#894 (2026-07-26):** the badge/label reflection of the two-type taxonomy has
already shipped out from under this doc — every agent surface now renders an **engine
chip** (not a Station/External/ACP badge), the Connections hub has an "Engines" section,
and the new-chat picker groups by engine. The *type system* itself (the editor's
Station-agent/External-agent split, `executionClass`, the two-tab editor shape) remains
shipped behavior as described below until slices 5-6 replace it with an engine picker.
**Slice 5 (station#975, 2026-07-27):** the editor half of the type system is now also
superseded — the "Station agent"/"External agent" `<select>` is gone, replaced by an
engine picker (`#ae-engine`) that lists Station plus every enabled external engine
connection; editor tabs (including the new Prompt tab) are derived per-agent from the
`EngineCapabilityMatrix` (`packages/contracts/src/engine-capability-matrix.ts`), not a
fixed per-`AgentType` set. `AgentType`/`resolveAgentTypeFromRuntimeConnection` remained
in code (validator + registry consumers) at that point — their retirement was slice 6.
**Slice 6 (station#1003, 2026-07-27):** `AgentType`/`resolveAgentTypeFromRuntimeConnection`
are retired outright (the matrix-driven `resolveEngineCapabilityMatrix` and
`requiresAgentPromptForRuntime` are the sole replacements), and `executionClass` is
replaced by `engineId: string` engine identity everywhere in this doc's boundary
diagrams below — the `AgentType`/`executionClass` snippet in "Add agent type to
`AgentSpec`" further down is retained only as the historical pre-unification sketch it
always was.
**Date:** 2026-03-27 (revised 2026-04-05; unification note 2026-07-26; #894 status note 2026-07-26; #975 status note 2026-07-27; #1003 status note 2026-07-27)
**Author:** Brian Anderson + Station
**Depends on:** `.plans/01-connected-agents-overhaul.md`, `.plans/03-connections-runtime-ux.md`
**Reference:** a surveyed provider/orchestration architecture (internal competitive notes)

---

## Problem

Station's core entities (agents, skills, integrations, layouts, plugins) lack a consistent lifecycle model and the UI treats them as peers when they have a clear parent-child hierarchy.

### Current issues

1. **Skills bypass managed patterns.** A `skill-service.ts` file exists but still uses a module-level `Map` with raw filesystem operations — not the `AgentService`/`ConfigLoader` pattern everything else follows. No CRUD routes, no ConfigLoader persistence.

2. **No entity hierarchy.** The sidebar and Agents Hub present agents, skills, prompts, and layouts as equal top-level concepts. Skills and integrations are capabilities *of agents*. Layouts are views *of projects*. The UI doesn't reflect this.

3. **No per-project agent scoping.** `ProjectConfig.agents?: string[]` exists in shared types but the UI doesn't use it. Every agent appears everywhere. **Superseded (station#1004, unification slice 7, 2026-07-27):** shipped, and widened past a filter — `AgentSpec.project` now supports true agent OWNERSHIP, not just opt-in visibility. `agent-engine-unification.md` §3.3 is the availability-boundary contract: `ProjectConfig.agents` still governs which GLOBAL agents a project opts into, but a project-owned agent (`project: '<slug>'` on the record) ignores that filter entirely — implicitly available in its own project, absent everywhere else (including the global/no-project context). Deleting the owning project orphans its agents visibly (a validation state naming the missing project) rather than deleting them.

4. **Inconsistent install lifecycle.** Agent install goes through `IAgentRegistryProvider` with proper provider pattern. Skill install is raw `fs` copy + directory re-scan. No unified registry experience.

5. **No validation on assignment.** `AgentSpec.skills[]` accepts arbitrary strings with no validation that the skill names resolve to installed skills. Same for integration references.

6. **No runtime model distinction.** The agent editor treats all agents the same, but managed agents (Bedrock + Strands/VoltAgent) and connected agents (Claude, Codex, ACP) have fundamentally different configuration surfaces.

---

## Runtime Model

Station supports two categories of agent with different ownership boundaries. This distinction drives the entire entity hierarchy and editor design.

### Managed agents (Bedrock + Strands/VoltAgent)

Station owns everything: system prompt, skills, MCP tools, commands, model selection. This is the extensible agent platform — plugins contribute capabilities here.

- Full agent configuration: prompt, skills, tools, commands
- Model selection from configured model connections (Bedrock, Ollama, OpenAI-compat)
- Skills and integrations are assignable per-agent
- The entity-hierarchy's full story applies here

### Connected agents (Claude, Codex, ACP, future CLIs)

The native runtime owns behavior. Station owns abstraction and presentation. Aligned with the surveyed reference architecture's rule and Plan 01: "Native runtime owns behavior, Station owns abstraction."

- **Claude/Codex**: Station selects the runtime, sets model + provider-specific knobs (effort, thinking, context window, fast mode, sandbox, approval policy), and provides `cwd`. The runtime manages its own tools, system prompt, MCP servers, and skills (via `CLAUDE.md`, `.codex/` config, etc. in the working directory).
- **ACP**: Station connects to an external agent runtime. Connection + mode = agent. Predetermined capabilities.
- Primarily for built-in coding workflows with proper abstractions for extensibility
- No system prompt injection, no MCP injection, no skill assignment from Station

### Provider-specific configuration (from the surveyed reference contracts)

```
Claude:  model, effort (low/medium/high/max), thinking (on/off), context window, fast mode
Codex:   model, reasoning effort (low/medium/high/xhigh), fast mode
ACP:     connection target, mode
```

### Why this matters

The agent editor, the entity hierarchy, and the Connections page all depend on this distinction. Skills and tools are only assignable to managed agents. Connected agents get a runtime settings surface instead. The UI must reflect what the app actually controls.

---

## Proposed Hierarchy

```
Registry (browse + discover)
  └─ Global Install (on the machine, available to configure)
       ├─ Skills        ─┐
       ├─ Integrations   ├─ assigned to MANAGED agents only
       └─ Agents ────────┘
            ├─ Managed agents (built-in, fully configurable)
            └─ Connected agents (runtime-backed, coding workflows)
                 └─ all assigned TO projects
                      └─ Projects (contain layouts)

Connections (configured backends — per Plan 03)
  ├─ Model Connections (Bedrock, Ollama, OpenAI-compat)
  └─ Runtime Connections (Claude, Codex, ACP)
```

### Key principles

- **Skills and integrations are managed-agent capabilities, with two explicit-opt-in exceptions.** They define what a managed agent can do; connected/External agents own their own capabilities by default. Both revisions live in `docs/design/connections-onboarding.md` §5, and both are off by default — never silent: (1) an ACP-connected agent's connection can explicitly opt in (`ACPConnectionConfig.provideToolServers`) to receiving Station's stdio MCP tool servers inside its own sessions — a wire-only passthrough that never touches the user's working tree; (2) the claude-runtime connection can explicitly opt in (`AgentConnectionSettings.config.provideSkills`) to having its selected Station skills materialized as real `SKILL.md` directory copies into the session's `.claude/skills/`, with a Station-owned manifest, refuse-to-overwrite, and cleanup that only ever removes files Station itself wrote and that are still byte-identical to what it wrote. Both are capability *passthrough*, not Station executing inside the agent's loop — the agent app still owns behavior, permissioning, and (for tool servers) which passthrough tools it actually calls.
- **Agents are members of projects.** A project selects which agents (both managed and connected) are available within it.
- **Layouts are views of projects.** Managed within the project context, not as standalone entities.
- **Global install ≠ active.** Installing from the registry makes something available to configure. It doesn't automatically appear in every agent or project.
- **Registry is the admin surface.** One place to browse, install, and manage what's available on the machine.
- **Connections is the backend surface.** One place to configure and test all external AI backends (model connections + runtime connections). Per Plan 03.

---

## UI Changes

### Sidebar

```
Projects (with layouts nested)
  └─ New Project
──────────────
Agents
Playbooks       ← Renamed from "Prompts"
Registry        ← Unified browse/install for agents, skills, integrations, plugins
Connections     ← Model + Runtime + Knowledge + Tool connections (per Plan 03)
Plugins         ← Post-install configuration
Schedule
Monitoring
```

**Removed from sidebar:**
- Skills (managed in agent editor for managed agents)
- Layouts as standalone (managed in project editor)

### Agents page

**Before:** AgentsHub — flat dashboard with agents, skills, and prompts as peer sections.

**After:** Agent list view. Shows all agents (managed + connected) with create/edit/delete. Each agent shows its type and a summary line:
- Managed: model name
- Connected: runtime + model (e.g., "Claude · claude-sonnet-4-6")
- ACP: connection name + mode

### Agent editor (varies by type)

**Managed agent** (Bedrock + Strands/VoltAgent):
```
Tabs:
  Basic       ─ name, description, icon, system prompt, model
  Skills      ─ toggle installed skills on/off for this agent
                 "Install from Registry" action for skills not yet installed
  Tools       ─ MCP servers, built-in tools, auto-approve (exists today)
  Commands    ─ slash commands (exists today)
```

**Connected agent** (Claude, Codex):
```
Tabs:
  Basic       ─ name, description, icon
  Runtime     ─ runtime connection, model, provider-specific options
               (effort, thinking, context window, fast mode, sandbox, approval policy)
               Link to Connections page for runtime configuration/testing
```

**ACP agent:**
```
Tabs:
  Basic       ─ name, description, icon
  Connection  ─ ACP target, mode (read-only summary of external agent)
```

The Skills tab shows all globally installed skills with toggles (managed agents only). Assigning a skill validates it exists. An inline "Install from Registry" flow lets you install + assign without leaving the editor.

### Project editor

```
Project settings:
  Basic       ─ name, icon, description
  Agents      ─ which agents are available in this project (multi-select, both managed + connected)
  Layouts     ─ add/remove/reorder layouts for this project
```

If a project doesn't specify agents, all agents are available (backward compatible). Specifying agents is an opt-in filter.

### Project creation flow

New project wizard:
1. Name, icon, description
2. Select agents available in this project
3. Add initial layouts

### Registry page

Unified browse/install surface with tabs:

```
Registry:
  Agents        ─ browse + install agent packages
  Skills        ─ browse + install skills
  Integrations  ─ browse + install MCP servers
  Plugins       ─ browse + install plugins
```

Each tab shows available (from registry providers) and installed items. Install/uninstall/update actions. Replaces the current scattered install UIs across AgentsHub, SkillsView, IntegrationsView, and PluginManagementView.

### Connections page (per Plan 03)

Unified backend-management surface with sections:

```
Connections:
  Model Connections     ─ Bedrock, Ollama, OpenAI-compatible
  Runtime Connections   ─ Claude Runtime, Codex Runtime, ACP
  Knowledge Connections ─ LanceDB, etc.
  Tool Servers          ─ MCP server infrastructure
```

Each connection shows status, prerequisites, capabilities. Shared detail shell with subtype-specific forms. This is where you configure and test backends — not where you assign them to agents (that's the agent editor).

### Playbooks

**Superseded (Playbooks→Skills merge, ADR-0016; slice 4, 2026-08-23):** there is
no Playbooks entity and no Playbooks page. There is ONE authored concept, a
**Skill**, and a skill may declare itself runnable as a `/command`. Skills live
under Guidance (`/guidance?tab=skills`); the retired `/playbooks` and `/prompts`
paths redirect there. Everything the rest of this section and §4 below describe
— the `Playbook` type, the `/api/playbooks` routes, the `usePlaybooksQuery`
hooks, the prompt→playbook compat aliases — has been DELETED with no alias.

Historical text follows: renamed from "Prompts." Standalone page stays —
playbooks are reusable across agents and have their own identity.

---

## Backend Changes

### 1. Skill service normalization

Promote skills to the same managed pattern as agents:

- **`SkillService` class** with constructor injection, replacing module-level functions and global `Map`
- **ConfigLoader methods:** `saveSkill()`, `listSkills()`, `loadSkill()`, `deleteSkill()`
- **Managed config:** `skills/<name>/skill.json` alongside `SKILL.md` (tracks install metadata, version, source)
- **Validation:** `AgentSpec.skills[]` entries validated against installed skills at save time
- **CRUD routes:** `GET/POST/PUT/DELETE /api/skills/:id` following agent route patterns

### 2. Project agent assignment ✅ (type landed)

`ProjectConfig` already has `agents?: string[]` in shared types.

Remaining work:
- Add agent picker to project editor and creation flow
- Filter agent selector/chat by project assignment
- Default: all agents available (no breaking change)

### 3. Unified registry routes

Consolidate or standardize registry routes:

```
GET    /api/registry/:type              ← list available (type = agents|skills|integrations|plugins)
GET    /api/registry/:type/installed    ← list installed
POST   /api/registry/:type/install      ← install from registry
DELETE /api/registry/:type/:id          ← uninstall
POST   /api/registry/:type/:id/update   ← update
```

All types use the same `IRegistryProvider` interface pattern.

### 4. Prompt → Playbook rename

- Rename `Prompt` type to `Playbook` in shared types
- Update API routes: `/api/prompts` → `/api/playbooks`
- Update SDK hooks: `usePromptsQuery` → `usePlaybooksQuery`
- Update UI components and navigation
- Keep backward compat aliases if plugins depend on old names

### 5. Agent type awareness

Add agent type to `AgentSpec` or derive it from configuration:

```typescript
type AgentType = 'managed' | 'connected';
type AgentRuntimeKind = 'bedrock' | 'claude' | 'codex' | 'acp';
```

The agent editor, agent list, and project assignment UI all need to know the agent type to render the correct configuration surface.

---

## Migration Plan

Phases are ordered by dependency and risk. Each phase is independently shippable.

### Phase 1: Skill service normalization

**Goal:** Skills follow the same managed pattern as agents.

- [ ] Refactor `skill-service.ts` into a proper `SkillService` class with constructor injection
- [ ] Add ConfigLoader methods: `saveSkill()`, `listSkills()`, `loadSkill()`, `deleteSkill()`
- [ ] Add `skill.json` metadata alongside existing `SKILL.md` files
- [ ] Add CRUD routes: `GET/POST/PUT/DELETE /api/skills/:id`
- [ ] Add validation on `AgentSpec.skills[]` save (reject unknown skill names)
- [ ] Auto-discover and register existing skills on first startup

**No UI changes.** Backend only. Existing skills continue to work.

**Exit criteria:** Skills have the same service/config/route pattern as agents. `AgentSpec.skills[]` rejects invalid names.

### Phase 2: Merge connected-agents-hardening branch

**Goal:** Connection model and runtime abstractions land on main.

- [ ] Review and merge `feature/connected-agents-hardening` (Plans 01-04)
- [ ] Verify `ConnectionService`, `/api/connections/*` routes, `ConnectionConfig` types
- [ ] Verify `AgentExecutionConfig` on `AgentSpec` for connected agents
- [ ] Verify agent editor Execution section renders for connected agents
- [ ] Verify ConnectionsHub shows Model + Runtime connections

**Exit criteria:** Connections page works. Agent editor has runtime settings for connected agents. Plan 03 Phase 1-2 complete.

### Phase 3: UI restructure

**Goal:** Sidebar and navigation reflect the entity hierarchy.

- [ ] Rename Prompts → Playbooks throughout (types, routes, SDK hooks, UI)
- [ ] Simplify AgentsHub → Agent list (remove skills/prompts sections)
- [ ] Add agent type indicator to agent list (managed vs connected + runtime summary)
- [ ] Make agent editor tabs conditional on agent type (Skills/Tools/Commands for managed only; Runtime for connected)
- [ ] Remove standalone Skills page (fold into agent editor + registry)
- [ ] Remove standalone Layouts page (fold into project editor)
- [ ] Create unified Registry page (tabs: Agents | Skills | Integrations | Plugins)
- [ ] Update sidebar nav items to match target

**Exit criteria:** Sidebar matches the target layout. Agent editor varies by type. Registry is the single install surface.

### Phase 4: Project agent assignment

**Goal:** Projects scope which agents are available.

- [ ] Add agent picker to project editor (multi-select, both managed + connected)
- [ ] Add agent step to project creation wizard
- [ ] Filter agent selector in chat by project assignment
- [ ] Filter layout agent pickers by project assignment
- [ ] Default: all agents available when `agents` is unset (backward compatible)

**Exit criteria:** Projects can restrict which agents appear. Existing projects unaffected.

### Phase 5: Cleanup

**Goal:** Remove dead code and consolidate patterns.

- [ ] Remove orphaned routes and views (old AgentsHub sections, standalone Skills/Layouts)
- [ ] Consolidate registry route patterns under `/api/registry/:type`
- [ ] Remove backward compat aliases after one release cycle
- [ ] Update documentation (README, guides, AGENTS.md)

**Exit criteria:** No dead code. One registry pattern. Docs current.

---

## Decisions

### D1: Agent categories — managed vs connected

Managed agents (Bedrock + Strands/VoltAgent) are fully configurable by Station. Connected agents (Claude, Codex, ACP) are external runtimes where the native runtime owns behavior. Station controls model selection and runtime-specific knobs but does not inject system prompts, MCP servers, or skills. Aligned with the surveyed reference architecture and Plan 01's rule: "Native runtime owns behavior, Station owns abstraction."

### D2: Connections page (revised from original "Connections → Providers")

Keep "Connections" as the canonical user-facing term. Connections is the single surface for all external AI backends — model connections, runtime connections, knowledge connections, tool servers. Per Plan 03. Do NOT rename to "Providers."

### D3: Plugins page

Keep separate. Registry handles install for all entity types (including plugins), but Plugins retains its own page for post-install configuration (settings, overrides, enable/disable). Plugins have richer config than other entities.

### D4: Playbook-agent association

**Superseded by the Playbooks→Skills merge (ADR-0016; slice 4, 2026-08-23).**
The association survives, on the Skill, and it is now two independent facts
rather than one toggle (`SkillCommand` in
`@kontourai/station-contracts/catalog`):

- `command.global` — "offered in every agent's chat without being attached".
- `agent.skills` naming the skill — the attachment itself, written by the agent
  editor and read by the same derivation
  (`isSkillCommandOfferedTo`, `src-ui/src/utils/skill-commands.ts`).

They are deliberately not collapsed: one switch would make "attached to these
agents only" inexpressible. Note the defect the old design carried — the
playbook-era rule read the PLAYBOOK's own `agent` field and never the agent's
own binding list, so attaching one to an agent changed nothing (CAT-R08).

Historical text follows: Both. Playbooks can be globally available (appear for
all agents) OR assigned to specific agents. "Global" toggle, on by default.
When toggled off, an agent multi-select appears. Most playbooks are global —
that's the zero-config path.

### D5: Registry provider interfaces

Use inheritance. A base `IRegistryProvider` interface with the common `listAvailable()`, `listInstalled()`, `install()`, `uninstall()`, `update()` contract. Type-specific interfaces extend it for additional methods.

### D6: ACP agents and project scoping

Global by default. ACP agents appear in all projects. Revisit if users need to restrict connected agents to specific projects.

### D7: Registry page layout

Tabs per entity type (Agents | Skills | Integrations | Plugins). Each type has different metadata and actions, so tabs give each its own context.

### D8: Skill settings/configuration

Toggle only (on/off per managed agent) for now. No per-agent skill configuration. If a skill needs different behavior per agent, the agent's system prompt provides that context.

### D9: Agent editor varies by type

The agent editor renders different tabs based on agent type. Managed agents get Skills/Tools/Commands. Connected agents get Runtime settings. ACP agents get Connection info. This reflects what the app actually controls per agent type.

### D10: Runtime settings scope (per the surveyed reference)

Runtime settings (model, effort, thinking, etc.) live at the agent level as defaults. Sessions resolve execution at creation time. Chat UI displays execution state read-only — it does not own runtime selection. Per Plan 03 §7 and §11.

---

## Landed items

- `ProjectConfig.agents?: string[]` — shared type exists, UI not yet wired
- `skill-service.ts` — file exists, needs normalization to class + ConfigLoader pattern
- `IAgentRegistryProvider`, `ISkillRegistryProvider` — separate interfaces exist, no common base yet
- `ConnectionConfig`, `ConnectionService`, `/api/connections/*` — on `feature/connected-agents-hardening` branch
- `AgentExecutionConfig` on `AgentSpec` — on `feature/connected-agents-hardening` branch
- `IProviderAdapterRegistry`, `providerAdapter` additive type — on `feature/connected-agents-hardening` branch
