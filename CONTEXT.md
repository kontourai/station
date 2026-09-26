# Station Context

Station is a local-first workspace for agent work. It connects Projects,
Tasks, agent Sessions, files, and evidence. It also hosts integrations with
Kontour's process, review, and governance products.

This page explains the main boundaries. Use the [glossary](docs/glossary.md)
for names, the [system overview](docs/architecture.md) for flows, and the
[module map](docs/architecture/module-map.md) for implementation and tests.
The [context map](CONTEXT-MAP.md) routes work into the five areas below.
Keeping those owners separate avoids maintaining a second glossary here.

## Work and execution

A **Project** provides context and may have a local filesystem binding. A
**Task** is durable work belonging to a Project. It can reference Sessions,
runs, files, artifacts, and receipts. A **Session** is an execution episode
with its own persisted event history. Direct chat does not silently create a
Task. A **turn** is one interaction within a Session.

An **Agent** is the identity selected for the work; its **engine** executes
it. Station's engine uses a Model connection. External engines such as Claude
Code, Codex, Muse, and compatible custom CLIs own their agent loop. ACP is a
transport to some external engines, not another Agent category.

The reserved Agent named **Station** is a role, identified by `station`. Its
engine is a separate choice. Do not infer its engine from its name or confuse
it with the broader phrase “an agent using Station's engine.” Default Agents
are persisted registry records. An unavailable engine does not erase its
Agent or turn that Agent into a synthetic selection row.

Authored prompts, skills, and MCP tools have different delivery paths and
limits for each engine. The [capability matrix](packages/contracts/src/engine-capability-matrix.ts)
and [delivery guide](docs/conformance/tool-policy-delivery.md) own those
limits. Delivery of an MCP server does not grant Station control over every
tool the external engine can execute.

Session lifecycle includes `idle`: a turn finished, but the same Session can
accept another. `completed` is an explicit terminal close. `failed` and
`canceled` are stopped outcomes with different restart rules. Read the
[transition contract](packages/contracts/src/session-lifecycle.ts) instead of
maintaining another list of terminal states.

Start with [Agent Runtime](docs/contexts/agent-runtime/CONTEXT.md),
[Agents](docs/guides/agents.md), and [Session API](docs/reference/session-api.md).

## Evidence and governance

A completed agent turn, Task status, a reviewed artifact, and a passed gate
are different facts. A receipt records a particular operation or decision;
its presence alone does not establish that the work is correct.

A configured **Flow run** owns its gates, route-backs, exceptions, and reports.
At Session start, the [Flow policy owner](src-server/services/orchestration/flow-policy-sidecar.ts)
attempts to attach a run only when the caller explicitly selects a non-retired
definition through `metadata.flowDefinition`, with a working directory and
Flow service available. A Flow definition merely existing in the workspace
does not bind an ordinary chat. Command output, review records,
and Veritas readiness can supply evidence through their respective bridges.
The receiving gate still decides what that evidence satisfies.

**Veritas** owns repository standards and readiness. **Surface** owns trust
bundle semantics. **Survey** owns its review chains. **Flow Agents** supplies
process state, skills, and policies through published contracts. Station
composes these products; it must not copy their private implementations or
claim their state from a UI label.

An **approval** authorizes an action. A **review** assesses its output. A
**gate** evaluates evidence against a requirement. If a claim has not been
checked, record **NOT_VERIFIED**, including what remains to be checked.

Start with [Evidence Governance](docs/contexts/evidence-governance/CONTEXT.md)
and the [integration guide](docs/guides/integrating-station.md).

## Work surfaces

The shell contains **regions**. A placement **Surface**, such as Chat or
Activity, occupies a region. A Project **Layout** or Surface can contain a
**pane host**, whose tabs and splits arrange **Workspace Pane instances**.
A **Panel** is a visual grouping inside that UI, not a persisted Pane.
These terms are separate from the Kontour product named Surface.

A Pane descriptor declares content and placement needs. It does not establish
installation, authorization, or runtime availability. A Pane instance gives
one occurrence its own identity and state key. Persisted host data contains
placement and selection; renderer callbacks and native handles stay local to
the running UI. A Task workspace can compose several Panes while keeping the
same Task identity.

The [workspace context](docs/contexts/workspace-surfaces/CONTEXT.md) links the
contracts and host behavior. [Pane authoring](docs/guides/workspace-pane-authoring.md)
explains the public extension surface. Historical layout-tab records remain
supported input; they are not the entire current shell model.

## Extensions

A **Plugin** packages contributions. An **Integration** usually connects MCP
tools or resources. A **Provider** implements a particular extension point,
such as embeddings, notification polling, or model access. These are different
responsibilities even when one package supplies all three.

Installation, declared contributions, permission grants, host approval, and
activation are distinct steps. Provider or server code is not authorized just
because its files exist. Trusted plugin React and sandboxed MCP Apps also
remain different execution boundaries.

Station reads both legacy manifests and Agent Plugins `1.0` packages. The
portable root and `io.kontourai.station` extension have separate validators;
use the [plugin guide](docs/guides/plugins.md) and
[Agent Plugins reference](docs/reference/agent-plugins.md) for exact formats.
Do not infer support for a plugin contribution from an internal service
interface: the scheduler interface, for example, is not a public plugin
registration surface.

Start with [Extension Ecosystem](docs/contexts/extension-ecosystem/CONTEXT.md)
and the [public SDK](docs/reference/sdk.md).

## Operations and storage

`STATION_ROOT` holds shared client metadata, installs, caches, and runtime
homes. `STATION_HOME` selects one runtime home. A Project directory is a
separate binding. A shared Project's authority or room is not any of those
filesystem paths. Use [topology](docs/design/station-topology.md) and the
[development guide](docs/guides/development.md#data-directory) when choosing an
instance or recovering stored state.

Knowledge documents and their retrieval indexes have separate ownership.
Providers are selected through interfaces; a local default does not imply
that every configured embedding or vector provider is local. The Scheduler
owns job and run accounting. Notification persistence, delivery channels, and
approval decisions are separate responsibilities. A displayed notification
or a successful send does not prove delivery to a physical Device.

Start with [Operations](docs/contexts/operations/CONTEXT.md),
[Knowledge](docs/guides/knowledge.md), [Monitoring](docs/guides/monitoring.md),
and [Deployment](docs/guides/deployment.md).

## Codebase design and verification

Before changing a caller family, find its owning interface and composition
point in the [module map](docs/architecture/module-map.md). Keep sequencing,
storage, provider details, and authorization inside the owner that can enforce
them. File size alone does not justify another abstraction; the
[abstraction review](docs/architecture/abstraction-review.md) records concrete
questions and evidence.

The [constitution](docs/strategy/constitution.md) records product principles,
not a certification that every feature already meets them. Keep core
vendor-neutral, use published Kontour contracts, and propose missing primitive
capabilities upstream. Extraction requires a real second consumer, a public
contract, verification the new product owns, and a measurable reduction in
Station-owned code. These are design constraints, not permission to extract
or remove a working subsystem during documentation cleanup.

Use the [testing guide](docs/guides/testing.md) and `npm run gate:for -- <paths>`
for current verification routes. Source inspection, a focused test, a live
provider/device journey, and a release receipt establish different things.
Neither a passing scan nor a generated document proves all its prose.

Historical strategy, ADRs, and experiment reports explain earlier decisions.
They do not establish current release availability. GitHub owns live work and
delivery state. [Maintaining documentation](docs/guides/documentation.md)
defines the code review and editorial pass required when these explanations
change.
