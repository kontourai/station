# Context Map

Read [CONTEXT.md](./CONTEXT.md) for the main responsibilities and the
[glossary](docs/glossary.md) for vocabulary. Each context below links its owning
code and detailed guides.

## Contexts

- [Agent Runtime](./docs/contexts/agent-runtime/CONTEXT.md) — Agent identity, engines, Sessions, lifecycle, delegation, and workspace isolation.
- [Evidence Governance](./docs/contexts/evidence-governance/CONTEXT.md) — receipts, Flow runs, gates, Veritas readiness, Surface trust state, policy classes, and governance evidence.
- [Extension Ecosystem](./docs/contexts/extension-ecosystem/CONTEXT.md) — plugins, registry lifecycle, plugin providers, capabilities, integrations, MCP servers, MCP-UI, and station-control.
- [Workspace Surfaces](./docs/contexts/workspace-surfaces/CONTEXT.md) — projects, layouts, experiences, layout tabs, Workspace Panes, coding surfaces, review surfaces, trust panels, run consoles, navigation, and proposed changes.
- [Operations](./docs/contexts/operations/CONTEXT.md) — knowledge, scheduling, notifications, voice, terminals, telemetry, verification lanes, and local-first artifacts.

## Relationships

- **Agent Runtime -> Evidence Governance**: Sessions emit execution events. A caller can explicitly request an eligible Flow definition; its bound run evaluates the relevant evidence. A definition's presence in the workspace does not create that binding, and Session completion alone is not a gate verdict.
- **Agent Runtime -> Workspace Surfaces**: Sessions, turns, runs, approvals, and terminal state are rendered inside project layouts and session-context surfaces.
- **Extension Ecosystem -> Agent Runtime**: Plugins contribute Agents, engine connections, skills, integrations, and supported providers. Delivery depends on engine capabilities and grants.
- **Extension Ecosystem -> Workspace Surfaces**: Plugins can contribute layouts, layout tabs, Workspace Panes, built-in-compatible components, and MCP-UI panels.
- **Extension Ecosystem -> Evidence Governance**: station-control and MCP-UI tool calls can become governed platform mutations or command evidence.
- **Operations -> Agent Runtime**: Scheduled jobs, voice sessions, terminals, knowledge namespaces, and workspace isolation all create or shape agent work.
- **Operations -> Evidence Governance**: Verification lanes, telemetry, and generated artifacts supply evidence and governance readiness.
- **Workspace Surfaces -> Evidence Governance**: Trust panels, readiness panels, Flow run consoles, and proposed-change decisions make receipts visible where work happens.
