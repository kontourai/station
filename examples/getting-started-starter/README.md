# Getting Started Starter

Default layout starter for new Station plugins. It demonstrates a small, copyable workspace with no external services.

## What It Demonstrates

- Reading scoped agents with `useAgents()`.
- Opening the chat dock with `useNavigation()`.
- Sending host feedback with `useToast()`.
- Wiring named layout components through `layout.json`.

## Run It

From this repository, install it through the local registry manifest or copy the directory into a Station plugin home:

```bash
station registry install getting-started-starter --manifest examples/registry/manifest.json
```

The plugin is intentionally static. Replace the copy and panels first, then add providers only when the layout needs persistent data.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Explain this workspace` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `getting-started-starter-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `getting-started-starter-assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. Worktree provisioning remains separately gated. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in #265 is complete.
