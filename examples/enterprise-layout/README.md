# Enterprise Layout Example

A full-featured layout plugin demonstrating how to build an integrated workspace with calendar, CRM, email, and notes — all backed by MCP tool providers.

## Patterns Demonstrated

### Multi-Provider Architecture
The layout declares `requiredProviders` in `layout.json` and registers typed provider implementations at startup via `src/data/init.ts`. Each provider maps MCP tool calls into view models that UI components consume through React Query hooks.

```
layout.json (requiredProviders) → providerTypes.ts (type map) → init.ts (registration) → providers/*.ts (implementations)
```

### Provider Contracts (`src/data/providers.ts`)
Typed interfaces (`ICalendarProvider`, `ICRMProvider`, etc.) define the contract between UI and data layer. Implementations can be swapped without changing components.

### MCP Tool Mapping (`src/data/providers/*.ts`)
Each provider calls MCP tools via `callTool` from the SDK, unwraps response envelopes, and maps raw data into view models. See `calendar.ts` for the full pattern.

### Plugin Dependencies
`plugin.json` declares a dependency on `shared-providers` — a separate plugin that contributes auth, user identity, and registry providers. This shows how plugins compose.

### Integration Declarations
MCP servers are declared in `integrations/` as JSON manifests. The agent's `tools.mcpServers` references these by id.

### Knowledge Namespaces
The plugin declares a `notes` knowledge namespace with RAG behavior, enabling semantic search over meeting notes.

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
            └── directory.ts       # LDAP/directory → IInternalProvider
```

## Workspace host action migration

| Previous behavior | Current behavior |
| --- | --- |
| `actions[]` displayed on the Layout | `Daily Overview` appears once in the Project host action bar for direct and placed panes. |
| Layout `defaultAgent` / `availableAgents`, or ambient fallback where absent | `workspacePaneHost.agentSelection` explicitly selects the package-owned `enterprise-assistant`. `requiredAgents` never selects an Agent. |
| Namespaced `package:agent` string | `own-plugin-agent` with clean `enterprise-assistant`; Station supplies installation ownership. |
| Calendar / CRM actions referenced missing activity, outreach, and report prompts | Authored prompt files supply those three owner-qualified host actions; tab-local **Review** buttons focus their single host control. |
| Persisted Layout records | Remain unchanged. The host contribution takes over global action display; tab-local Review buttons focus the matching host control before invocation. |

Grant **agents.invoke** through Library before running the action. The package keeps native Station execution; configure its model connection before running it. A Project configured for worktree isolation provisions its workspace through the canonical execution owner; native Bash and relative file operations use that Session directory. Explicit MCP resource roots retain their configured meaning. No migration silently switches an existing Agent to another engine. Missing connections, Project restrictions, and withdrawn permissions refuse execution rather than selecting another Agent. An uncertain launch is never automatically retried. This semantic migration does not claim all structural migration work in #265 is complete.
