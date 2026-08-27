/**
 * station-docs content — the SHIPPED, STATIC prose the `station-docs` MCP
 * server serves (station#1547).
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
      'Operating a Station — creating agents, running jobs, changing settings, installing plugins — is done through a different built-in server, `station-control`. That one talks to the Station API and therefore needs a credential, which means it can only be delivered to engines that have a reviewed, non-secret-crossing way to receive it. Some engines can receive it; others cannot.',
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
      'Station ships one default, non-deletable agent whose job is to operate Station itself: create agents, run jobs, change settings, install plugins, and generally reshape the workspace the way the UI does.',
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
      'Skills are installed and browsed from the registry alongside agents, tool servers, and plugins.',
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
      'The registry is the unified place to browse and install agents, skills, integrations, and plugins, with an install lifecycle that includes updates and removal. Installs can route through approval, because installing something is a platform mutation like any other.',
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
