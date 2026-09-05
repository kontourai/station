# Demo Layout

A starter workspace plugin that demonstrates the current layout-plugin contract with:

- a real `plugin.json`
- a real `layout.json`
- a bundled React entrypoint
- a namespaced agent

## What It Shows

- multiple layout tabs (`Welcome`, `Notes`)
- opening the chat dock from plugin UI
- reading auth and agent state from `@kontourai/station-sdk`
- persisting plugin-local state in the browser

## Install

```bash
./station plugin install ./examples/demo-layout
```

Or add the local registry manifest first and install from the registry:

```bash
./station registry ./examples/registry/manifest.json
./station registry install demo-layout
```

## Why Keep This Example

`minimal-layout` is the smallest possible starting point. `demo-layout` is the next step up: it is still approachable, but it demonstrates the actual structure most layout plugins will need in practice.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `globalSkills[].prompt` displayed on the Layout | `Say Hello` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in archive#265 is complete.
