/**
 * station-docs content — the SHIPPED, STATIC prose the `station-docs` MCP
 * server serves (archive#1547).
 *
 * This module is a plain TypeScript data module on purpose. It has no
 * imports, reads no files, and makes no network calls, so "the docs are
 * bundled and versioned with Station, never fetched at runtime" is a
 * structural property of the build (esbuild compiles this array INTO
 * `dist-server/station-docs.js`) rather than a convention someone has to
 * remember.
 *
 * The line this content must never cross: it describes how Station works in
 * general. It never describes THIS user's Station — no agent list, no run
 * history, no settings, no credentials. Reading live or user state needs
 * authentication and belongs to `station-control`, which is a different
 * server with a different review. See the `station-docs` topic below, which
 * states that split to the model reading these docs.
 *
 * Sourced from the repo's own canonical docs (`CONTEXT.md`,
 * `docs/glossary.md`, `docs/strategy/constitution.md`,
 * `docs/strategy/differentiators.md`, `README.md`) and rewritten as concise
 * shipped content — not pasted, and never carrying anything private.
 */

export interface StationDocsTopic {
  /** Stable, kebab-case topic id. Callers pass this to `get_station_docs_topic`. */
  readonly id: string;
  /** One-line human title. */
  readonly title: string;
  /** One-sentence answer, enough to decide whether to open the topic. */
  readonly summary: string;
  /** The topic prose. Plain text with blank-line-separated paragraphs. */
  readonly body: string;
  /** Keywords used by `search_station_docs` alongside title/summary/body. */
  readonly tags: readonly string[];
}

export const STATION_DOCS_TOPICS: readonly StationDocsTopic[] = [
  {
    id: 'station-overview',
    title: 'What Station is',
    summary:
      'Station is a local-first agent workspace where agent work is run, observed, and evidence-gated, so "done" is a gate verdict rather than the agent\'s own confidence.',
    body: [
      'Station is an agent workspace: the place where you direct agent work, watch it run, and see the evidence for whether it is actually finished. It is not a chat wrapper and not an IDE.',
      'Its distinguishing idea is evidence over confidence. An agent saying it is done is an assertion, not a fact. Work in Station ends in one of three honest states: gates passed with fresh evidence, an exception a human explicitly accepted, or NOT_VERIFIED stated plainly. There is no fourth state where confident prose stands in for receipts.',
      'Station is local-first. Runtime data lives in your home directory (`~/.station` by default), no cloud account is required, and configuration, evidence, and run records are files you can version-control.',
      'Station is also deliberately thin at the core. The core provides the runtime, streaming, routing, and a provider registry; the vertical surfaces are plugins built on the same SDK that plugin authors use.',
    ].join('\n\n'),
    tags: [
      'overview',
      'what is station',
      'mission',
      'evidence',
      'local-first',
      'receipts',
      'introduction',
    ],
  },
  {
    id: 'station-docs',
    title: 'These docs, and what they cannot do',
    summary:
      'station-docs is a read-only documentation server: an engine that has it can EXPLAIN Station but CANNOT operate it — operating Station needs the separate station-control server, which only some engines can receive.',
    body: [
      "You are reading `station-docs`, a built-in MCP tool server that serves Station's own shipped documentation. It is static content compiled into Station and versioned with it. It never reads files from disk at request time, never makes network calls, and needs no credential of any kind.",
      'That design has a consequence worth being blunt about. These docs describe Station in general. They do NOT describe the Station you are connected to. Nothing here can tell you which agents exist, what is currently running, what a particular job did, what a setting is set to, or what is in a project. If you are asked any of those questions, say plainly that you can explain how Station works but cannot read this Station.',
      'Operating a Station — creating agents, running jobs, changing settings, listing plugins and checking them for updates, validating a plugin you wrote — is done through a different built-in server, `station-control`. Installing a plugin is not among those operations: it needs a person to approve the install preview, on the Plugins page or with `station plugin install <source>`, so no agent can install one (see the `plugin-authoring` topic). That one talks to the Station API and therefore needs a credential, which means it can only be delivered to engines that have a reviewed, non-secret-crossing way to receive it. Some engines can receive it; others cannot.',
      'So the capability split is real and it is asymmetric: docs go to every engine, control does not. An engine with docs and no `station-control` can explain Station, answer questions about it, and help you plan the work — and cannot perform it. Do not answer as if you had acted. Say what you can do, and say what you cannot.',
    ].join('\n\n'),
    tags: [
      'station-docs',
      'capability',
      'limits',
      'boundary',
      'station-control',
      'cannot',
      'read-only',
      'honesty',
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    summary:
      'A project is the working context — a directory plus the layouts, agents, and settings scoped to it — and it is what keeps task, run, and evidence context together.',
    body: [
      "A project is Station's unit of working context. It binds a working directory (and, when present, its Git top-level, worktree, and branch) to the layouts, agents, knowledge, and settings used with it.",
      'Projects scope which agents are available. A project can opt-in-filter the globally available agents, and an agent can also be OWNED by a project: an owned agent appears only inside that project and never in the global context. Deleting the owning project orphans the agent visibly rather than silently deleting it.',
      'Projects present themselves as layouts — arrangements of panels for a particular way of working. Layouts can come from Station or from plugins, so a project page can be a chat surface, a review workbench, a readiness console, or a domain-specific vertical.',
      "Station records whether a project's captured workspace binding is still `available`, `ambiguous`, or `unavailable`. Only `available` permits local inspection; the other two preserve the recorded identity without pretending the path is still current.",
    ].join('\n\n'),
    tags: [
      'project',
      'projects',
      'workspace',
      'layout',
      'layouts',
      'directory',
      'context',
    ],
  },
  {
    id: 'agents-and-engines',
    title: 'Agents and engines',
    summary:
      "An agent is the actor you pick to do work; an engine is what actually executes it — Station's own engine or an external engine such as Claude Code, Codex, or a custom CLI engine you connect by its command.",
    body: [
      'The one question that classifies any agent is: what runs it? That answer is a property of the agent — which engine it binds to — not a separate species of agent.',
      "Station's own engine runs an agent directly against a Model connection. In that case Station owns everything about the agent: its prompt, skills, tools, commands, and model.",
      'An external engine — Claude Code, Codex, or a custom CLI engine such as OpenCode or Kiro — runs its own loop. There, the engine owns behavior and tools, and Station owns only the abstractions it can set for that engine (model, effort, thinking) plus whatever capabilities that engine has a channel to receive.',
      "How Station reaches an engine is an implementation detail, not a category. Some engines are reached through a native SDK and some are driven as a subprocess over the Agent Client Protocol; users see the engine's name either way, and every resolved agent renders an engine chip naming its engine.",
      'What an engine can be given differs per engine, and Station is explicit about it rather than silently dropping things. Each engine has a capability matrix covering the system prompt, tool servers, skills, commands, and model selection; a capability an engine has no channel for is recorded as undelivered instead of being quietly ignored.',
    ].join('\n\n'),
    tags: [
      'agent',
      'agents',
      'engine',
      'engines',
      'external agent',
      'claude code',
      'codex',
      'acp',
      'capability matrix',
    ],
  },
  {
    id: 'connections',
    title: 'Connections',
    summary:
      "Connections are the configured providers Station can use: model connections (an LLM endpoint that Station's own engine drives) and engine connections (an external agent app Station hands work to).",
    body: [
      'Everything Station can run on is a connection, and the user-facing umbrella for all of them is "provider". You choose a provider first and a model second.',
      "A model connection is an LLM endpoint — a local Ollama, an OpenAI-compatible service, a gateway, or a cloud model service. It powers Station's own engine, which drives the inference loop itself.",
      'An engine connection is how Station reaches an external engine that runs its own loop, such as Claude Code, Codex, or a custom CLI engine. Station hands it a model plus effort/thinking settings and receives its events back.',
      "The dividing line is who runs the loop, not who has models. Both kinds have models to choose from. Station's engine drives a model connection directly; an external engine runs its own loop and Station selects a model within that engine's own list.",
      'The credential-free first path is a local model: install a local model runner, pull a model, and Station detects it and seeds a model connection with no API keys required.',
    ].join('\n\n'),
    tags: [
      'connection',
      'connections',
      'provider',
      'providers',
      'model',
      'ollama',
      'bedrock',
      'engine connection',
      'setup',
    ],
  },
  {
    id: 'builtin-assistant',
    title: 'The built-in assistant, and what it needs',
    summary:
      'The built-in assistant is the agent that operates Station for you; it needs the station-control tool server, which only engines with a reviewed delivery mechanism can receive.',
    body: [
      'Station ships one default, non-deletable agent whose job is to operate Station itself: create agents, run jobs, change settings, list plugins and check them for updates, check plugins it helped write, and generally reshape the workspace the way the UI does.',
      'It cannot install a plugin. An install is approved by a person who has read its preview — its permissions and the parts that run in Station’s own page — on the Plugins page or with `station plugin install <source>`. Asked to install one, the assistant says so and points there.',
      "That capability comes entirely from the `station-control` MCP tool server. `station-control` calls Station's own API, so it needs a credential for this running instance. A credential can only be handed to an engine over a channel that has been reviewed as not crossing the secret boundary.",
      'The consequence: not every connected engine can run the built-in assistant. An engine without a reviewed delivery mechanism for `station-control` can still chat, and it still receives `station-docs` — so it can explain Station, answer questions about it, and help you plan — but it cannot create agents, run jobs, or change settings.',
      'Station states this rather than hiding it. If no connected engine can run the built-in assistant, the engine picker says so, names what the connected engines can still do, and names which engines can run it today. An assistant that answers confidently while silently unable to act is exactly the failure this honesty is meant to prevent.',
    ].join('\n\n'),
    tags: [
      'built-in assistant',
      'default agent',
      'station-control',
      'engine picker',
      'capable',
      'incapable',
      'credential',
      'cannot operate',
    ],
  },
  {
    id: 'sessions-and-runs',
    title: 'Sessions, turns, and runs',
    summary:
      'A session is one bounded episode of agent work, a turn is one user-to-agent interaction inside it, and a run is the tracked execution accounting for that work.',
    body: [
      'A session is a bounded episode of agent work. It can be associated with a project, a layout, an agent, and an evidence-gated Flow run. Starting a direct chat creates a session; it does not silently create a durable Task.',
      'A turn is one user-to-agent interaction inside a session. A turn may stream text, reasoning, tool calls, approval requests, and terminal or artifact events.',
      'A run is the execution accounting: status, attempt count, retry eligibility, output references, and failure classification. An agent run is tied to an agent session; a scheduled run comes from a scheduled job instead of an interactive session.',
      "Every engine, Station's own or external, reports through one canonical event model, so the session lifecycle, tool events, and completion transitions look the same regardless of what ran the work. That uniformity is what lets one policy and gate model apply across engines.",
    ].join('\n\n'),
    tags: [
      'session',
      'sessions',
      'turn',
      'run',
      'runs',
      'events',
      'orchestration',
      'lifecycle',
    ],
  },
  {
    id: 'tasks',
    title: 'Tasks and the task workspace',
    summary:
      'A task is a durable work identity owned by a project — it outlives any single session, keeps its workspace binding and references, and can be reopened after a restart.',
    body: [
      'A task is a durable, user-addressable work identity belonging to a project. Unlike a session, it survives restarts and is not tied to one execution episode. A task may correlate an exact session, or none at all.',
      'A task carries typed references — to files, artifacts, receipts, sessions, runs, or external work items — and those references preserve exact identity. Similar titles or paths are not treated as correlation.',
      'The task workspace is the surface that reopens one task with its identity, workspace binding, changed files, artifacts, receipts, and session correlation in one place, so you can pick work back up without reconstructing context.',
      'A task can also be dispatched: assign an agent or a skill to it and send it into a session. Task statuses follow a neutral work-item vocabulary (todo, ready, triage, in progress, blocked, review, verification, done), plus a canceled state for work abandoned before completion.',
    ].join('\n\n'),
    tags: [
      'task',
      'tasks',
      'work item',
      'board',
      'dispatch',
      'task workspace',
      'references',
    ],
  },
  {
    id: 'scheduled-jobs',
    title: 'Scheduled jobs and notifications',
    summary:
      'A scheduled job runs an agent on a cron schedule and produces runs like any other work; notifications are contributed by subsystems and plugins and aggregated by Station.',
    body: [
      "A scheduled job runs an agent on a cron schedule. Jobs are managed through Station's schedule surface, stream their output while running, and produce scheduled runs that appear alongside interactive ones.",
      'Because a scheduled run is a run like any other, the same evidence, gate, and receipt machinery applies to it. Unattended work is not exempt from having to prove it did something.',
      'Notifications are provider-based: subsystems and plugins contribute notifications that Station aggregates, persists, and delivers, so a long-running or scheduled piece of work can tell you it needs attention.',
    ].join('\n\n'),
    tags: ['job', 'jobs', 'schedule', 'scheduler', 'cron', 'notifications'],
  },
  {
    id: 'skills',
    title: 'Skills',
    summary:
      'A skill is a reusable bundle of instructions and behavior an agent adopts; skills are a Station-agent capability, and only engines with a skills channel receive them.',
    body: [
      'A skill is a reusable bundle of instructions and behavior that an agent adopts — a way to give several agents the same competence without duplicating a prompt.',
      'Skills are a capability Station owns for agents it runs. For an agent bound to an external engine, whether the skill reaches the engine depends on that engine having a delivery channel for skills. Some engines do; others do not.',
      'When an engine has no channel for an authored skill, Station records that as undelivered rather than silently dropping it, and the agent editor shows the authored content read-only with a diagnostic naming the engine that cannot deliver it.',
      'Skills are installed and browsed from the registry, like agents and tool servers.',
      'A skill can also declare itself runnable as a slash command, which is how a reusable instruction sequence is invoked directly in a chat or assigned to a task. There is one authored concept here, not two.',
    ].join('\n\n'),
    tags: [
      'skill',
      'skills',
      'capability',
      'instructions',
      'command',
      'commands',
      'slash command',
      'registry',
      'undelivered',
    ],
  },
  {
    id: 'tool-servers',
    title: 'MCP tool servers, integrations, and tools',
    summary:
      'An integration is an MCP server that exposes tools; a tool is one callable within it, and Station ships two built-in servers — station-control (operate Station) and station-docs (explain Station).',
    body: [
      'Station speaks the Model Context Protocol for tools. An integration is an MCP server that exposes tools; a tool is one callable function from that server.',
      "Station ships two built-in servers. `station-control` exposes Station's own platform operations — agents, skills, integrations, jobs, plugins, providers — as tools, which is how an agent can manage Station itself. `station-docs` is this documentation server: static shipped prose, no credential, no live state.",
      'Third-party MCP servers are configured as integrations and can be attached to an agent. A tool server that declares environment variables is treated as carrying secrets and is never handed to an external engine, because that would push a credential across a boundary Station does not control. A server that declares no environment at all — like `station-docs` — has no such problem and can go everywhere.',
      'Mutating tool calls are governed work. Platform mutations can require approval, are recorded, and produce receipts when they run inside a gated session; approvals surface in an approval inbox where the decision and its resolution are both kept.',
    ].join('\n\n'),
    tags: [
      'mcp',
      'tool server',
      'tool servers',
      'integration',
      'integrations',
      'tools',
      'station-control',
      'station-docs',
      'approval',
      'passthrough',
    ],
  },
  {
    id: 'trust-and-receipts',
    title: 'Trust, gates, evidence, and receipts',
    summary:
      'Station renders evidence-gated process state — Flow gates and verdicts, Veritas readiness, Surface trust bundles — beside the work, and never computes those verdicts itself.',
    body: [
      'A gate is a condition that must be satisfied by evidence, routed back, blocked, or explicitly excepted. Gate verdicts are computed from evidence, not from an agent saying it finished.',
      'Evidence is an artifact that supports or refutes a claim about work: command output, files, test results, readiness checks, human attestations, trust artifacts. A receipt is the durable record connecting a claim, its evidence, and the resulting verdict, so a future reader can see why work was allowed to continue.',
      'Two outcomes are first-class and deliberately visible. A route-back means the work can continue but is not complete. An exception is a human-accepted override of missing or failing evidence — explicit debt in the receipt trail, never a silent bypass. And when something simply has not been checked, the honest statement is NOT_VERIFIED.',
      'Station renders this state; it does not own it. The evidence-gated process semantics, repo-standards and merge-readiness derivations, and claim/trust-bundle semantics each belong to the separate products that define them. Station consumes them through their published contracts, the same ones any other consumer can use, and shows the resulting gaps rather than hiding them behind a summary status.',
    ].join('\n\n'),
    tags: [
      'trust',
      'gate',
      'gates',
      'evidence',
      'receipt',
      'receipts',
      'flow',
      'veritas',
      'surface',
      'readiness',
      'exception',
      'route-back',
      'not_verified',
    ],
  },
  {
    id: 'fleet',
    title: 'Fleet inference across Stations',
    summary:
      'Fleet inference lets one Station serve model capacity to another Station you control, with routing and serving receipts — and contribution is opt-in and off by default.',
    body: [
      'People often run more than one Station: a laptop, a desktop with a GPU, a home server. Fleet inference is the capability that lets a Station borrow model capacity from another Station you control instead of every machine needing its own local model.',
      'Contributing capacity is opt-in and off by default. A Station that opts in publishes a manifest describing exactly the subset of its models it is contributing; nothing is shared implicitly.',
      'Routing is receipted. Station records which candidates were considered, which were excluded and why, and which Station actually served a request, so a routing decision is inspectable after the fact rather than being an opaque choice. Those routing and serving receipts render in the monitoring surface.',
      'Reaching another Station is a relationship you set up deliberately — pairing a device or configuring an environment — not something that happens automatically because two Stations are on the same network.',
    ].join('\n\n'),
    tags: [
      'fleet',
      'inference',
      'routing',
      'serve',
      'capacity',
      'multiple stations',
      'monitoring',
      'receipts',
      'gpu',
    ],
  },
  {
    id: 'plugins',
    title: 'Plugins and the registry',
    summary:
      'Plugins are how Station gets its verticals — they can contribute layouts, agents, tool servers, providers, knowledge namespaces, and engine connections through the same SDK core uses.',
    body: [
      "Station's core is deliberately foundational: runtime, streaming, routing, and a provider registry, with no domain logic. The domain surfaces are plugins.",
      'A plugin is manifest-driven and can contribute layouts, agents, MCP integrations, providers, knowledge namespaces, engine connections, branding, and settings. Plugin authors get the same primitives core gets — if core can do it, a plugin can do it.',
      'The registry is the unified place to browse and install agents, skills, integrations, and plugins (a plugin only with a person’s approval of its preview), with an install lifecycle that includes updates and removal. Installs can route through approval, because installing something is a platform mutation like any other.',
      'Where open standards exist, Station adopts them rather than inventing an equivalent: MCP for tools, the Agent Client Protocol for reaching external engines, OpenTelemetry for observability, and MCP-UI for rendered tool resources.',
    ].join('\n\n'),
    tags: [
      'plugin',
      'plugins',
      'registry',
      'install',
      'extension',
      'sdk',
      'layouts',
      'mcp-ui',
      'standards',
    ],
  },
  {
    id: 'plugin-authoring',
    title:
      'Writing a plugin: manifest, Workspace Panes, SDK hooks, validation and install',
    summary:
      'How to write a Station plugin that adds a Workspace Pane: the Agent Plugins 1.0 manifest with its io.kontourai.station extension, the components export, the SDK hooks a pane can call, how to check it with validate_plugin, and how a person installs it.',
    body: [
      'This topic is enough to write a working plugin without a Station source checkout. A plugin is a folder with a `plugin.json` manifest at its root and, for a pane with its own UI, a React entrypoint. Station builds the bundle itself when the plugin is installed, so a plugin ships source, not a `dist/` folder.',
      [
        'A minimal plugin folder:',
        'my-pulse/',
        '  plugin.json',
        '  src/index.tsx',
        '  src/pulse.css      (imported by index.tsx; drop the import if you have no CSS)',
        '  package.json       (optional; see BUILD below)',
      ].join('\n'),
      'THE MANIFEST. `plugin.json` is an Agent Plugins 1.0 document. The root holds only portable fields: `$schema`, `name`, `version`, `description` (and optionally `author`, `homepage`, `repository`, `license`, `keywords`). Everything Station-specific lives under `extensions["io.kontourai.station"]`: `schemaVersion` (always "1.0"), `title` (the display name), `entrypoint` (path to the React module, starting with "./"), `capabilities` (descriptive tags such as "chat" or "navigation"), `permissions` (what the plugin asks a person to grant) and `workspacePanes` (the panes it adds). Station fields placed at the root are ignored with a warning, and a root `layout` or `layouts` makes the manifest invalid.',
      [
        'A complete minimal manifest, one plugin-component pane that needs a Project:',
        '{',
        '  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",',
        '  "name": "my-pulse",',
        '  "version": "1.0.0",',
        '  "description": "Live agent and integration status for a Project.",',
        '  "extensions": {',
        '    "io.kontourai.station": {',
        '      "schemaVersion": "1.0",',
        '      "title": "My Pulse",',
        '      "entrypoint": "./src/index.tsx",',
        '      "capabilities": ["chat", "navigation"],',
        '      "permissions": ["navigation.dock"],',
        '      "workspacePanes": [',
        '        {',
        '          "version": "1.0",',
        '          "id": "pane:plugin%3Amy-pulse:pulse:workspace",',
        '          "name": "My Pulse",',
        '          "rendererId": "renderer:plugin%3Amy-pulse:plugin-component:my-pulse-workspace",',
        '          "renderer": { "kind": "plugin-component", "name": "my-pulse-workspace" },',
        '          "placement": { "supportedRegions": ["primary"], "preferredRegion": "primary" },',
        '          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],',
        '          "provenance": { "origin": "plugin", "pluginId": "my-pulse" },',
        '          "lifecycle": { "stage": "stable" }',
        '        }',
        '      ]',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'NAMES AND IDS. `name` is the plugin id: 1-64 lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit, with no "--" or "..". Capability and permission entries are lowercase too; Station disables the whole extension when one has an uppercase letter or a space. Pane ids and renderer ids are opaque strings, but they are global across every installed plugin: follow the `pane:plugin%3A<plugin-name>:<group>:<name>` and `renderer:plugin%3A<plugin-name>:<renderer kind>:<name>` pattern above so yours cannot collide, write the parts you choose in lowercase, and give every pane its own `id` and its own `rendererId`.',
      'PROVENANCE depends on the renderer kind. A "plugin-component" pane declares exactly `{ "origin": "plugin", "pluginId": "<your plugin name>" }`, with no `mcpServerId`. An "mcp-tool-ui" pane declares `{ "origin": "plugin", "pluginId": "<your plugin name>", "mcpServerId": "<serverId>" }`, where `<serverId>` is the same server id its `renderer.ref` names. Any other combination makes the pane invalid, and Station then disables the plugin\'s whole Station extension.',
      [
        'WORKSPACE PANE FIELDS:',
        '- version: "1.0".',
        '- name: what a person sees in Add pane.',
        '- placement.supportedRegions: one or more of "primary", "secondary", "standalone", "docked". placement.preferredRegion, if given, must be one of them. placement.order is an optional number.',
        '- modes: at least one entry, each with a unique `id`. A mode\'s contextRequirement sets any of these keys to `true` when the pane needs it: "project", "task", "session", "run", "workspace", "source". "default" with `{ "project": true }` means the pane is offered inside a Project.',
        '- lifecycle.stage: one of "stable", "preview", "deprecated".',
        '- Optional: description, icon, and requiredRendererCapabilities (see the mcp-tool-ui example).',
        '- Refused: a top-level `contextRequirement` or `dockability` on the pane. Put the requirement inside a mode.',
      ].join('\n'),
      'RENDERER KINDS. Use "plugin-component" when the pane is your own React UI: `renderer.name` must be a key of the `components` object your entrypoint exports, and the component runs in Station\'s page with the SDK available. Use "mcp-tool-ui" when the UI is served by a tool on an MCP tool server (an integration) Station has: the renderer is `{ "kind": "mcp-tool-ui", "ref": "<serverId>/<toolName>" }`, Station renders that tool\'s UI resource in a sandboxed frame, and no entrypoint is needed. Name the integration in `integrations.required` so the install preview shows whether it is present. Prefer "plugin-component" for panes that read Station data through SDK hooks; prefer "mcp-tool-ui" when the data and the UI already live behind an MCP server.',
      [
        'A complete minimal manifest, one mcp-tool-ui pane:',
        '{',
        '  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",',
        '  "name": "my-activity",',
        '  "version": "1.0.0",',
        '  "description": "Session activity rendered by an MCP tool.",',
        '  "extensions": {',
        '    "io.kontourai.station": {',
        '      "schemaVersion": "1.0",',
        '      "title": "My Activity",',
        '      "integrations": { "required": ["activity-mcp"] },',
        '      "workspacePanes": [',
        '        {',
        '          "version": "1.0",',
        '          "id": "pane:plugin%3Amy-activity:activity:panel",',
        '          "name": "Activity",',
        '          "rendererId": "renderer:plugin%3Amy-activity:mcp-tool-ui:activity-panel",',
        '          "renderer": { "kind": "mcp-tool-ui", "ref": "activity-mcp/activity_panel" },',
        '          "requiredRendererCapabilities": ["sandboxed-mcp-app"],',
        '          "placement": { "supportedRegions": ["secondary", "standalone"], "preferredRegion": "secondary" },',
        '          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],',
        '          "provenance": { "origin": "plugin", "pluginId": "my-activity", "mcpServerId": "activity-mcp" },',
        '          "lifecycle": { "stage": "stable" }',
        '        }',
        '      ]',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      [
        'THE ENTRYPOINT AND THE COMPONENTS EXPORT. The entrypoint exports a `components` object mapping each "plugin-component" renderer name to a React component. Component names are global across plugins too, so prefix them with the plugin name. React, the SDK and @tanstack/react-query are provided by Station at runtime; import them normally and never bundle your own copy.',
        'import { useAgents, useNavigation, useToast } from "@kontourai/station-sdk";',
        'import "./pulse.css";',
        'function MyPulse() {',
        '  const agents = useAgents();',
        '  const { setDockState } = useNavigation();',
        '  const { showToast } = useToast();',
        '  return (',
        '    <main className="my-pulse">',
        '      <h1>Agents</h1>',
        '      <ul>{agents.map((agent) => <li key={agent.slug}>{agent.name}</li>)}</ul>',
        '      <button type="button" onClick={() => { setDockState(true); showToast({ type: "info", message: "Chat opened" }); }}>',
        '        Open chat',
        '      </button>',
        '    </main>',
        '  );',
        '}',
        'export const components = { "my-pulse-workspace": MyPulse };',
        'export default MyPulse;',
      ].join('\n'),
      [
        'SDK HOOKS A PANE CAN USE (all imported from "@kontourai/station-sdk"):',
        '- useAgents() → the agents this person can use, each with `slug` and `name`. useAgent(slug) returns one.',
        '- useIntegrationsQuery() → a query result whose `data` lists the configured MCP tool servers (integrations).',
        '- useOrchestrationSessionsQuery() → a query result whose `data` lists sessions.',
        '- useProjects() / useProject(slug) → Projects this person can see.',
        '- useSendToChat(agentSlug) → a FUNCTION. Call it with a message: it opens a new chat with that agent in the dock and sends the message.',
        '- useLaunchChat() → a function (agentSlug, agentName, initialMessage?, projectSlug?) that opens a chat with more control.',
        '- useNavigation() → `setDockState(open)` to open or close the chat dock, plus the current navigation state. useDockState() wraps just the dock.',
        '- useToast() → `{ showToast }`; call `showToast({ type: "info" | "success" | "warning" | "error", message })`.',
        '- useAuth() → the signed-in person and auth status.',
        '- useServerFetch() → a function that fetches a URL through Station\'s server; it needs the "network.fetch" permission.',
        'Query hooks follow @tanstack/react-query: read `data`, `isLoading` and `error`, and render a loading and an empty state.',
      ].join('\n'),
      [
        'PERMISSIONS. Declare only what the plugin uses. The complete list, by what granting it takes:',
        '- passive (granted automatically at install): "navigation.dock"',
        '- active (the person consents at install): "ui.confirm", "network.fetch", "agents.invoke", "tools.invoke"',
        '- trusted (a separate host approval after install): "events.subscribe", "events.read-payload", "providers.register", "plugin.server", "system.config"',
        'A permission Station does not recognise is treated as trusted, the strictest tier.',
      ].join('\n'),
      'BUILD. Station bundles the entrypoint with esbuild when the plugin is installed and serves `dist/bundle.js` (and `dist/bundle.css` if the entrypoint imports CSS). A `package.json` is optional. If there is one, the install runs `npm install` for its dependencies, so list only what the pane really needs and leave React and the SDK as peer or dev dependencies. For local typechecking, `npm install @kontourai/station-sdk react @types/react typescript` in the plugin folder is enough.',
      'VALIDATE BEFORE ASKING FOR AN INSTALL. If you have `station-control`, call `validate_plugin` with the absolute path of the plugin folder. It checks local folders only: it refuses git URLs and network paths (UNC or /net/…), so copy a plugin to a local folder first. It runs part of what the install preview checks and reports each problem as a diagnostic: manifest errors, an io.kontourai.station extension Station would disable (which silently drops every pane), unsafe prompt files, pane ids already taken by another plugin, and a missing entrypoint. It does not resolve plugin dependencies (it warns `dependencies-not-checked` when you declare any) and it does not build the bundle, so a TypeScript or import error only shows at install; typecheck locally first. `valid: true` means no error-level diagnostic, not a guaranteed install. Fix every error and validate again before handing the plugin over.',
      "INSTALL IS A PERSON'S DECISION. Agents must not install plugins, and `install_plugin` refuses. A person installs from Plugins → Install plugin, entering the folder path or git URL, or runs `station plugin install <path-or-url>` in a terminal. Station shows what the plugin contributes and the permissions it asks for, and installs only after the person consents. `station plugin install --yes` is that consent typed by the person, so never run it on their behalf. After installing, the person adds the pane to a Project with Add pane. When you finish a plugin, tell the person the folder path and exactly those steps.",
      [
        'COMMON MISTAKES:',
        '- Destructuring useSendToChat. It returns the function itself: write `const sendToChat = useSendToChat(agent.slug); sendToChat("Summarize this");`, never `const { sendToChat } = useSendToChat(...)`. Take the slug from useAgents() rather than guessing one; an unknown slug does nothing.',
        '- Uppercase or spaced names, capabilities or permissions. Keep ids lowercase.',
        '- Reusing an id. Every pane needs a unique `id` and a unique `rendererId`, and each "plugin-component" renderer name must match exactly one key in `components`.',
        '- Station fields at the manifest root. `entrypoint`, `permissions`, `workspacePanes` and the rest go under extensions["io.kontourai.station"].',
        "- Provenance that does not match: `pluginId` must be the manifest `name`, and an mcp-tool-ui pane needs `mcpServerId` equal to its ref's server id.",
        '- Bundling React or the SDK, or committing `dist/`. Station provides both and rebuilds on install.',
      ].join('\n'),
    ].join('\n\n'),
    tags: [
      'plugin authoring',
      'write a plugin',
      'create plugin',
      'plugin.json',
      'manifest',
      'agent plugins',
      'io.kontourai.station',
      'workspace pane',
      'workspacepanes',
      'pane',
      'renderer',
      'plugin-component',
      'mcp-tool-ui',
      'components',
      'sdk',
      'hooks',
      'usesendtochat',
      'validate_plugin',
      'validate',
      'install',
      'permissions',
    ],
  },
  {
    id: 'vocabulary',
    title: 'Station vocabulary',
    summary:
      'A compact glossary of the words Station uses precisely: Station, device, engine, agent, project, task, session, run, gate, evidence, receipt, and the retired term "runtime".',
    body: [
      'Station — the product, and also one host instance you connect to. Because there is usually more than one, prefer "a Station" or "this Station" when you mean a single instance.',
      'Device — what you connect from: a phone, a laptop, a browser. A device pairs with a Station. Do not call a device a "client".',
      "Engine — what executes an agent: Station's own engine, or an external engine such as Claude Code, Codex, or a custom CLI engine. Agent — the actor a user selects to do work. Provider — the user-facing umbrella for any configured connection; Model — a selectable inference option within one.",
      'Project — the working context an agent operates in. Task — a durable work identity owned by a project. Session — one bounded execution episode. Turn — one interaction inside a session. Run — the execution accounting for work.',
      'Gate — a condition satisfied by evidence. Gate verdict — the outcome (pass, wait, route-back, block, exception), never "done" as a vibe. Evidence — an artifact supporting or refuting a claim. Receipt — the durable claim-evidence-verdict record. Exception — an explicitly accepted override. NOT_VERIFIED — the honest statement when something has not been checked.',
      'Skill — a reusable bundle of instructions and behavior, optionally runnable as a slash command. Integration — an MCP server exposing tools. Tool — one callable. Plugin — an installable platform extension.',
      '"Runtime" is retired as a user-facing word because it meant too many things. Say "Station\'s engine" for the built-in execution engine, "Station core" or "the server" for the orchestrator, and "engine connection" for a configured external engine.',
    ].join('\n\n'),
    tags: [
      'glossary',
      'vocabulary',
      'terms',
      'definitions',
      'naming',
      'words',
      'runtime',
    ],
  },
];
