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
- keeping notes in browser localStorage under one fixed key

## Install

Run from the checkout root with a running Station selected by automatic
active-local discovery or the default loopback fallback. Review the install
preview and grants, then add the layout to the intended Project. Explicit
`--api-base` and saved-Station targets require a Git source for plugin install.

```bash
./station plugin install ./examples/demo-layout
```

To browse the local registry fixture:

```bash
./station registry ./examples/registry/manifest.json
./station registry
```

Use the direct plugin install command above or the Registry UI's preview flow
to install. The separate registry CLI lacks that consent step; see
[#2809](https://github.com/kontourai/station/issues/2809).

## Why Keep This Example

`minimal-layout` demonstrates a current Workspace Pane; this example retains
the legacy Layout contract with two tabs. Its notes share the
`station-demo-notes` key across Projects and saved Stations on the same browser
origin. They are not server-persisted, Project-scoped, or synchronized across
devices; storage failures are ignored. Use a scoped store for real project data.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `globalSkills[].prompt` displayed on the Layout | `Say Hello` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in [the example migration](https://github.com/kontourai/station/issues/265) is complete.
