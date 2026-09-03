# Enterprise Workspace Pane Example

A full-featured UI plugin demonstrating how to build an integrated workspace with calendar, CRM, email, and notes — all backed by MCP tool providers.

## Patterns Demonstrated

### Multi-Provider Architecture
Each `workspacePanes` mode declares `requiredProviders` in `plugin.json` and registers typed provider implementations at startup via `src/data/init.ts`. Each provider maps MCP tool calls into view models that UI components consume through React Query hooks.

```
plugin.json (workspacePanes.requiredProviders) → providerTypes.ts (type map) → init.ts (registration) → providers/*.ts (implementations)
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
pane action surfaces. `prompts` is the plugin MANIFEST's own
field name — the manifest's `skills` field already means the skill-package
list, so the two cannot be merged.

## File Structure

```
enterprise-layout/
├── plugin.json                    # Manifest and Workspace Pane declarations
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
