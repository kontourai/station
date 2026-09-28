# Getting Started Starter

Default layout starter for new Station plugins. It demonstrates a small, copyable workspace with no external services.

## What It Demonstrates

- Reading scoped agents with `useAgents()`.
- Opening the chat dock with `useNavigation()`.
- Sending host feedback with `useToast()`.
- Wiring named layout components through `layout.json`.

## Run It

From the repository root, preview and install the directory through a running
local Station. The CLI must select it through automatic active-local discovery
or its default loopback fallback; explicit/saved targets require a Git source.

```bash
station plugin preview ./examples/getting-started-starter
station plugin install ./examples/getting-started-starter
```

Review the requested permissions and any separate trusted grants. Add its layout
to the intended Project after installation is ready. The plugin is intentionally
static. Replace the copy and panels first, then add providers when the layout
needs persistent data. The [local registry](../registry/README.md) is another
discovery path; `registry install` has no per-call `--manifest` option. After
`./station registry ./examples/registry/manifest.json` selects that catalog,
`station registry install getting-started-starter` installs this static
starter.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Explain this workspace` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `getting-started-starter-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `getting-started-starter-assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in [the example migration](https://github.com/kontourai/station/issues/265) is complete.
