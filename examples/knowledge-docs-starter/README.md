# Knowledge Docs Starter

Knowledge and documentation UI starter with sample rows and chat-entry controls.
It does not ingest, index, retrieve, or cite a real document collection.

## What It Demonstrates

- Declaring a plugin-owned knowledge namespace in `plugin.json`.
- Separating document intake, question answering, and source coverage into tabs.
- Opening chat from the Ask tab without transmitting document selection.
- Showing placeholder guidance for freshness, citation quality, and ownership.

## Run It

Build and inspect the local example from the Station checkout, then install it
on the selected Station:

```bash
npm run dependencies:ci
(cd examples/knowledge-docs-starter && ../../station plugin build)
./station target
./station plugin preview ./examples/knowledge-docs-starter
./station plugin install ./examples/knowledge-docs-starter
```

After the build, `./station registry ./examples/registry/manifest.json` selects
the local catalog, and `station registry install knowledge-docs-starter`
installs the same static starter from it.

The [Library component](src/index.tsx) ships three static document rows. Their
`indexed` labels and chunk counts are sample values, not ingestion evidence.
The **Ask with selected sources** button only opens the chat Dock through
`useNavigation()` and calls `onShowChat`; there is no selection model or
source payload in that handler.
**Source coverage** displays guidance, not measured freshness or citation checks.

The [manifest](plugin.json) declares `starter-docs` for the older Knowledge
namespace interface. That declaration does not register a Knowledge Kit root
or load the sample filenames. The **Summarize selected documents** host action
sends a fixed prompt; it does not read those rows or attach source content.
Configure a usable model connection for the contributed Agent before attempting
that action, and do not treat an uncited response as grounded in this sample.
Real Knowledge integration is tracked in
[#268](https://github.com/kontourai/station/issues/268), whose detailed scope
was folded into the pane-workspace epic.

For real content, implement intake, retrieval, selection, and citation handling
through the appropriate public SDK contracts. Use
[Knowledge Library](../knowledge-library/README.md) for canonical record recall
and [Meeting Notes](../meeting-notes/README.md) for the separate capture/index
workflow. Static builds and host-action tests do not qualify live-provider
retrieval or answer quality.

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Summarize selected documents` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `knowledge-docs-starter-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `knowledge-docs-starter-assistant`; Station supplies installation ownership. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local actions stay local. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in [the example migration](https://github.com/kontourai/station/issues/265) is complete.
