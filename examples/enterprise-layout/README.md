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
composition; the declaration does not configure an enterprise identity service.

### Integration Declarations
MCP servers are declared in `integrations/` as JSON manifests. The agent's `tools.mcpServers` references these by id.

### Knowledge Namespaces
The [manifest](plugin.json) declares a `notes` namespace with RAG behavior.
That declaration alone does not ingest notes, configure embedding/vector
providers, or populate a Knowledge Kit root. The current
[Notes hooks](src/data/notes-hooks.ts) call the older public SDK document API
using `enterprise-notes`, which differs from the declared namespace. Treat
that mismatch as an integration gap when adapting this example. The
[Project layout apply route](../../src-server/routes/projects/projects.ts)
registers manifest namespace IDs unchanged, and the
[SDK path builder](../../packages/sdk/src/api-knowledge-utils.ts) sends the
hook's `enterprise-notes` ID unchanged. These are separate document/vector
partitions, not a host-qualified alias. An undeclared namespace can use the
default storage path, but unscoped RAG search enumerates registered RAG
namespaces and does not discover that partition automatically. Its
Agent's separate `notes-vault` MCP tool also needs its own package and vault
configuration. See the [Knowledge guide](../../docs/guides/knowledge.md) for
the distinction between the older document API and the store/index API.

### Command skills
Markdown files under the manifest's `prompts.source` directory are read IN
PLACE as read-only command skills, and are exposed as quick actions in the
Layout's tab and global action bars. `prompts` is the plugin MANIFEST's own
field name — the manifest's `skills` field already means the skill-package
list, so the two cannot be merged.

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
