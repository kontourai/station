# Context Map

Station is a single product with several domain contexts. Read the root [CONTEXT.md](./CONTEXT.md) first for repo-wide vocabulary, then read the context file for the area being changed or reviewed.

## Contexts

- [Agent Runtime](./docs/contexts/agent-runtime/CONTEXT.md) — agent execution, Agent apps, sessions, runs, lifecycle, delegation, workflow sidecars, and workspace isolation.
- [Evidence Governance](./docs/contexts/evidence-governance/CONTEXT.md) — receipts, Flow runs, gates, Veritas readiness, Surface trust state, policy classes, and governance evidence.
- [Extension Ecosystem](./docs/contexts/extension-ecosystem/CONTEXT.md) — plugins, registry lifecycle, plugin providers, capabilities, integrations, MCP servers, MCP-UI, and station-control.
- [Workspace Surfaces](./docs/contexts/workspace-surfaces/CONTEXT.md) — projects, layouts, experiences, layout tabs, Workspace Panes, coding surfaces, review surfaces, trust panels, run consoles, navigation, and proposed changes.
- [Operations](./docs/contexts/operations/CONTEXT.md) — knowledge, scheduling, notifications, voice, terminals, telemetry, verification lanes, and local-first artifacts.

## Relationships

- **Agent Runtime -> Evidence Governance**: Agent sessions emit canonical runtime events and attach evidence to Flow runs; Evidence Governance decides whether work can be called complete.
- **Agent Runtime -> Workspace Surfaces**: Sessions, turns, runs, approvals, and terminal state are rendered inside project layouts and session-context surfaces.
- **Extension Ecosystem -> Agent Runtime**: Plugins can contribute Station agents, Agent app registry entries, skills, integrations, and providers used by the runtime.
- **Extension Ecosystem -> Workspace Surfaces**: Plugins can contribute layouts, layout tabs, Workspace Panes, built-in-compatible components, and MCP-UI panels.
- **Extension Ecosystem -> Evidence Governance**: station-control and MCP-UI tool calls can become governed platform mutations or command evidence.
- **Operations -> Agent Runtime**: Scheduled jobs, voice sessions, terminals, knowledge namespaces, and workspace isolation all create or shape agent work.
- **Operations -> Evidence Governance**: Verification lanes, telemetry, and generated artifacts supply evidence and governance readiness.
- **Workspace Surfaces -> Evidence Governance**: Trust panels, readiness panels, Flow run consoles, and proposed-change decisions make receipts visible where work happens.
