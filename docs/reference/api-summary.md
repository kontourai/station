# Station API Summary

## Endpoint Overview

### Station Endpoints (~212 endpoints total):

#### Agent Management (5)
- `GET /api/agents` - Enriched agent list
- `POST /agents` - Create agent
- `PUT /agents/:slug` - Update agent
- `DELETE /agents/:slug` - Delete agent
- `GET /agents/:slug/health` - Health check

#### Integration Management (9)
- `GET /integrations` - List all integrations
- `POST /integrations` - Create integration
- `GET /integrations/:id` - Get integration
- `PUT /integrations/:id` - Update integration
- `DELETE /integrations/:id` - Delete integration
- `GET /agents/:slug/tools` - Get agent tools with schemas
- `POST /agents/:slug/tools` - Add tool to agent
- `DELETE /agents/:slug/tools/:toolId` - Remove tool
- `PUT /agents/:slug/tools/allowed` - Update allow-list

#### Layout Management
- Standalone `/layouts` endpoints were removed.
- Use project-scoped layout endpoints under `/api/projects/:slug/layouts`.

#### Workflow Management (5)
- `GET /agents/:slug/workflows/files` - List workflows
- `GET /agents/:slug/workflows/:workflowId` - Get workflow
- `POST /agents/:slug/workflows` - Create workflow
- `PUT /agents/:slug/workflows/:workflowId` - Update workflow
- `DELETE /agents/:slug/workflows/:workflowId` - Delete workflow

#### Conversation Management (6)
- `GET /agents/:slug/conversations` - List conversations
- `GET /agents/:slug/conversations/:id/messages` - Get messages
- `PATCH /agents/:slug/conversations/:id` - Update conversation
- `DELETE /agents/:slug/conversations/:id` - Delete conversation
- `POST /api/agents/:slug/conversations/:id/context` - Manage context
- `GET /agents/:slug/conversations/:id/stats` - Get statistics

#### Configuration (2)
- `GET /config/app` - Get app config
- `PUT /config/app` - Update app config

#### Connections (9)
- `GET /api/connections` - List model and runtime connections
- `GET /api/connections/models` - List model/provider connections
- `GET /api/connections/runtimes` - List runtime connections with runtime-scoped model metadata
- `GET /api/connections/model-inventory` - Contributed-subset manifest (`station.fleet-contribution/v1`); requires `inference:invoke` since station#1398 slice 2 — no longer the full launchable inventory
- `GET /api/connections/:id` - Get one connection
- `POST /api/connections` - Create a connection
- `PUT /api/connections/:id` - Update a connection
- `DELETE /api/connections/:id` - Delete or reset a connection
- `POST /api/connections/:id/test` - Run a connection health check

#### Fleet Inference (2)
Whole family requires `inference:invoke` (station#1398 slice 2). Like every
protected family, it rejects a credential-less loopback caller; completions
only — never `delegate_task`.
- `GET /api/inference/manifest` - Read the contributed-model manifest (the only place participation is readable)
- `POST /api/inference/completions` - Serve one buffered completion on a contributed model (120s deadline, abort-on-disconnect)

#### Bedrock Models (4)
- `GET /bedrock/models` - List models
- `GET /bedrock/pricing` - Get pricing
- `GET /bedrock/models/:modelId/validate` - Validate model
- `GET /bedrock/models/:modelId` - Get model info

#### Analytics (4)
- `GET /api/analytics/usage` - Usage statistics
- `GET /api/analytics/achievements` - Achievements
- `POST /api/analytics/rescan` - Rescan analytics
- `DELETE /api/analytics/usage` - Clear usage data

#### Monitoring (3)
- `GET /monitoring/stats` - System stats
- `GET /monitoring/metrics` - Historical metrics
- `GET /monitoring/events` - Events (SSE stream)

#### Agent Invocation (4)
- `POST /api/agents/:slug/chat` - Custom chat stream (SSE)
- `POST /agents/:slug/invoke` - Silent invocation (no memory)
- `POST /agents/:slug/tools/:toolName` - Raw tool call
- `POST /agents/:slug/invoke/stream` - Streaming invocation

#### Standalone Model Capability Routes (2)
- `GET /api/models/capabilities` - Model capabilities (cached 1h)
- `GET /api/models/pricing/:modelId` - Per-model pricing (standalone route)

#### Auth & Users (6)
- `GET /auth/status` - Auth status and user identity
- `POST /auth/renew` - Credential renewal
- `POST /auth/terminal` - Terminal-based auth renewal
- `GET /auth/badge-photo/:id` - User badge/profile photo (JPEG)
- `GET /users/search` - Search user directory
- `GET /users/:alias` - Lookup user by alias

#### Branding (1)
- `GET /branding` - Resolved branding config

#### Events (SSE) (1)
- `GET /events` - Real-time SSE event stream (all server events)

#### File System (1)
- `GET /fs/browse` - Browse directories (UI directory picker)

#### Insights (1)
- `GET /insights` - Aggregated usage insights (tool, hourly, agent, model)

#### Plugins (16)
- `GET /plugins` - List installed plugins
- `POST /plugins/preview` - Pre-install validation
- `POST /plugins/install` - Install plugin
- `GET /plugins/check-updates` - Check for updates
- `POST /plugins/:name/update` - Update plugin
- `DELETE /plugins/:name` - Remove plugin
- `GET /plugins/:name/bundle.js` - Serve plugin JS bundle
- `GET /plugins/:name/bundle.css` - Serve plugin CSS bundle
- `GET /plugins/:name/permissions` - Get plugin permissions
- `POST /plugins/:name/grant` - Grant permissions
- `POST /plugins/:name/fetch` - Scoped HTTP proxy
- `POST /plugins/fetch` - Unscoped HTTP proxy (no permission check)
- `POST /plugins/reload` - Reload all plugin providers
- `GET /plugins/:name/providers` - Get plugin providers
- `GET /plugins/:name/overrides` - Get provider overrides
- `PUT /plugins/:name/overrides` - Update provider overrides

#### Registry (16)
- `GET /registry/agents` - List available agents
- `GET /registry/agents/installed` - List installed agents
- `POST /registry/agents/install` - Install agent
- `DELETE /registry/agents/:id` - Uninstall agent
- `GET /registry/integrations` - List available integrations
- `GET /registry/integrations/installed` - List installed integrations
- `POST /registry/integrations/install` - Install integration
- `DELETE /registry/integrations/:id` - Uninstall integration
- `POST /registry/integrations/sync` - Sync integration registry
- `GET /registry/skills` - List available skills
- `POST /registry/skills/install` - Install skill
- `DELETE /registry/skills/:id` - Uninstall skill
- `GET /registry/plugins` - List available plugins
- `GET /registry/plugins/installed` - List installed plugins
- `POST /registry/plugins/install` - Install plugin
- `DELETE /registry/plugins/:id` - Uninstall plugin

#### Scheduler (16)
- `GET /scheduler/providers` - List scheduler providers
- `GET /scheduler/events` - Scheduler SSE event stream
- `POST /scheduler/webhook` - Webhook receiver
- `GET /scheduler/jobs` - List scheduled jobs
- `GET /scheduler/stats` - Scheduler stats
- `GET /scheduler/status` - Scheduler status
- `GET /scheduler/jobs/preview-schedule` - Preview cron schedule
- `GET /scheduler/jobs/:target/logs` - Get job logs
- `POST /scheduler/runs/output` - Read run output
- `POST /scheduler/jobs` - Create job
- `PUT /scheduler/jobs/:target` - Update job
- `POST /scheduler/jobs/:target/run` - Run job now
- `PUT /scheduler/jobs/:target/enable` - Enable job
- `PUT /scheduler/jobs/:target/disable` - Disable job
- `DELETE /scheduler/jobs/:target` - Delete job

### Independent review evidence

- `POST /api/projects/:projectSlug/reviews` - Idempotently submit or join an independent review by caller-generated request ID
- `GET /api/projects/:projectSlug/reviews/requests/:requestId` - Recover the durable running, completed, rejected, or indeterminate request status
- `GET /api/projects/:projectSlug/reviews` - List durable receipts for one Project
- `GET /api/projects/:projectSlug/reviews/:receiptId` - Read one exact Project-bound receipt
- `GET /api/review-evidence` - List receipts across Projects for Review Queue
- `POST /scheduler/open` - Open file with OS handler

#### System (11)
- `GET /system/status` - System readiness status
- `POST /system/verify-bedrock` - Verify Bedrock credentials
- `GET /system/core-update` - Check for core app update
- `POST /system/core-update` - Apply core app update
- `GET /system/capabilities` - Server runtime capabilities
- `GET /system/discover` - LAN discovery beacon
- `GET /system/runtime` - Runtime info
- `GET /system/skills` - List skills
- `GET /system/terminal-port` - Terminal port info
- `GET /system/voice-port` - Voice WS port info

#### ACP (8)
- `GET /acp/status` - ACP connection status
- `GET /acp/commands/:slug` - Slash commands for an ACP-connected engine
- `GET /acp/commands/:slug/options` - Slash command autocomplete
- `GET /acp/connections` - List ACP connections
- `POST /acp/connections` - Add ACP connection
- `PUT /acp/connections/:id` - Update ACP connection
- `DELETE /acp/connections/:id` - Remove ACP connection
- `POST /acp/connections/:id/reconnect` - Reconnect ACP connection

#### Knowledge (14)
- `GET /api/projects/:slug/knowledge` - List documents
- `GET /api/projects/:slug/knowledge/status` - Index status
- `POST /api/projects/:slug/knowledge/upload` - Upload document
- `POST /api/projects/:slug/knowledge/scan` - Scan directories
- `POST /api/projects/:slug/knowledge/search` - Semantic search
- `POST /api/projects/:slug/knowledge/bulk-delete` - Bulk delete documents
- `GET /api/projects/:slug/knowledge/:docId/content` - Get document content
- `DELETE /api/projects/:slug/knowledge/:docId` - Delete document
- `DELETE /api/projects/:slug/knowledge` - Delete all documents
- `GET /api/projects/:slug/knowledge/namespaces` - List namespaces
- `POST /api/projects/:slug/knowledge/namespaces` - Create namespace
- `DELETE /api/projects/:slug/knowledge/namespaces/:nsId` - Delete namespace
- `PUT /api/projects/:slug/knowledge/namespaces/:nsId` - Update namespace
- `POST /api/knowledge/search` - Cross-project search

#### Projects (12)
- `GET /api/projects` - List projects
- `POST /api/projects` - Create project
- `GET /api/projects/:slug` - Get project
- `PUT /api/projects/:slug` - Update project
- `DELETE /api/projects/:slug` - Delete project
- `GET /api/projects/:slug/layouts` - List project layouts
- `POST /api/projects/:slug/layouts` - Add layout to project
- `GET /api/projects/:slug/layouts/:layoutSlug` - Get project layout
- `PUT /api/projects/:slug/layouts/:layoutSlug` - Update project layout
- `DELETE /api/projects/:slug/layouts/:layoutSlug` - Remove layout from project
- `GET /api/projects/layouts/available` - Available layout sources
- `POST /api/projects/:slug/layouts/from-plugin` - Add layout from plugin

#### Notifications (8)
- `GET /notifications` - List notifications (filterable by status/category)
- `POST /notifications` - Create notification
- `DELETE /notifications/:id` - Dismiss notification
- `POST /notifications/:id/action/:actionId` - Execute notification action
- `POST /notifications/:id/snooze` - Snooze notification
- `DELETE /notifications/activity` - Clear ordinary and resolved activity while preserving active approvals
- `DELETE /notifications` - Clear all notifications
- `GET /notifications/providers` - List notification providers

#### Attention (1)
- `GET /api/attention` - Read-only deduplicated projection of active approval notifications and orchestration sessions that need input or review

#### Templates (4)
- `GET /api/templates` - List templates
- `GET /api/templates/:id` - Get template
- `POST /api/templates` - Create template
- `DELETE /api/templates/:id` - Delete template

#### Voice (4)
- `POST /api/voice/sessions` - Create voice session
- `DELETE /api/voice/sessions/:id` - Destroy voice session
- `GET /api/voice/status` - Active session count
- `GET /api/voice/agent` - Voice agent info

#### Feedback (8)
- `POST /api/feedback/rate` - Rate a message
- `DELETE /api/feedback/rate` - Remove rating
- `GET /api/feedback/ratings` - List ratings
- `GET /api/feedback/guidelines` - Get feedback guidelines
- `POST /api/feedback/analyze` - Analyze feedback
- `POST /api/feedback/clear-analysis` - Clear analysis
- `GET /api/feedback/status` - Feedback service status
- `POST /api/feedback/test` - Test feedback analysis

#### Coding (8)
- `GET /api/coding/files` - List files in project
- `GET /api/coding/files/search` - Search files
- `GET /api/coding/files/content` - Get file content
- `GET /api/coding/git/status` - Git status
- `GET /api/coding/git/log` - Git log
- `GET /api/coding/git/diff` - Git diff
- `GET /api/coding/git/branches` - Git branches
- `POST /api/coding/exec` - Execute command

#### Providers (9)
- `GET /api/providers` - List providers
- `POST /api/providers` - Create provider
- `PUT /api/providers/:id` - Update provider
- `DELETE /api/providers/:id` - Delete provider
- `POST /api/providers/:id/test` - Test provider connection
- `GET /api/providers/:id/health` - Provider health check
- `GET /api/providers/:id/models` - List provider models
- `POST /api/providers/:id/test-embedding` - Test embedding provider
- `POST /api/providers/:id/test-vectordb` - Test vector DB provider

#### Telemetry Events (1)
- `POST /api/telemetry/events` - Ingest plugin telemetry events

#### Global Routes (3)
- `POST /invoke` - Lightweight multi-turn invocation (no named agent)
- `POST /tool-approval/:approvalId` - Approve/reject pending tool call
- `GET /api/conversations/:id` - Global conversation lookup

#### UI Commands (1)
- `POST /api/ui` - Dispatch UI command to frontend

---

## Category Breakdown

| Category | Count |
|----------|-------|
| Agent Management | 5 |
| Integration Management | 9 |
| Layout Management | 5 |
| Workflow Management | 5 |
| Conversation Management | 6 |
| Configuration | 2 |
| Connections | 8 |
| Bedrock Models | 4 |
| Analytics | 4 |
| Monitoring | 3 |
| Agent Invocation | 4 |
| Standalone Model Capability Routes | 2 |
| Auth & Users | 6 |
| Branding | 1 |
| Events (SSE) | 1 |
| File System | 1 |
| Insights | 1 |
| Plugins | 16 |
| Registry | 16 |
| Scheduler | 16 |
| System | 10 |
| ACP | 8 |
| Knowledge | 14 |
| Projects | 12 |
| Notifications | 8 |
| Attention | 1 |
| Prompts | 6 |
| Templates | 4 |
| Voice | 4 |
| Feedback | 8 |
| Coding | 8 |
| Providers | 9 |
| Telemetry Events | 1 |
| Global Routes | 3 |
| UI Commands | 1 |
| **Total** | **~212** |

---

## Frontend Usage

### React Contexts Using API

| Context | Endpoints |
|---------|-----------|
| `AgentsContext` | `/api/agents`, `/agents/:slug` (CRUD) |
| `LayoutsContext` | removed during project-layout convergence |
| `ConversationsContext` | `/agents/:slug/conversations/*`, `/api/agents/:slug/chat` |
| `StatsContext` | `/agents/:slug/conversations/:id/stats` |
| `ConfigContext` | `/config/app` |
| `ModelsContext` | `/bedrock/models` |
| `AppDataContext` | `/bedrock/models` |
| `AnalyticsContext` | `/api/analytics/*` |
| `MonitoringContext` | `/monitoring/stats`, `/monitoring/events` |
| `WorkflowsContext` | `/agents/:slug/workflows/files` |
| `AuthContext` | `/api/auth/status`, `/api/auth/renew` |

### Hooks Using API

| Hook | Endpoints |
|------|-----------|
| `useConnectionsQuery` / `useConnectionQuery` | `/api/connections`, `/api/connections/:id` |
| `useModelConnectionsQuery` | `/api/connections/models` |
| `useRuntimeConnectionsQuery` | `/api/connections/runtimes` |
| `useSystemStatus` | `/api/system/status`, `/api/system/verify-bedrock` |
| `useServerCapabilities` | `/api/system/capabilities` |
| `useServerEvents` | `/events` (SSE) |
| `useBranding` | `/api/branding` |
| `useScheduler*` | `/scheduler/*` (jobs, stats, status, providers, events, logs) |
| `useACPConnections` | `/acp/connections` |
| `useToolApproval` | `/tool-approval/:approvalId` |
| `useSlashCommands` | `/acp/commands/:agentSlug` |

### Components with Direct API Calls

| Component/View | Endpoints |
|----------------|-----------|
| `PluginManagementView` | `/api/plugins/*`, `/api/fs/browse` |
| `ConnectionsHub` | `/api/connections` |
| `RuntimeConnectionView` | `/api/connections/runtimes`, `/api/connections/:id`, `/api/connections/:id/test` |
| `ProviderSettingsView` / `KnowledgeConnectionView` | `/api/connections/models`, `/api/connections/:id`, `/api/connections/:id/test` |
| `ToolsView` | `/api/registry/tools`, `/tools` |
| `SettingsView` | `/api/system/status`, `/api/system/core-update` |
| `AgentEditorView` | `/api/agents`, `/tools`, `/agents/default/invoke` |
| Deleted tool-management view | No UI consumer; `/tools`, `/agents`, and `/agents/:slug/tools` server/CLI routes remain live |
| `InsightsDashboard` | `/api/insights/insights` |
| `ActivityTimeline` | `/api/analytics/usage` |
| `UsageStatsPanel` | `/api/analytics/usage` (DELETE) |
| `ACPConnectionsSection` | `/acp/connections` (CRUD) |
| `NewChatModal` / chat dock / agent runtime editor | `/api/connections/models`, `/api/connections/runtimes` |
| `UserDetailModal` | `/api/users/:alias` |
| `OnboardingGate` / `Header` | `/api/system/status` |

---

## Key Differences

### `/agents` vs `/api/agents`

- **`GET /agents`** - Basic agent info (not used by frontend)
- **`GET /api/agents`** (🟢 Custom) - Enriched with config, tools, metadata

### Agent Invocation

- **`POST /agents/:slug/invoke`** (🟢 Custom) - Silent invocation without memory loading
- **`POST /agents/:slug/tools/:toolName`** (🟢 Custom) - Direct tool execution

### Auth Endpoints

The frontend uses `/api/auth/*` and `/api/users/*` prefixes (via `apiBase`), while the server registers routes at `/auth/*` and `/users/*`. The `apiBase` value already includes any prefix, so these resolve correctly.

---

## Documentation

- **Complete API Reference**: [api.md](./api.md)
- **Frontend Endpoint Audit**: [endpoints.md](./endpoints.md)
