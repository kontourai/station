# Coding Starter

Code-focused layout starter for teams that want a workspace shaped around files, terminal output, diffs, and agent handoff.

## What It Demonstrates

- A file-browser panel that can later be backed by a provider.
- A terminal-output panel for command and test summaries.
- A diff-review tab with explicit behavior, test, and verification prompts.
- A chat handoff button using the host navigation SDK.

## Run It

Install from the local starter registry:

```bash
station registry install coding-starter --manifest examples/registry/manifest.json
```

The starter uses static fixture data so it works immediately. Replace the file list, terminal output, and diff source with plugin providers when you connect it to a real repository.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Review current diff` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `coding-starter-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `coding-starter-assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. Worktree provisioning remains separately gated. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in #265 is complete.
