# Station shipped documentation

This is the canonical prose served by the credential-free Station Docs MCP.
The build compiles these topics and the architecture module sections into static
content. The interactive learning library reads the same Markdown. This manual
describes the product, not a particular Station's live state. Topic metadata and
stable IDs are maintained in [the topic catalog](../learn/mcp-topics.json).

Update the owning implementation and tests when revising a claim. Run
`npm run docs:mcp:generate` after editing, then `npm run docs:mcp:check` to check
that the shipped content matches its sources. See [Learn Station](../learn/README.md)
for navigation and [the audit ledger](../plans/documentation-code-audit.md) for
remaining semantic review.

## What Station is

Station is an agent workspace for directing work, following execution, and
inspecting its results and available evidence.

An Agent's completion message is not proof that the requested outcome was
achieved. A Session or turn can complete without an evidence-gated workflow.
Flow gating is optional: the current start caller requires a Flow service, a
working directory, and an explicit non-retired `metadata.flowDefinition` before
attempting to attach a run. For attached work, inspect the actual gate verdicts,
evidence, exceptions, and unresolved checks. Report unverified claims plainly.

Station is local-first and does not require a cloud account for local operation. The Station-owned root defaults to `~/.station`; `STATION_HOME` selects one runtime home, such as `~/.station/instances/stable`. Persistence includes files and databases. Use the documented archive and recovery operations when moving a home; a directory copy is not automatically a consistent backup.

The core owns durable product responsibilities including Projects, Tasks, Sessions, authorization, execution, and evidence projection. Plugins extend the product through published contracts and admitted capabilities. The architecture learning tree explains these responsibilities and their interfaces; plugins do not acquire unrestricted access to core internals.

## These docs, and what they cannot do

`station-docs` serves this manual and the architecture topics as static content
compiled into Station. Its tools list topics, retrieve a topic, and search by
case-insensitive substring. They do not read user files, make network calls, or
require a credential at request time.

The returned version and documentation digest identify shipped content, not
live state. These tools cannot tell you which Agents exist, what is running,
what a job did, what a setting contains, or what is in a Project. Answer those
questions from an authorized live read, or state that only general
documentation is available.

`station-knowledge` is the separate data server for reading and capturing
Knowledge records. It requires caller authority; see [Knowledge agent tools](../guides/knowledge.md#agent-tools).

`station-control` is the separate built-in server for Station operations, such
as creating Agents, running jobs, changing settings, and validating a local
plugin folder. Installing a plugin through Station's agent tools is refused: a person approves its preview on the Plugins page or with `station plugin install <source>` (see the `plugin-authoring` topic).
Control calls need an instance credential and remain subject to caller
identity, Session ownership, authorization, and approval policy. Delivering a
tool server does not grant full access or operator authority.

Station Docs needs no credential, but it still needs a supported tool-server
delivery path and the genuine shipped server. For example, the Muse adapter has
no MCP tool-server delivery channel. An engine with docs and no `station-control` can explain Station operations
but cannot perform them through the docs tools. The [connection guide](../guides/connections.md) and
[Session API](session-api.md) describe engine capabilities and delivery limits.
Say which capabilities are actually available; do not imply an operation ran
because its documentation was retrieved.

## Projects

A Project is Station's unit of working context and durable work identity. It can organize Tasks, layouts, Agents, knowledge, and settings, with explicit resources and machine-local workspace bindings where needed. An organizational Project need not have a checkout; a Task or Session that requires files must resolve an authorized available workspace instead of inferring one from a similar name.

Projects scope Agent selection. A Project can filter global Agents, and an
Agent may name an owning Project. Project-owned Agents are excluded from global
selection. A missing owner can be surfaced as an orphan finding instead of
deleting the Agent; if the Project inventory could not be read, the catalog
omits that finding rather than treating an unknown inventory as empty.

Projects present themselves as layouts — arrangements of panels for a particular way of working. Layouts can come from Station or from plugins, so a project page can be a chat surface, a review workbench, a readiness console, or a domain-specific vertical.

Project resource resolution and a Task's captured workspace are different
records. The Task topic below describes the latter. See the
[system overview](../architecture.md) and [work board](../user/work-board.md)
for their ownership and navigation boundaries.

## Agents and engines

An Agent is the actor selected to do work. Its engine binding determines what
executes it and which authored capabilities Station can deliver.

Station's engine runs an Agent against a Model connection and supplies its
configured prompt, skills, tools, commands, and model within the runtime's
supported capabilities and policy.

An external engine — Claude Code, Codex, or a custom CLI engine such as OpenCode or Kiro — runs its own loop. There, the engine owns behavior and tools, and Station owns only the abstractions it can set for that engine (model, effort, thinking) plus whatever capabilities that engine has a channel to receive.

Engines use different transports, including native SDKs, headless processes,
and the Agent Client Protocol. The user-facing identity is the engine's name.
The runtime-owned Station Agent is a role, not a synonym for Station's engine;
its selected execution engine determines the available delivery mechanisms.

Each engine has a capability matrix for system prompts, tool servers, skills,
commands, and model selection. Requested authored content without a supported
delivery channel is reported as undelivered on the ordinary saved-binding path;
an absent request is not a failed delivery. An explicit conversation engine
override must preserve required profile delivery and refuses unsupported or
undelivered content instead of starting a reduced profile. See
[execution overrides](session-api.md#preserve-an-agent-profile-with-an-execution-override).

Use the [Agent guide](../guides/agents.md) and [Session API](session-api.md) for
current setup, capability, turn, idle, terminal, and recovery behavior. A matrix
entry describes a supported mechanism; it is not proof that a live engine
accepted a particular request.

## Connections

Connections separates Models and Engines. The Models tab contains Model connections; the Engines tab contains Engines. Choose the service or engine you recognize, then a model within it. Provider remains an implementation term, not the user-facing umbrella for both tabs.

A model connection is an LLM endpoint — a local Ollama, an OpenAI-compatible service, a gateway, or a cloud model service. It powers Station's own engine, which drives the inference loop itself.

An engine connection is how Station reaches an external engine that runs its
own loop. Station requests model and mode options supported by that engine and
projects its reported events; it must not promise that every engine accepts
the same model, effort, or thinking controls.

Station's engine drives a Model connection directly. External engines run
their own loops and may expose their own model catalogs. Their usable choices
come from the engine's capabilities and inventory, not the Model connection
list.

A configured, reachable local model is one credential-free option. Discovery, configuration, and readiness are different facts; inspect the Connections surface before assuming a detected service is ready for a conversation.

Startup can adopt detected Claude, Codex, and Muse engines with their default
Agents. An explicitly removed engine is not silently recreated. Adoption is
not credential or launch-readiness proof; use [Getting started](../user/getting-started.md)
and [Connections](../guides/connections.md) for that distinction.

## The built-in assistant, and what it needs

Station ships the reserved, non-deletable `station` Agent for operating the
workspace through Station Control. Its engine binding, model readiness, tool
delivery, and caller authority still determine which operations can proceed.

Its task guidance asks it to discover suitable installed skills and available
tools when useful, within the capabilities already supplied to it. Read-only
Station Control catalogs support that discovery where the engine can receive
them. This guidance installs nothing, enables nothing and grants no new access;
ordinary authored agents and direct CLI aliases retain their own configuration.


Its Station tools cannot install a plugin. An install is approved by a person who has read its preview — its permissions and the parts that run in Station’s own page — on the Plugins page or with `station plugin install <source>`. Asked to install one, the assistant points to that review. It proposes instead: `propose_plugin_install`, `update_plugin` and `remove_plugin` leave an ask that a person completes from Plugins.

That capability comes entirely from the `station-control` MCP tool server. `station-control` calls Station's own API, so it needs a credential for this running instance. A credential can only be handed to an engine over a channel that has been reviewed as not crossing the secret boundary.

Not every connected engine can deliver Station Control. Such an engine may
still chat, and may receive Station Docs if it has a supported tool-server
channel, but neither chat nor documentation access grants platform mutation
authority. These tool restrictions are not an operating-system sandbox; the
plugin-authoring topic retains that distinction for same-user shell access.

Inspect the engine picker's capability and readiness diagnostics before
starting the Station Agent. A connected engine can remain unable to deliver
its required control tools.

## Sessions, turns, and runs

A session is a bounded episode of agent work. It can be associated with a project, a layout, an agent, and an evidence-gated Flow run. Starting a direct chat creates a session; it does not silently create a durable Task.

A turn is one user-to-agent interaction inside a session. A turn may stream text, reasoning, tool calls, approval requests, and terminal or artifact events.

A run is the execution accounting: status, attempt count, retry eligibility, output references, and failure classification. An agent run is tied to an agent session; a scheduled run comes from a scheduled job instead of an interactive session.

Adapters project reported engine events into a shared canonical model.
Capabilities and available evidence still differ: an absent event, usage value,
or terminal result must not be invented to make engines look uniform. An idle
turn is not necessarily a terminal Session, and optional Flow gating must not
be inferred from ordinary execution completion.

## Tasks and the task workspace

A Task is a durable, user-addressable work identity belonging to a Project. It survives restarts and can span execution episodes. Sessions also retain persisted history; their purpose is to record an execution episode rather than own the durable work identity. A Task may correlate an exact Session, or none at all.

A task carries typed references — to files, artifacts, receipts, sessions, runs, or external work items — and those references preserve exact identity. Similar titles or paths are not treated as correlation.

The task workspace is the surface that reopens one task with its identity, workspace binding, changed files, artifacts, receipts, and session correlation in one place, so you can pick work back up without reconstructing context.

A Task's captured workspace is re-evaluated as `available`, `ambiguous`, or
`unavailable` when reopened. Available bindings permit the relevant local
inspection paths; changed or missing bindings preserve the recorded identity
without treating an old path as current authority. Dispatch has its own
readiness, ownership, admission, and durable reservation checks; an uncertain
remote start is not automatically safe to retry. See the
[work board](../user/work-board.md) and [Session API](session-api.md).

A task can also be dispatched: assign an agent or a skill to it and send it into a session. Task statuses follow a neutral work-item vocabulary (todo, ready, triage, in progress, blocked, review, verification, done), plus a canceled state for work abandoned before completion.

An agent on any engine can declare a pull request it opened with the Station Control `declare_pull_request` tool; a person keeps the declared pull request onto a Task. A person can also opt a Task in to closing when its pull requests merge: with that opt-in, the Task moves to done once every pull request kept on it is merged at its provider. A pull request closed without merging does not complete the Task, a Task in todo, ready, triage or blocked never closes by itself, and no agent tool sets the opt-in. Station checks when someone with permission to change Task status refreshes the conversation's pull request links; nothing polls. A declaration is recorded when the turn completes and is lost if Station restarts first.

## Scheduled jobs and notifications

A scheduled job can use a cron expression, a fixed interval (`every`), or a
one-time timestamp (`at`); manual runs are also supported. The built-in
scheduler invokes an Agent with unattended-deny approval policy and records
its scheduler outcome.
See the [scheduler API](api.md#scheduler) for exact inputs and outcomes.

Scheduler receipts describe the observed execution outcome. They do not attach
a Flow run or prove the requested business result by themselves. Inspect the
recorded output and any explicitly attached evidence workflow before claiming
unattended work achieved its goal.

Notifications are provider-based: subsystems and plugins contribute notifications that Station aggregates, persists, and delivers, so a long-running or scheduled piece of work can tell you it needs attention.

## Skills

A skill is a reusable bundle of instructions and behavior that an agent adopts — a way to give several agents the same competence without duplicating a prompt.

Skills are a capability Station owns for agents it runs. For an agent bound to an external engine, whether the skill reaches the engine depends on that engine having a delivery channel for skills. Some engines do; others do not.

When an engine has no channel for an authored skill, Station records that as undelivered rather than silently dropping it, and the agent editor shows the authored content read-only with a diagnostic naming the engine that cannot deliver it.

Explicit conversation engine overrides refuse undeliverable required skills
rather than starting without them. Saved Agent defaults remain unchanged.

Skills are installed and browsed from the registry, like agents and tool servers.

A skill can also declare itself runnable as a slash command, which is how a reusable instruction sequence is invoked directly in a chat or assigned to a task. There is one authored concept here, not two.

## MCP tool servers, integrations, and tools

Station speaks the Model Context Protocol for tools. An integration is an MCP server that exposes tools; a tool is one callable function from that server.

Two built-in servers serve different purposes here. `station-control` exposes
Station operations as tools; `station-docs` serves static shipped prose without
credentials or live state. This is not an exhaustive server inventory: the
[Station Browser MCP server](../../src-server/tools/station-browser-mcp-server.ts)
has its own delivery and authorization boundary.

Third-party MCP servers are configured as integrations and can be attached to an Agent. Delivery to an external engine follows that engine's transport and credential-custody policy; an empty environment does not grant a server arbitrary authority. The built-in Station Docs server has a verified runtime identity and no credential requirement. Station Control is a separate capability with its own authorization and delivery requirements.

Open an Agent's Tools section and choose **Station** or **Add**.
Expand an integration to search and choose Read only, All, None, or individual
tools. Choose a tool group to narrow the checklist; Read only, All, and None
apply to that group and preserve choices elsewhere. Station additions start
read-only where individual selection is supported.
The shield opens approvals; the gear opens harness settings. Browser and workflow
options are under Advanced. Changes apply to new chats.
Claude and Codex can keep their configured harness MCP integrations while adding
Station's selections. Claude also offers native on-demand tool loading. Generic
connected engines receive whole integrations and disclose unsupported restrictions.
The [Agent guide](../guides/agents.md#mcp-tool-configuration) owns setup and limits.

Mutating tools remain subject to their authorization and approval rules.
Inspect the specific tool result and the approval or execution evidence
available for that operation. A successful tool response alone does not prove
that a Flow receipt was persisted or that a gate passed. See the
[Session API](session-api.md) for the current request, decision, and evidence
surfaces.

## Trust, gates, evidence, and receipts

A gate is a condition that must be satisfied by evidence, routed back, blocked, or explicitly excepted. Gate verdicts are computed from evidence, not from an agent saying it finished.

Evidence is an artifact that supports or refutes a claim about work: command
output, files, test results, readiness checks, human attestations, or trust
artifacts. A receipt records an operation, decision, or evidence handoff. Read
its kind, owner, outcome, and references before deciding what it proves; an
execution receipt is not automatically a gate verdict.

Two outcomes are first-class and deliberately visible. A route-back means the work can continue but is not complete. An exception is a human-accepted override of missing or failing evidence — explicit debt in the receipt trail, never a silent bypass. And when something simply has not been checked, the honest statement is NOT_VERIFIED.

Flow process verdicts, Veritas readiness, and Surface trust-bundle semantics
belong to their respective owners. Station consumes their published contracts
alongside its own Session, Task, approval, and execution records. Keep those
authorities distinct and report missing or stale evidence. See the
[evidence context](../contexts/evidence-governance/CONTEXT.md).

## Fleet inference across Stations

People often run more than one Station: a laptop, a desktop with a GPU, a home server. Fleet inference is the capability that lets a Station borrow model capacity from another Station you control instead of every machine needing its own local model.

Contributing capacity is opt-in and off by default. A Station that opts in publishes a manifest describing exactly the subset of its models it is contributing; nothing is shared implicitly.

Fleet-enabled routing produces receipts describing considered candidates,
exclusions, and observed outcomes; serving has a separate receipt owner.
Snapshot loss or a receipt-write failure can leave a completed turn without a
routing receipt, with a diagnostic naming the gap. The Monitoring surface
renders retained routing and serving receipts. Their absence is not evidence
that nothing ran. See the [Fleet API](api.md#fleet-inference) for authorization,
request bounds, and serving limitations.

Reaching another Station is a relationship you set up deliberately — pairing a device or configuring an environment — not something that happens automatically because two Stations are on the same network.

## Plugins and the registry

Station's core owns durable product and authorization behavior as well as runtime composition, streaming, routing, and provider registration. Plugins add capabilities and work surfaces at the published extension boundaries.

A plugin is manifest-driven and can declare layouts, Agents, MCP integrations, providers, knowledge namespaces, engine connections, branding, and settings. Declaring a contribution is not authority to activate it: validation, permissions, grants, and host admission apply. Plugin authors use the published SDK and contracts; private core capabilities are not automatically available to a plugin.

The registry is the unified place to browse and install agents, skills, integrations, and plugins (a plugin only with a person’s approval of its preview), with an install lifecycle that includes updates and removal. Installs can route through approval, because installing something is a platform mutation like any other.

Station uses MCP for tool servers, ACP for supported external-engine
connections, OpenTelemetry for configured observability, and MCP-UI for
rendered tool resources. Each integration has its own supported mechanisms
and prerequisites.

MCP App frames have a separate resource-policy boundary. URL-scheme filtering
does not by itself establish complete CSP source-expression validation or
browser network containment. See [MCP Apps in Station](../design/mcp-ui-host.md)
for the current construction and isolation limits; ordinary tool availability
is not rendering qualification.

## Writing a plugin: manifest, Workspace Panes, SDK hooks, validation and install

This topic introduces two Workspace Pane contribution shapes. A plugin folder
contains a `plugin.json` manifest; an entrypoint-based pane also supplies React
source. Prebuilt browser bundles are supported too, so source-only packaging
is not a universal requirement. Use [Build your first plugin](../guides/build-your-first-plugin.md),
the [plugin guide](../guides/plugins.md), and the [SDK reference](sdk.md) for
the maintained build, dependency, permission, and API instructions.

A minimal plugin folder:
```text
my-pulse/
  plugin.json
  src/index.tsx
  src/pulse.css      (imported by index.tsx; drop the import if you have no CSS)
  package.json       (optional; see BUILD below)
```

THE MANIFEST. `plugin.json` is an Agent Plugins 1.0 document. The root holds only portable fields: `$schema`, `name`, `version`, `description` (and optionally `author`, `homepage`, `repository`, `license`, `keywords`). Everything Station-specific lives under `extensions["io.kontourai.station"]`: `schemaVersion` (always "1.0"), `title` (the display name), `entrypoint` (path to the React module, starting with "./"), `capabilities` (descriptive tags such as "chat" or "navigation"), `permissions` (what the plugin asks a person to grant) and `workspacePanes` (the panes it adds). Station fields placed at the root are ignored with a warning, and a root `layout` or `layouts` makes the manifest invalid.

A complete minimal manifest, one plugin-component pane that needs a Project:
```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-pulse",
  "version": "1.0.0",
  "description": "Live agent and integration status for a Project.",
  "extensions": {
    "io.kontourai.station": {
      "schemaVersion": "1.0",
      "title": "My Pulse",
      "entrypoint": "./src/index.tsx",
      "capabilities": ["chat", "navigation"],
      "permissions": ["navigation.dock"],
      "workspacePanes": [
        {
          "version": "1.0",
          "id": "pane:plugin%3Amy-pulse:pulse:workspace",
          "name": "My Pulse",
          "rendererId": "renderer:plugin%3Amy-pulse:plugin-component:my-pulse-workspace",
          "renderer": { "kind": "plugin-component", "name": "my-pulse-workspace" },
          "placement": { "supportedRegions": ["primary"], "preferredRegion": "primary" },
          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],
          "provenance": { "origin": "plugin", "pluginId": "my-pulse" },
          "lifecycle": { "stage": "stable" }
        }
      ]
    }
  }
}
```

NAMES AND IDS. `name` is the plugin id: 1-64 lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit, with no "--" or "..". Capability and permission entries are lowercase too; Station disables the whole extension when one has an uppercase letter or a space. Pane ids and renderer ids are opaque strings, but they are global across every installed plugin: follow the `pane:plugin%3A<plugin-name>:<group>:<name>` and `renderer:plugin%3A<plugin-name>:<renderer kind>:<name>` pattern above so yours cannot collide, write the parts you choose in lowercase, and give every pane its own `id` and its own `rendererId`.

PROVENANCE depends on the renderer kind. A "plugin-component" pane declares exactly `{ "origin": "plugin", "pluginId": "<your plugin name>" }`, with no `mcpServerId`. An "mcp-tool-ui" pane declares `{ "origin": "plugin", "pluginId": "<your plugin name>", "mcpServerId": "<serverId>" }`, where `<serverId>` is the same server id its `renderer.ref` names. Any other combination makes the pane invalid, and Station then disables the plugin's whole Station extension.

WORKSPACE PANE FIELDS:
- version: "1.0".
- name: what a person sees in Add pane.
- placement.supportedRegions: one or more of "primary", "secondary", "standalone", "docked". placement.preferredRegion, if given, must be one of them. placement.order is an optional number.
- modes: at least one entry, each with a unique `id`. A mode's contextRequirement sets any of these keys to `true` when the pane needs it: "project", "task", "session", "run", "workspace", "source". "default" with `{ "project": true }` means the pane is offered inside a Project.
- lifecycle.stage: one of "stable", "preview", "deprecated".
- Optional: description, icon, and requiredRendererCapabilities (see the mcp-tool-ui example).
- Refused: a top-level `contextRequirement` or `dockability` on the pane. Put the requirement inside a mode.

RENDERER KINDS. Use "plugin-component" when the pane is your own React UI: `renderer.name` must be a key of the `components` object your entrypoint exports, and the component runs in Station's page with the SDK available. Use "mcp-tool-ui" when the UI is served by a tool on an MCP tool server (an integration) Station has: the renderer is `{ "kind": "mcp-tool-ui", "ref": "<serverId>/<toolName>" }`, Station renders that tool's UI resource in a sandboxed frame, and no entrypoint is needed. Name the integration in `integrations.required` so the install preview shows whether it is present. Prefer "plugin-component" for panes that read Station data through SDK hooks; prefer "mcp-tool-ui" when the data and the UI already live behind an MCP server.

A complete minimal manifest, one mcp-tool-ui pane:
```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-activity",
  "version": "1.0.0",
  "description": "Session activity rendered by an MCP tool.",
  "extensions": {
    "io.kontourai.station": {
      "schemaVersion": "1.0",
      "title": "My Activity",
      "integrations": { "required": ["activity-mcp"] },
      "workspacePanes": [
        {
          "version": "1.0",
          "id": "pane:plugin%3Amy-activity:activity:panel",
          "name": "Activity",
          "rendererId": "renderer:plugin%3Amy-activity:mcp-tool-ui:activity-panel",
          "renderer": { "kind": "mcp-tool-ui", "ref": "activity-mcp/activity_panel" },
          "requiredRendererCapabilities": ["sandboxed-mcp-app"],
          "placement": { "supportedRegions": ["secondary", "standalone"], "preferredRegion": "secondary" },
          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],
          "provenance": { "origin": "plugin", "pluginId": "my-activity", "mcpServerId": "activity-mcp" },
          "lifecycle": { "stage": "stable" }
        }
      ]
    }
  }
}
```

THE ENTRYPOINT AND THE COMPONENTS EXPORT. The entrypoint exports a `components` object mapping each "plugin-component" renderer name to a React component. Component names are global across plugins too, so prefix them with the plugin name. React, the SDK and @tanstack/react-query are provided by Station at runtime; import them normally and never bundle your own copy.
```tsx
import { useAgents, useNavigation, useToast } from "@kontourai/station-sdk";
import "./pulse.css";
function MyPulse() {
  const agents = useAgents();
  const { setDockState } = useNavigation();
  const { showToast } = useToast();
  return (
    <main className="my-pulse">
      <h1>Agents</h1>
      <ul>{agents.map((agent) => <li key={agent.slug}>{agent.name}</li>)}</ul>
      <button type="button" onClick={() => { setDockState(true); showToast({ type: "info", message: "Chat opened" }); }}>
        Open chat
      </button>
    </main>
  );
}
export const components = { "my-pulse-workspace": MyPulse };
export default MyPulse;
```

SDK HOOKS A PANE CAN USE (all imported from "@kontourai/station-sdk"):
- useAgents() → Agent summaries in the current host context, each with `slug` and `name`; presence is not launch-readiness proof. useAgent(slug) returns one.
- useIntegrationsQuery() → a query result whose `data` lists the configured MCP tool servers (integrations).
- useOrchestrationSessionsQuery() → a query result whose `data` lists sessions.
- useProjects() / useProject(slug) → query results for the readable Project list or one Project; inspect `data`, loading and error state.
- useSendToChat(agentSlug) → a FUNCTION. Call it with a message: it opens a new chat with that agent in the dock and sends the message.
- useLaunchChat() → an async function that opens a chat and optionally sends an initial message; accepts Agent identity and optional Project/execution context. Use the SDK signature for the complete argument list.
- useNavigation() → `setDockState(open)` to open or close the chat dock, plus the current navigation state. useDockState() wraps just the dock.
- useToast() → `{ showToast }`; call `showToast({ type: "info" | "success" | "warning" | "error", message })`.
- useAuth() → the signed-in person and auth status.
- useServerFetch() → a function that fetches a URL through Station's server; it needs the "network.fetch" permission.
Query hooks follow @tanstack/react-query: read `data`, `isLoading` and `error`, and render a loading and an empty state.

PERMISSIONS. Declare only what the plugin uses. The complete list, by what granting it takes:
- passive (granted automatically at install): "navigation.dock"
- active (the person consents at install): "ui.confirm", "network.fetch", "agents.invoke", "tools.invoke"
- trusted (a separate host approval after install): "events.subscribe", "events.read-payload", "providers.register", "plugin.server", "system.config"
A permission Station does not recognise is treated as trusted, the strictest tier.

Grants are bound to reviewed content. Changed or unreadable installed bytes can
withhold all recorded permissions, including passive ones, until the host's
recovery/review path restores effective authority. A declared or pending
permission is not an active capability. See [plugin permissions](../guides/plugins.md#plugin-permissions).

BUILD. An entrypoint uses Station's esbuild path and produces `dist/bundle.js`
(plus CSS when imported). Without an entrypoint, the builder does not compile
source; a prebuilt bundle or a contribution with no browser UI has a different
path. Manifest-supplied shell build commands are rejected. Managed workspace
packages use the workspace's installed dependencies and `npm run dependencies:ci`;
standalone dependency setup uses a scoped npm install with lifecycle scripts
disabled. Do not run a plain npm install inside a managed Station workspace.
Follow the [build instructions](../guides/plugins.md) for the exact package
layout and commands rather than treating a dependency list as a complete build.

VALIDATE BEFORE ASKING FOR AN INSTALL. If you have `station-control`, call `validate_plugin` with the absolute path of the plugin folder. It checks local folders only: it refuses git URLs and network paths (UNC or /net/…), so copy a plugin to a local folder first. It runs part of what the install preview checks and reports each problem as a diagnostic: manifest errors, an io.kontourai.station extension Station would disable (which silently drops every pane), unsafe prompt files, pane ids already taken by another plugin, and a missing entrypoint. It does not resolve plugin dependencies (it warns `dependencies-not-checked` when you declare any) and it does not build the bundle, so a TypeScript or import error only shows at install; typecheck locally first. `valid: true` means no error-level diagnostic, not a guaranteed install. Fix every error and validate again before handing the plugin over.

INSTALL IS A PERSON'S DECISION. Agents must not install plugins, and `install_plugin` refuses. What an agent can do is propose: call `propose_plugin_install` with the absolute folder path (or a git URL: https://host/path or git@host:path, with no credentials, port, query or fragment) and a rationale. Station records a proposal and changes nothing else. The person sees it in Needs attention, and opening it takes them to the ordinary preview, which names the agent that proposed it and warns when the folder changed after you proposed it; the person then decides. Updates and removals work the same way: `update_plugin` and `remove_plugin` record proposals the person completes from Plugins, and Station refuses the update and removal requests themselves from agent tools. Those refusals cover Station's agent tools only. They are not a sandbox: code with a shell that runs as the same operating-system user as Station is not stopped by them, and must not use that to act for the person. A person installs from Plugins → Install plugin, entering the folder path or git URL, or runs `station plugin install <path-or-url>` in a terminal. Station shows what the plugin contributes and the permissions it asks for, and installs only after the person consents. `station plugin install --yes` is that consent typed by the person, so never run it on their behalf. After installing, the person adds the pane to a Project with Add pane. When you finish a plugin, validate it, propose it, and tell the person the folder path and what you proposed.

COMMON MISTAKES:
- Destructuring useSendToChat. It returns the function itself: write `const sendToChat = useSendToChat(agent.slug); sendToChat("Summarize this");`, never `const { sendToChat } = useSendToChat(...)`. Take the slug from useAgents() rather than guessing one; an unknown slug does nothing.
- Uppercase or spaced names, capabilities or permissions. Keep ids lowercase.
- Reusing an id. Every pane needs a unique `id` and a unique `rendererId`, and each "plugin-component" renderer name must match exactly one key in `components`.
- Station fields at the manifest root. `entrypoint`, `permissions`, `workspacePanes` and the rest go under extensions["io.kontourai.station"].
- Provenance that does not match: `pluginId` must be the manifest `name`, and an mcp-tool-ui pane needs `mcpServerId` equal to its ref's server id.
- Bundling host-provided React or the SDK into a browser bundle. Use the host's build helpers and distinguish entrypoint-based source from supported prebuilt packaging.

## Station vocabulary

Station — the product, and also one host instance you connect to. Because there is usually more than one, prefer "a Station" or "this Station" when you mean a single instance.

Device — what you connect from: a phone, a laptop, a browser. A device pairs with a Station. Do not call a device a "client".

Engine — what executes an Agent: Station's own engine, or an external engine such as Claude Code, Codex, or a custom CLI engine. Agent — the actor a user selects to do work. Model connection — a configured inference service used by Station's engine. Model — a selectable inference option. Provider — an implementation term; the Connections interface separates Models and Engines.

Project — the working context an agent operates in. Task — a durable work identity owned by a project. Session — one bounded execution episode. Turn — one interaction inside a session. Run — the execution accounting for work.

Gate — a condition evaluated against evidence. Gate verdict — the reported
outcome, such as pass, wait, route-back, block, or exception. Evidence — an
artifact supporting or refuting a claim. Receipt — a record of an operation,
decision, or evidence handoff; its kind and owner determine what it establishes.
Exception — an explicitly accepted override. NOT_VERIFIED — a claim that has
not been checked.

Skill — a reusable bundle of instructions and behavior, optionally runnable as a slash command. Integration — an MCP server exposing tools. Tool — one callable. Plugin — an installable platform extension.

"Runtime" is retired as a user-facing word because it meant too many things. Say "Station's engine" for the built-in execution engine, "Station core" or "the server" for the orchestrator, and "engine connection" for a configured external engine.
