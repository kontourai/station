# Enterprise Layout Example

A layout example with Calendar, CRM, dashboard, and Notes tabs. Calendar, CRM
and email providers call MCP tools; Notes uses Station's document API, and the
directory provider is a stub. This is an integration pattern, not a configured
enterprise deployment.

## Prerequisites

Use Node 24 and the checkout's managed dependencies. Build with
`(cd examples/enterprise-layout && ../../station plugin build)`, inspect `./station target`,
then preview and install through the person-approved plugin lifecycle. The
`outlook-mcp` and `salesforce-mcp` commands and their authenticated services must
be supplied separately. The Agent also declares `notes-mcp-server` and requires
`NOTES_VAULT_PATH`; a model connection is needed for Agent prompts. A build does
not provision these services or verify live calendar, CRM, email or model use.

This example is outside the root's managed workspace list. The public build
command prepares dependencies in the example directory before bundling and may
need registry access. Finishing the root dependency bootstrap does not establish
that this separate dependency preparation or plugin build completed.

## Patterns Demonstrated

### Multi-Provider Architecture
The layout declares Calendar, CRM and user provider requirements in `layout.json`.
The [component entry](src/index.tsx) calls `ensureProviders` from
[init.ts](src/data/init.ts) and retries registration while the SDK is unavailable.
It renders no content until registration succeeds. The hooks in
[data/index.ts](src/data/index.ts) resolve the active provider and include its ID
in query keys. Email and directory are additional registered provider types.

```
layout.json (requiredProviders) → providerTypes.ts (type map) → init.ts (registration) → providers/*.ts (implementations)
```

### Layout tab state

The [calendar navigation hook](src/useCalendarNavigation.ts) reads and writes
only its tab's state through the SDK. To erase a tab's saved string and cancel
its pending restoration, use `clearTabState(tabId)` from
[`useLayoutNavigation`](../../docs/reference/sdk.md#uselayoutnavigation).

### Provider Contracts (`src/data/providers.ts`)
Typed interfaces (`ICalendarProvider`, `ICRMProvider`, etc.) define the contract between UI and data layer. Implementations can be swapped without changing components.

### MCP Tool Mapping (`src/data/providers/*.ts`)
Calendar, CRM and email call the SDK's `callTool` with the contributed Agent.
Their mappings assume specific tool response fields; only Calendar has its own
envelope-unwrapping helper. The [directory provider](src/data/providers/directory.ts)
returns a synthetic address for lookup and an empty search result. Replace it
with a real directory integration before relying on it.

### Plugin Dependencies
`plugin.json` declares the local `shared-providers` example, whose manifest lists
auth, user identity/directory and registry providers. This demonstrates package
composition. Preview shows the dependency and its `providers.register` permission
along with Enterprise's own grants. After consent, Station installs an absent
dependency through the same provider and settings lifecycle. Removing Enterprise
removes the dependency it installed. A separately installed copy keeps its
provider and settings state. The example does not configure an enterprise
identity service.

### Integration Declarations
MCP servers are declared in `integrations/` as JSON manifests. The agent's `tools.mcpServers` references these by id.

### Knowledge Namespaces

The [manifest](plugin.json) and the [Notes hooks](src/data/notes-hooks.ts) use
the same RAG namespace, `enterprise-notes`. Apply the installed Enterprise layout
to a Project to register this namespace. The Notes pane reads and writes the
same document partition it used in earlier versions, so existing `enterprise-notes`
documents retain their IDs, files, and vector partition. Unscoped Project
document search considers this partition after registration when configured
embedding and vector providers have indexed documents there.

Older Projects may already have the separately registered `notes` namespace.
Station preserves it, its settings, and its documents when applying Enterprise
again. It remains searchable under its existing RAG configuration. To
consolidate documents manually, copy each desired legacy document and its
metadata through the Project document API into `enterprise-notes`. Resolve filename
conflicts by choosing a distinct filename, then verify the copies before
retiring the source. A copy has a new document ID. The plugin makes no file
moves or deletions and does not rebuild vectors on apply.

The declaration does not ingest notes, configure embedding/vector providers,
or populate a Knowledge Kit root. The Agent's separate `notes-vault` MCP tool
requires its own package and vault configuration. See the
[Knowledge guide](../../docs/guides/knowledge.md) for the document API and
the separate store/index API.

### Command skills
Markdown files under the manifest's `prompts.source` directory are read IN
PLACE as read-only command skills, and are exposed as quick actions in the
Layout's tab and global action bars. `prompts` is the plugin MANIFEST's own
field name — the manifest's `skills` field already means the skill-package
list, so the two cannot be merged.

When a command skill declares variables, Station validates its arguments before
sending the expanded text. Variable values are inserted literally. See the
[command argument guide](../../docs/guides/commands.md#parameter-expansion).

## File Structure

```
enterprise-layout/
├── plugin.json                    # Plugin manifest
├── layout.json                    # Layout definition (tabs, actions, agents)
├── package.json
├── agents/
│   └── enterprise-assistant/
│       └── agent.json             # Agent config (model, tools, permissions)
├── integrations/
│   ├── crm/integration.json       # CRM MCP server declaration
│   └── calendar/integration.json  # Calendar MCP server declaration
├── prompts/                       # Manifest `prompts.source` — read as command skills
│   └── daily.md                   # One command skill
└── src/
    ├── index.tsx                   # Entry point — exports named components
    └── data/
        ├── init.ts                # Provider registration
        ├── providers.ts           # Provider interfaces (contracts)
        ├── providerTypes.ts       # Type map + required providers
        ├── viewmodels.ts          # Shared data shapes
        └── providers/
            ├── calendar.ts        # Outlook MCP → ICalendarProvider
            ├── crm.ts             # Salesforce MCP → ICRMProvider + IUserProvider
            ├── email.ts           # Outlook MCP → IEmailProvider
            └── directory.ts       # Stub IInternalProvider
```

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Daily Overview` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `enterprise-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `enterprise-assistant`; Station supplies installation ownership. |
| Calendar / CRM actions referenced missing activity, outreach, and report prompts | Authored prompt files supply those three owner-qualified host actions; tab-local **Review** buttons focus their single host control. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local Review buttons focus the matching host control before invocation. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in [the example migration](https://github.com/kontourai/station/issues/265) is complete.
