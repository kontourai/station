# Frontend Patterns

> **For AI Agents**: If you encounter a pattern not documented here, add it after implementing. This file is the source of truth for frontend conventions.

## Architecture Overview

### 4-Layer Data Architecture

The frontend uses a 4-layer architecture for data management. **All new data fetching should follow this pattern:**

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: View Layer (Components)                           │
│  - Pure rendering, no business logic                        │
│  - Consumes ViewModel hooks                                 │
└─────────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: ViewModel Layer (Custom Hooks)                    │
│  - Component-specific business logic                        │
│  - Combines multiple queries, derives state                 │
│  - Lives in plugin or component directory                   │
└─────────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Query Hooks (SDK)                                 │
│  - useAgentsQuery, useProjectLayoutsQuery                  │
│  - Wraps React Query with consistent config                 │
│  - Lives in packages/sdk/src/queries.ts                     │
└─────────────────────────────────────────────────────────────┘
                            ↑
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Query Factories (SDK)                             │
│  - Single source of truth for query definitions             │
│  - Used by hooks AND imperative fetching (slash commands)   │
│  - Lives in packages/sdk/src/queryFactories.ts              │
└─────────────────────────────────────────────────────────────┘
```

### File Organization

```
packages/sdk/src/
├── queryFactories.ts    # Layer 1: Query definitions
├── queries.ts           # Layer 2: Query hooks
├── hooks.ts             # Context wrapper hooks
├── api.ts               # Low-level API utilities
└── ...

src-ui/src/
├── components/          # Shared UI components
├── contexts/            # React contexts (wired to SDK)
├── layouts/             # Installed plugins
└── ...

examples/my-plugin/
├── useMyViewModel.ts    # Layer 3: Plugin-specific ViewModel
├── useMyQueries.ts      # Plugin-specific query hooks (if needed)
├── MyComponent.tsx      # Layer 4: View
└── ...
```

## Layer 1: Query Factories

Query factories define the query configuration once, used by both hooks and imperative code:

```typescript
// packages/sdk/src/queryFactories.ts
export const agentQueries = {
  agent: (agentSlug: string) => ({
    queryKey: ['agent', agentSlug],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await fetch(
        `${apiBase}/api/agents/${encodeURIComponent(agentSlug)}`,
      );
      if (response.status === 404) throw new Error('Agent not found');
      if (!response.ok) throw new Error('Failed to fetch agent');
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 5 * 60 * 1000,
  }),

  tools: (agentSlug: string) => ({
    queryKey: ['agent-tools', agentSlug],
    queryFn: async () => { /* ... */ },
    staleTime: 5 * 60 * 1000,
  }),

  stats: (agentSlug: string, conversationId: string) => ({
    queryKey: ['stats', agentSlug, conversationId],
    queryFn: async () => { /* ... */ },
    staleTime: 30 * 1000,
  }),
};
```

**When to add to query factories:**
- Query is used by both hooks AND imperative code (slash commands)
- Query needs consistent cache key across the app

## Layer 2: Query Hooks (SDK)

Query hooks wrap React Query and are exported from the SDK:

```typescript
// packages/sdk/src/queries.ts
import { agentQueries } from './queryFactories';

// Hook that uses a factory
export function useAgentToolsQuery(agentSlug: string | undefined, config?: QueryConfig) {
  return useQuery({
    ...agentQueries.tools(agentSlug!),
    ...config,
    enabled: !!agentSlug && (config?.enabled ?? true),
  });
}

// Hook for custom queries
export function useInvokeAgent<T = any>(
  agentSlug: string,
  content: string,
  options?: { schema?: any },
  config?: QueryConfig<T>
) {
  return useQuery({
    queryKey: ['invoke', agentSlug, content, options],
    queryFn: () => invokeAgent(agentSlug, content, options),
    staleTime: config?.staleTime ?? 5 * 60 * 1000,
    enabled: config?.enabled ?? true,
  });
}
```

**Available SDK Query Hooks:**

Agents:
- `useAgentsQuery` — All agents
- `useAgentToolsQuery(agentSlug)` — Tools for an agent
- `useAgentInvokeMutation(agentSlug)` — Invoke agent (mutation)

Projects:
- `useProjectsQuery` — All projects
- `useProjectQuery(slug)` — Single project
- `useProjectLayoutsQuery(projectSlug)` — Layouts for a project
- `useCreateProjectMutation` — Create project
- `useUpdateProjectMutation` — Update project
- `useDeleteProjectMutation` — Delete project

Layouts:
- `useProjectLayoutQuery(projectSlug, layoutSlug)` — Single project layout
- `useProjectLayoutsQuery(projectSlug)` — Project layouts
- `useCreateLayoutMutation(projectSlug)` — Create layout
- `useAddLayoutFromPluginMutation(projectSlug)` — Add layout from plugin

Conversations:
- `useConversationsQuery(agentSlug)` — Conversations for agent
- `useProjectConversationsQuery(projectSlug)` — Conversations for project
- `conversationQueries.list(agentSlug)` — Shared conversation query config for `useQueries`/imperative reuse
- `useRenameConversationMutation` — Rename a conversation
- `useDeleteConversationMutation` — Delete a conversation
- `useStatsQuery(agentSlug, conversationId)` — Conversation stats

Knowledge:
- `useKnowledgeNamespacesQuery(projectSlug)` — Namespaces
- `useKnowledgeDocsQuery(projectSlug, namespace)` — Documents
- `useKnowledgeSearchQuery(projectSlug, query, namespace)` — Search
- `useKnowledgeDocContentQuery(projectSlug, docId)` — Document content
- `useKnowledgeStatusQuery(projectSlug)` — Indexing status
- `useKnowledgeSaveMutation(projectSlug)` — Save document
- `useKnowledgeDeleteMutation(projectSlug)` — Delete document
- `useKnowledgeBulkDeleteMutation(projectSlug)` — Bulk delete
- `useKnowledgeScanMutation(projectSlug)` — Scan directory

Plugins:
- `usePluginsQuery` — Installed plugins
- `usePluginUpdatesQuery` — Available updates
- `useRegistryPluginsQuery` — Registry catalog
- `usePluginSettingsQuery(pluginName)` — Plugin settings schema + values
- `usePluginChangelogQuery(pluginName)` — Plugin changelog metadata
- `usePluginProvidersQuery(pluginName)` — Provider override state
- `usePluginInstallMutation` — Install plugin
- `usePluginPreviewMutation` — Preview before install
- `usePluginUpdateMutation` — Update plugin
- `usePluginRemoveMutation` — Remove plugin
- `usePluginSettingsMutation` — Save plugin settings
- `usePluginProviderToggleMutation` — Toggle provider
- `usePluginRegistryInstallMutation` — Install from registry
- `useReloadPluginsMutation` — Reload plugin providers

ACP:
- `useAcpCommandsQuery(agentSlug)` — ACP slash-command discovery
- `fetchAcpCommandOptions(agentSlug, partial)` — ACP slash-command autocomplete

Models & Config:
- `useModelsQuery` — Available models
- `useModelCapabilitiesQuery` — Model capabilities
- `useConfigQuery` — App configuration

Other:
- `useUsageQuery` — Token usage stats
- `useAchievementsQuery` — Usage achievements
- `useGitStatusQuery(projectSlug)` — Git status
- `useGitLogQuery(projectSlug)` — Git log

Utilities:
- `useInvokeAgent(agent, content, options)` — Agent invocation with schema
- `useApiQuery(queryKey, queryFn, config)` — Generic custom queries
- `useApiMutation(mutationFn, options)` — Generic custom mutations
- `useInvalidateQuery` — Cache invalidation helper

## Layer 3: ViewModel Hooks

ViewModel hooks combine queries and add business logic. **These live in the plugin/component, NOT in SDK:**

```typescript
// examples/my-plugin/useMyViewModel.ts
import { useInvokeAgent, useAgents, callTool } from '@kontourai/station-sdk';

export function useFilesViewModel() {
  // Use SDK query hooks
  const { data: fileList } = useInvokeAgent(
    'my-agent',
    'List files in /documents'
  );
  
  // Use callTool for direct MCP tool calls
  // const result = await callTool('my-agent', 'files_read_file', { path: selectedFile });
  
  // Derived state (business logic)
  const fileDetails = fileList ? {
    name: fileList.name,
    path: fileList.path
  } : null;
  
  const processedAccounts = myAccounts.map(member => ({
    ...member.account,
    _sources: [{ type: 'owner', label: userDetails?.alias }]
  }));
  
  return { 
    userDetails, 
    processedAccounts, 
    isLoading: !myDetails 
  };
}
```

**ViewModel responsibilities:**
- Combine multiple queries
- Derive computed state
- Format data for display
- Handle loading/error states

**ViewModel should NOT:**
- Contain JSX
- Make direct fetch calls (use SDK hooks)
- Be placed in SDK (plugin-specific logic stays in plugin)

## Layer 4: View Components

Components consume ViewModels and render UI:

```typescript
// examples/my-plugin/CRM.tsx
import { useCRMViewModel } from './useCRMViewModel';

export function CRM() {
  const vm = useCRMViewModel();
  
  if (vm.isLoading) return <Loading />;
  
  return (
    <div className="crm-container">
      <UserHeader user={vm.userDetails} />
      <AccountList accounts={vm.processedAccounts} />
    </div>
  );
}
```

**View responsibilities:**
- Render UI based on ViewModel state
- Handle user interactions (call ViewModel actions)
- Apply styling

**View should NOT:**
- Contain business logic
- Make API calls
- Transform data

## SDK vs Core vs Plugin Boundaries

### What belongs in SDK (`packages/sdk/`)

- Query factories (`queryFactories.ts`)
- Query hooks (`queries.ts`)
- Context wrapper hooks (`hooks.ts`)
- API utilities (`api.ts`, `transformTool`, `invokeAgent`)
- Shared types
- Generic UI components (`Button`, `Pill`, `AutoSelectModal`)

### What belongs in Core (`src-ui/src/`)

- React contexts (actual implementations)
- SDK Adapter (wires contexts to SDK)
- App Shell (Header, ChatDock, routing)
- Management Views (Settings, AgentEditor)

### What belongs in Plugins (`examples/*/`)

- ViewModel hooks (business logic)
- Plugin-specific query hooks (if SDK doesn't cover it)
- View components
- Plugin-specific utilities
- Plugin-specific styles

### Key Principle

**Plugins import from SDK only. If a plugin needs functionality not in SDK, extend the SDK.**

```typescript
// ✅ Correct - plugin imports from SDK
import { useInvokeAgent, useAgents, useSendToChat } from '@kontourai/station-sdk';

// ❌ Wrong - plugin imports from core
import { useAgents } from '@/contexts/AgentsContext';
```

## SDK Hook Categories

### Context Hooks (wrap core contexts)

```typescript
// Agent/Layout data
useAgents()              // All agents
useAgent(slug)           // Single agent
useLayouts()          // All layouts
useLayout(slug)       // Single layout

// Chat operations
useCreateChatSession()   // Create new chat
useSendMessage()         // Send message
useSendToChat(agentSlug) // Send + open dock (convenience)

// Navigation
useNavigation()          // Full navigation state
useDockState()           // Dock open/close

// Other
useToast()               // Toast notifications
useConfig()              // App configuration
useModels()              // Available models
```

### Query Hooks (wrap React Query)

```typescript
// Pre-built queries
useAgentsQuery()
useProjectLayoutsQuery(projectSlug)
useConversationsQuery(agentSlug)
useModelsQuery()
useStatsQuery(agentSlug, conversationId)

// Tool invocation
useInvokeAgent(agent, content, options)

// Generic
useApiQuery(queryKey, queryFn, config)
useApiMutation(mutationFn, options)
```

## Component Size Guidelines

| Threshold | Action |
|-----------|--------|
| < 300 lines | Acceptable |
| 300-500 lines | Consider extraction |
| > 500 lines | Must extract |

### Extraction Pattern

1. **Extract ViewModel** for business logic
2. **Extract sub-components** for UI sections
3. **Extract CSS** to replace inline styles

## Styling Patterns

### CSS Variables (Required)

```css
/* ✅ Correct */
.my-component {
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
}

/* ❌ Wrong */
.my-component {
  background: #ffffff;
  color: archive#333;
}
```

### No Inline Styles

```typescript
// ❌ Avoid
<div style={{ padding: '8px', background: '#fff' }}>

// ✅ Prefer
<div className="my-container">
```

## Plugin Development Workflow

```bash
# 1. Make changes in examples/my-layout/
# 2. Remove and reinstall
station plugin remove my-layout
station plugin install ./examples/my-layout

# 3. Test
npm run dev:ui
```

## Logging

```typescript
import { log } from '@/utils/logger';

log.context('State updated:', newState);
log.api('API call:', endpoint);
log.chat('Message:', message);
```

Enable in browser: `localStorage.debug = 'app:*'`

**Never use `console.log()` in production code.**

## Common Pitfalls

1. **Business logic in components** - Extract to ViewModel hooks
2. **Direct API calls in components** - Use SDK query hooks
3. **Plugin importing from core** - Use SDK only
4. **ViewModel in SDK** - Keep plugin logic in plugin
5. **Hardcoded colors** - Use CSS variables
6. **Inline styles** - Extract to CSS classes
7. **Large components** - Extract when > 300 lines
8. **console.log** - Use structured logging

## packages/connect

Connection management for multi-device and remote Station instances. Handles
saving/loading server URLs, tracking connection status, one-tap same-origin
access requests, fallback QR/manual pairing, and endpoint discovery.

### When to use

Use `packages/connect` when building UI that needs to:
- Let users add, switch, or remove Station server connections
- Show live connection status (connected / disconnected / error)
- Request access from the Station currently open in a browser, with approval
  from an already trusted session
- Generate or scan QR codes as an advanced pairing fallback
- Feed discovered endpoint candidates into the connection picker without
  treating reachability as trust

### Exports

```typescript
// Core (framework-agnostic)
import {
  ConnectionStore,          // manages saved connections in storage
  LocalStorageAdapter,      // default browser storage adapter
  defaultStorage,           // pre-built LocalStorageAdapter instance
} from '@kontourai/station-connect';

// Types
import type {
  SavedConnection,          // { id, name, url, ... }
  StorageAdapter,           // interface for custom storage backends
  ConnectionStatus,         // 'connected' | 'disconnected' | 'error' | 'checking'
  ConnectionCandidate,      // unverified provider reachability hint
  ConnectionCandidateProvider,
} from '@kontourai/station-connect';

// React
import {
  ConnectionsProvider,      // context provider — wrap app root
  useConnections,           // access saved connections + CRUD
  useConnectionStatus,      // live status for a given connection URL
  useHostUrl,               // resolve the active host URL
  useConnectionCandidates, // consume registered host/provider suggestions
  registerConnectionCandidateProvider,
  QRDisplay,                // render a QR code for a URL
  QRScanner,                // scan a QR code from camera
  ConnectionManagerModal,   // full connection management UI
  ConnectionStatusDot,      // small status indicator dot
} from '@kontourai/station-connect';
```

### Usage pattern

```typescript
// 1. Wrap your app
<ConnectionsProvider>
  <App />
</ConnectionsProvider>

// 2. Use in components
const { connections, addConnection, removeConnection, activeConnection } = useConnections();
const { status } = useConnectionStatus({ url: activeConnection?.url });
const { url } = useHostUrl();
```

### What belongs here vs SDK

- `packages/connect` — connection lifecycle, pairing, discovery, status
- `packages/sdk` — data fetching against a known connected server

---

## packages/shared

Shared runtime helpers plus compatibility re-exports. Canonical API and domain ownership lives in `packages/contracts`; `shared` remains the place for config parsers and runtime-safe utilities consumed by `src-server`, `packages/sdk`, and `packages/cli`.

### When to import from shared vs SDK

| Need | Import from |
|---|---|
| Contract-owned types (AgentSpec, PluginManifest, LayoutConfig, AuthStatus, etc.) | `@kontourai/station-contracts/*` |
| Compatibility re-exports and runtime helpers | `@kontourai/station-shared` |
| Config file parsers (readPluginManifest, readAgentSpec, etc.) | `@kontourai/station-shared/parsers` |
| Plugin build helpers | `@kontourai/station-shared/build` |
| Git helpers | `@kontourai/station-shared/git` |
| React Query hooks for fetching data | `@kontourai/station-sdk` |
| Context hooks (useAgents, useLayouts, etc.) | `@kontourai/station-sdk` |

**Rule:** If it is a stable cross-package contract, it belongs in `contracts`. If it is a runtime helper or compatibility export usable in Node and the browser, it belongs in `shared`. If it requires React or browser APIs, it belongs in `sdk`.

### Key exports

```typescript
// Contracts
import type {
  AgentSpec, AgentMetadata, AgentGuardrails, AgentTools,
} from '@kontourai/station-contracts/agent';
import type { AuthStatus, UserDetailVM, UserIdentity } from '@kontourai/station-contracts/auth';
import type { InstallResult, RegistryItem } from '@kontourai/station-contracts/catalog';
import type { AppConfig, TemplateVariable } from '@kontourai/station-contracts/config';
import type { LayoutConfig, LayoutMetadata, LayoutTab } from '@kontourai/station-contracts/layout';
import type { ConflictInfo, PluginComponent, PluginManifest, PluginPreview } from '@kontourai/station-contracts/plugin';
import type {
  AgentInvokeResponse,
  AgentSwitchState,
  ConversationStats,
  MemoryEvent,
  SessionMetadata,
  ToolCallResponse,
} from '@kontourai/station-contracts/runtime';
import type { Prerequisite, ToolDef, ToolMetadata } from '@kontourai/station-contracts/tool';

// Config parsers
import {
  readPluginManifest,     // parse plugin.json
  readAgentSpec,          // parse agent JSON
  readLayoutConfig,       // parse layout JSON
  readIntegrationDef,     // parse integration.json
  listIntegrationIds,     // list integration IDs from an integrations/ dir
  resolvePluginIntegrations, // resolve all integrations declared by a plugin
  copyPluginIntegrations, // copy plugin integrations/ to project integrations dir
} from '@kontourai/station-shared/parsers';

import {
  buildPlugin,            // build a plugin if it has a build script
} from '@kontourai/station-shared/build';

import {
  resolveGitInfo,         // get git root, branch, hash, remote
} from '@kontourai/station-shared/git';
```

> **Note:** Permission helpers (`getPermissionTier`, `needsConsent`, `processInstallPermissions`) live in `src-server/services/plugins/plugin-permissions.ts` — server-only, not exported from shared.

### Do not redefine contract types

If you need a type that describes an agent, layout, tool, plugin, runtime response, scheduler entity, or notification payload, check `@kontourai/station-contracts/*` first. Use `@kontourai/station-shared` for helper functions and compatibility re-exports. Adding duplicate type definitions in `src-server`, `packages/sdk`, or plugins causes drift and breaks the contract between layers.
