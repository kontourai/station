# Knowledge Docs Starter

Knowledge and documentation starter for document-heavy workflows. It gives users a library, ask, and source-review surface before adding production ingestion.

## What It Demonstrates

- Declaring a plugin-owned knowledge namespace in `plugin.json`.
- Separating document intake, question answering, and source coverage into tabs.
- Opening chat from a source-scoped action.
- Keeping citation quality and document ownership visible in the workspace.

## Run It

Install from the local starter registry:

```bash
station registry install knowledge-docs-starter --manifest examples/registry/manifest.json
```

The starter ships static document rows so it works out of the box. Replace those rows with uploads, directory sync, or a provider-backed knowledge service when you connect it to real content.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Summarize selected documents` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `knowledge-docs-starter-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `knowledge-docs-starter-assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in [the example migration](https://github.com/kontourai/station/issues/265) is complete.
