# Plugin Development

Plugins are the product — the core provides the foundation. A plugin can contribute layout UIs, agents, MCP tools, provider implementations, and knowledge namespaces. A single plugin can combine any of these.

Plugin-contributed Knowledge Kit store roots are not currently supported. The proposed read-only
root and reader boundary, including lifecycle and filesystem-safety requirements, is documented in
[Plugin-contributed Knowledge stores](../design/plugin-knowledge-store-contributions.md). That
proposal is awaiting owner/architecture ratification and is not a manifest field that plugins can
use yet.

For the shortest path from scaffold to install, start with [Build Your First Plugin](./build-your-first-plugin.md) and use this document as the full reference.
Distribution owners can control whether a plugin layout is shown, enabled, or
available for project use without changing the plugin itself; see
[Distribution Profiles](./distribution-profiles.md).

## Directory Structure

```
my-plugin/
├── plugin.json              # Manifest (required)
├── package.json             # Node package
├── layout.json              # Layout config (tabs, prompts)
├── src/
│   └── index.tsx            # UI entry point — exports `components` map
├── agents/                  # Agent configs (optional)
│   └── assistant/
│       └── agent.json
├── tools/                   # Bundled MCP tool configs (optional)
│   └── my-tool/
│       └── tool.json
└── providers/               # Server-side provider modules (optional)
    └── my-auth.js
```

## plugin.json — Manifest

All fields:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "sdkVersion": "^0.7.0",
  "displayName": "My Plugin",
  "description": "What this plugin does",
  "entrypoint": "src/index.tsx",
  "serverModule": "./plugin.mjs",
  "capabilities": ["chat", "navigation"],
  "permissions": ["navigation.dock"],
  "agents": [
    { "slug": "assistant", "source": "./agents/assistant/agent.json" }
  ],
  "layout": {
    "slug": "my-layout",
    "source": "./layout.json"
  },
  "layouts": [
    { "slug": "layout-a", "source": "./layouts/a.json" },
    { "slug": "layout-b", "source": "./layouts/b.json" }
  ],
  "providers": [
    { "type": "auth", "module": "./providers/auth.js" },
    { "type": "branding", "module": "./providers/branding.js", "layout": "my-layout" }
  ],
  "operationalEventSubscriptions": [
    {
      "id": "runtime-ready",
      "version": "1.0.0",
      "eventTypes": ["station.runtime.lifecycle/v1"],
      "projection": "metadata"
    }
  ],
  "tools": {
    "required": ["my-mcp-tool"]
  },
  "dependencies": [
    { "id": "base-plugin", "source": "git@github.com:org/base-plugin.git" }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique plugin identifier (used as install directory name) |
| `version` | string | yes | Semver version |
| `sdkVersion` | string | no | Semver range of `@kontourai/station-sdk` required |
| `displayName` | string | no | Human-readable name shown in UI |
| `description` | string | no | Short description |
| `entrypoint` | string | no | Path to UI entry point (layout plugins only) |
| `serverModule` | string | no | Path to a server-side module that registers request-scoped plugin routes and lifecycle hooks |
| `build` | string | no | Reserved; currently rejected so builds cannot execute manifest-supplied commands |
| `capabilities` | string[] | no | Declared capabilities, e.g. `["chat", "navigation"]` |
| `permissions` | string[] | no | Permissions the plugin needs (see Permissions) |
| `links` | unknown | no | Opaque link metadata returned by plugin preview; it grants no capability |
| `agents` | array | no | Agent configs to install |
| `layout` | object | no | Single layout config to install |
| `layouts` | array | no | Multiple layout configs to install |
| `workspacePanes` | WorkspacePaneDescriptor[] | no | Portable Pane declarations; cannot be combined with legacy `layout` or `layouts` |
| `workspacePaneHost` | WorkspacePaneHostContributionV1 | no | Inert package-level action and Agent-selection declarations; the server owns admission and authorization |
| `providers` | array | no | Server-side provider modules to load |
| `operationalEventSubscriptions` | array | no | Versioned durable event observations handled by `serverModule`; Station derives identity, grants, and delivery ownership |
| `integrations.required` | string[] | no | Integration IDs required by the plugin |
| `tools.required` | string[] | no | MCP tool IDs that must be installed |
| `dependencies` | array | no | Other plugins this plugin depends on |
| `knowledge.namespaces` | KnowledgeNamespaceConfig[] | no | Knowledge namespace declarations |
| `prompts.source` | string | no | Directory of read-only command-skill Markdown files |
| `skills` | string[] | no | Skill package IDs contributed by the plugin |
| `settings` | PluginSettingField[] | no | Configurable settings (see Settings) |

#### Reserved plugin names

`name` becomes both the install directory and the URL segment your server
module answers, `/api/plugins/<name>/…`. Station mounts some of its own routes
at literal first segments on that same prefix, and those registrations win — so
a plugin installed under one of those names would find Station's routes inside
the namespace it believes it owns. Install refuses these names outright:

```
check-updates   fetch   home-role   host-approvals   install   preview   reload
```

The list is derived from Station's actual route registrations rather than kept
by hand, so it can grow when Station adds a route. Only exact matches are
reserved — `installer` and `home-role-viewer` are fine.

### Provider Entry Fields

```json
{ "type": "auth", "module": "./providers/auth.js", "layout": "my-layout" }
```

| Field | Description |
|-------|-------------|
| `type` | Provider type — built-in types: `auth`, `branding`, `userIdentity`, `userDirectory`, `agentRegistry`, `integrationRegistry`, `skillRegistry`, `pluginRegistry`, `settings`, `scheduler`, `notification`, `llm`, `embedding`, `vectorDb`, `layoutType`, `acpConnections`, `acpConnectionRegistry`, `promptRegistry`, `template`. Custom types also supported via the generic provider registry. |
| `module` | Path to the JS module (relative to plugin root) |
| `layout` | Optional — scope this provider to a specific layout slug |

### Dependency Entry Fields

```json
{ "id": "base-plugin", "source": "git@github.com:org/base-plugin.git" }
```

| Field | Description |
|-------|-------------|
| `id` | Plugin name (must match the dependency's `plugin.json` `name`) |
| `source` | Git URL or local path to install from if not already installed |

### Settings

Plugins can declare configurable settings that users edit in the Plugins UI. Values are persisted in `plugin-overrides.json` and passed to provider factory functions at load time.

```json
{
  "settings": [
    { "key": "apiEndpoint", "label": "API Endpoint", "type": "string", "default": "https://api.example.com" },
    { "key": "maxRetries", "label": "Max Retries", "type": "number", "default": 3 },
    { "key": "verbose", "label": "Verbose Logging", "type": "boolean", "default": false },
    { "key": "apiKey", "label": "API Key", "type": "string", "secret": true },
    { "key": "region", "label": "Region", "type": "select", "options": [
      { "label": "US East", "value": "us-east-1" },
      { "label": "EU West", "value": "eu-west-1" }
    ]}
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Unique key within the plugin |
| `label` | string | yes | Display label in the UI |
| `type` | string | yes | `'string'`, `'number'`, `'boolean'`, or `'select'` |
| `description` | string | no | Help text shown below the field |
| `default` | any | no | Default value when no user value is saved |
| `options` | array | no | For `type: 'select'` — `[{ label, value }]` |
| `secret` | boolean | no | Mask input (for API keys) |
| `required` | boolean | no | Show required indicator |

Provider factory functions receive the current settings as their first argument:

```js
// providers/my-provider.js
module.exports = (settings) => ({
  async doSomething() {
    const endpoint = settings.apiEndpoint || 'https://default.com';
  },
});
```

Settings are reloaded when the user saves — providers are automatically re-instantiated with the new values.

## Plugin registry

The Registry page browses installable plugins from a JSON manifest.

**Out of the box there is nothing to configure.** When `registryUrl` is unset,
Station serves a bundled manifest at `examples/registry/default.json`, so a
fresh install can browse and install working examples immediately. It lists the
dependency-free starters, so installing one never needs the network:

| Plugin | What it shows |
|---|---|
| `getting-started-starter` | Agents, chat dock control, navigation, toast feedback |
| `coding-starter` | File browser, terminal, diff review, chat handoff |
| `knowledge-docs-starter` | Project knowledge ingestion and search |
| `minimal-layout` | The smallest useful layout surface |
| `demo-layout` | A tour of Station capabilities, no external services |
| `smart-routing` | A provider plugin with no UI entrypoint |

The fuller catalog at `examples/registry/manifest.json` adds examples that pull
npm dependencies (`enterprise-layout`, `survey-review-workbench`,
`fieldwork-review`). Point at it — or at your own manifest, or a hosted URL — by
setting `registryUrl`:

```json
{
  "registryUrl": "examples/registry/manifest.json"
}
```

A configured value always wins over the bundle. Relative paths resolve against
the install root; absolute paths and `https://` URLs are used as given. An
installation without an `examples/` directory simply registers no registry
rather than failing to start.

Two constraints govern what can appear in a manifest, both enforced by tests:

- **`name` must be a usable identifier.** Registry install validates it with
  `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, so a display string like `"My Plugin"` makes
  install throw. Put the human label in `displayName`.
- **`build` is rejected.** `buildPlugin` refuses any manifest declaring a host
  shell build. Ship a prebuilt bundle or use a Station-supported entrypoint.

### Install and use a bundled layout

Registry is the discovery and installation surface; **Plugins** is the
installed-plugin management surface. On a fresh Station installation, open
**Registry → Plugins**, select a bundled starter such as **Minimal Layout**,
and choose **Install**. No local path is needed for a bundled item.

After installation, refresh Registry or open **Plugins** to confirm the item is
installed. Installing makes a layout contribution available; it does not add
that layout to every project. Open the target project, choose **Add**, then
select the installed layout and open it from the project's layout cards.

Removing a plugin from Registry or Plugins removes its installed contribution
and returns the registry item to Available. Existing project layout records are
preserved so a reinstall restores the same project choice; until then, opening
one renders Station's explicit unavailable-component recovery state rather than
silently substituting another layout. Reinstall the same registry item, refresh
the project, and open the preserved layout again.

If installed files remain but `plugin.json` is missing or rejected, Plugins
keeps the folder visible with a **Rejected** badge, the validation reason, and
specific repair guidance. Fix or restore the manifest, then choose **Reload
plugins**. Station does not invent a version or expose normal settings, update,
permission, or removal controls until the manifest validates again.

## layout.json

```json
{
  "name": "My Layout",
  "slug": "my-layout",
  "icon": "🚀",
  "description": "My layout description",
  "availableAgents": ["my-plugin:assistant"],
  "defaultAgent": "my-plugin:assistant",
  "tabs": [
    { "id": "main", "label": "Main", "component": "my-plugin-main" },
    { "id": "settings", "label": "Settings", "component": "my-plugin-settings" }
  ],
  "actions": [
    { "type": "prompt", "label": "Summarize", "data": "my-plugin:summarize" },
    { "type": "external", "label": "Docs", "icon": "📖", "data": "https://example.com" }
  ]
}
```

Tab `component` values must match keys in the `components` export from your entry point.

Agent slugs in `availableAgents` use the format `<plugin-name>:<agent-slug>`.

### Layout component references

Layout tabs accept either the legacy string form or a structured
`LayoutComponentRef`. String values remain supported and are normalized as
native plugin components:

```json
{
  "id": "main",
  "label": "Main",
  "component": "my-plugin-main"
}
```

That is equivalent to:

```json
{
  "id": "main",
  "label": "Main",
  "component": {
    "kind": "plugin-component",
    "name": "my-plugin-main"
  }
}
```

Use structured refs when a layout mixes plugin components, built-in Station
components, and MCP tool UIs:

```json
{
  "name": "Review Workbench",
  "slug": "review-workbench",
  "tabs": [
    {
      "id": "overview",
      "label": "Overview",
      "component": {
        "kind": "plugin-component",
        "name": "review-workbench-overview"
      }
    },
    {
      "id": "default",
      "label": "Runs",
      "component": {
        "kind": "builtin-component",
        "name": "default"
      }
    },
    {
      "id": "control-tools",
      "label": "Control Tools",
      "component": {
        "kind": "mcp-tool-ui",
        "ref": "station-control/list_project_layouts"
      }
    }
  ]
}
```

`LayoutComponentRef` currently has these shapes:

```ts
type LayoutComponentRef =
  | { kind: 'plugin-component'; name: string }
  | { kind: 'builtin-component'; name: string }
  | {
      kind: 'mcp-tool-ui';
      ref: string;
      displayMode?: 'inline' | 'fullscreen' | 'pip';
      fallbackComponent?: string;
      initialArguments?: Record<string, unknown>;
      approvalPolicy?: 'inherit' | 'require' | 'read-only';
    };
```

- `plugin-component` names must match keys in the plugin entry point's
  `components` export.
- `builtin-component` names resolve through Station's explicit built-in layout
  allowlist. The implemented built-in layout in this milestone is `default`;
  unknown built-ins render an unsupported state.
- `mcp-tool-ui` refs use the canonical `<serverId>/<toolName>` format, for
  example `station-control/list_project_layouts`. Each part must be non-empty
  and cannot contain whitespace or `/`.

MCP UI components are discovered through installed MCP integrations and their
tool metadata. Do not add a top-level `mcpApps` manifest field to a plugin; if a
plugin depends on an MCP server or tool, keep using `tools.required` to express
that installation requirement.

Current MCP UI support is a guarded standalone layout target only. Station can
resolve the MCP server/tool/UI-capability state and show clear invalid,
missing-server, missing-tool, missing-resource, unsupported, and resolved
states. Remote/resource URLs are treated as unsupported in this milestone; no
iframe, postMessage bridge, resource proxy, or tool proxy is enabled. If an MCP
layout declares `approvalPolicy`, Station displays it as a requested policy but
does not enforce it until a bridge/tool proxy security model exists. This
milestone also excludes chat tool-result rendering for MCP Apps and a
`station mcp-ui` CLI harness. Telemetry covers server-side MCP UI ref
resolution outcomes (`station.mcp_ui.resolve.total`); client-only render
mount events are not captured in this milestone.

## Entry Point (src/index.tsx)

```tsx
import { useAgents, useAuth, useNavigation, type LayoutComponentProps } from '@kontourai/station-sdk';

function Main({ layout, activeTab, onShowChat, onLaunchPrompt }: LayoutComponentProps) {
  const agents = useAgents();
  const { status, provider, user } = useAuth();
  const { setDockState } = useNavigation();

  return (
    <div style={{ padding: '2rem' }}>
      <h1>{layout?.name}</h1>
      <button onClick={() => { setDockState(true); onShowChat?.(); }}>
        Open Chat
      </button>
    </div>
  );
}

function Settings(props: LayoutComponentProps) {
  return <div>Settings</div>;
}

export const components = {
  'my-plugin-main': Main,
  'my-plugin-settings': Settings,
};

export default Main;
```

- Export a `components` map — keys match layout.json tab `component` fields
- Components receive `LayoutComponentProps`: `{ layout, activeTab, onShowChat, onLaunchPrompt }`
- Use any hook from `@kontourai/station-sdk`
- `@tanstack/react-query` hooks share the host's QueryClient

## SDK Integration

Import everything from `@kontourai/station-sdk`. Key hooks:

### Agents & Chat

```tsx
import {
  useAgents,           // list of all available agents
  useAgent,            // single agent by slug
  useSendToChat,       // send a message to chat as a specific agent
  useSendMessage,      // send a message to the active conversation
  useConversations,    // list conversations
  useConversation,     // single conversation
  useConversationMessages, // messages in a conversation
  useCreateChatSession,    // create a new chat session
  useOpenConversation,     // open a conversation in the chat dock
} from '@kontourai/station-sdk';

// Send a message to a specific agent
const sendToChat = useSendToChat('my-plugin:assistant');
sendToChat('Summarize this document');

// Invoke an agent programmatically (no UI)
const { mutate: invoke } = useInvokeAgent();
invoke({ slug: 'my-plugin:assistant', message: 'Hello' });
```

### Auth & User

```tsx
import { useAuth, useUserLookup } from '@kontourai/station-sdk';

const { status, provider, user } = useAuth();
// status: 'valid' | 'expiring' | 'expired' | 'missing' | 'not-configured'
// user: { alias, name, email, ... }

const { lookup } = useUserLookup();
const profile = await lookup('jdoe');
```

### Navigation

```tsx
import { useNavigation } from '@kontourai/station-sdk';

const { setDockState, setLayout } = useNavigation();
setDockState(true);   // open chat dock
setDockState(false);  // close chat dock
setLayout('my-project', 'my-layout');  // navigate to a project layout
```

A plugin rendered in the isolated frame has no access to the host's React
context, so it asks the host instead:

```js
parent.postMessage({ method: 'navigate', params: { target: '/agents' } }, '*');
```

`navigation.dock` is required, and the target is checked against an allowlist:
`/projects/<project>/layouts/<layout>`, or a path the app's own surface
registry resolves to a view. Absolute URLs, protocol-relative paths,
traversals, queries, and fragments are rejected, so a plugin can never send the
shell off Station.

Two limits are deliberate, and a plugin should not be written around them:

- **Nothing is persisted.** A plugin's project-layout navigation goes through
  plain `navigate`, not `setLayout`, so it does not become the layout `/`
  restores to on the next launch. Only a navigation the *user* performed sets
  that. A plugin cannot repoint where Station opens.
- **It is rate-bounded.** Two navigations, then one every thirty seconds, per
  plugin. That is generous for navigating in response to a user's click and
  deliberately useless for holding the shell on a route. Refusals are dropped
  silently for the frame and reported once per interval in the host console.

A plugin cannot navigate to a project or layout that does not exist in any
meaningful sense — the route renders its own empty state — but note that the
allowlist checks the *shape* of a project-layout path, not whether that project
is real.

### The pane-host contract, from a frame

`navigate` and `toast` above are two members of one published interface —
`WorkspacePaneHostContract` in `@kontourai/station-contracts`
(`docs/design/pane-host-contract.md`). The same interface serves a pane running
in-process and a pane running in the isolated frame, so a pane written against
it does not know which runtime it is in. From a frame, each member is a
message; the host answers on the same channel.

| Message from the frame | Contract member | The host's answer |
| --- | --- | --- |
| `pane-host/notify` `{ text }` | `notify` | none (a toast appears) |
| `pane-host/navigate` `{ target }` | `navigate` | none (the shell moves) |
| `pane-host/confirm` `{ id, title, message }` | `confirm` | `pane-host/confirm-result` `{ id, decision }` |
| `pane-host/facts` | `facts.subscribe` | `pane-host/facts-changed` `{ facts }`, now and on every change |
| `pane-host/present-unavailable` `{ reason }` | `presentUnavailable` | none |

`target` accepts the documented path string above, or a typed target —
`{ kind: 'app-surface', surfaceId }`, `{ kind: 'project-layout', projectSlug,
layoutSlug }`, `{ kind: 'project-workspace', projectSlug, taskSlug? }`. A typed
target names a destination rather than a path: the host looks the route up in
its own surface registry, so there is nowhere in the message to put one.

Three things are worth knowing before writing against it:

- **`confirm` shows Station's dialog, not yours.** The frame never receives a
  component — it receives the user's decision. `decision` is `'confirmed'` or
  `'cancelled'`, and it always arrives: a request that is superseded, refused,
  or outlived by the frame's teardown answers `'cancelled'` rather than
  leaving you waiting.
- **Everything is rate-bounded, including confirmations.** Two confirmations,
  then one every thirty seconds — the same shape as navigation, for the same
  reason: a full-screen dialog you must answer is the most expensive attention
  a pane can spend, and a pane cannot buy more of it by running in a frame.
- **An unrecognised or malformed `pane-host/*` message is refused, not
  ignored.** The host replies `pane-host/refused` `{ method, reason, id? }`.
  Silence is how two earlier plugin capabilities stayed broken for months.

### Config

```tsx
import { useConfig } from '@kontourai/station-sdk';

const config = useConfig();
// config.region, config.defaultModel, config.invokeModel, ...
```

### Notifications

```tsx
import { useToast, useNotifications } from '@kontourai/station-sdk';

const { showToast } = useToast();
showToast({ type: 'success', message: 'Done!' });
showToast({ type: 'error', message: 'Something went wrong' });
showToast({ type: 'info', message: 'FYI' });
```

### Workflows & Slash Commands

```tsx
import { useWorkflows, useSlashCommands, useSlashCommandHandler } from '@kontourai/station-sdk';

const workflows = useWorkflows();
const commands = useSlashCommands();
```

### Query Hooks

For data fetching, prefer the pre-built query hooks over raw `useQuery`:

```tsx
import {
  useAgentsQuery,
  useConfigQuery,
  useProjectsQuery,
  useProjectLayoutsQuery,
  useConversationsQuery,
  useModelsQuery,
  useStatsQuery,
  useInvokeAgent,
  useApiQuery,    // generic GET
  useApiMutation, // generic POST/PUT/DELETE
} from '@kontourai/station-sdk';
```

Server-side extensions and non-React clients should use the React-free
`@kontourai/station-sdk/client` scheduler functions rather than rebuilding
`/scheduler` requests. The client exports all twelve operator operations and
the contracts package exports `SCHEDULER_OPERATOR_SURFACE`, `AddJobOpts`,
`UpdateJobOpts`, and `SchedulerSchedule`. This is a client surface, not a
server-side scheduler-provider registration seam.

### MCP Tool Access from Plugin UI

Call MCP tools directly from plugin UI using `callTool` from `@kontourai/station-sdk`:

```tsx
import { callTool } from '@kontourai/station-sdk';

// callTool(agentSlug, toolName, args)
const result = await callTool('my-plugin:assistant', 'search_files', { query: 'hello' });
// result: { success: boolean, response: unknown, error?: string }
```

This calls `POST /agents/:slug/tools/:toolName` on the server (or dev server). The dev server proxies this to the connected MCP process.

### Server-Side Fetch Proxy

For external HTTP calls from plugin UI (requires `network.fetch` permission):

```tsx
import { useServerFetch } from '@kontourai/station-sdk';

const { fetch: serverFetch } = useServerFetch();
const result = await serverFetch({
  url: 'https://api.example.com/data',
  method: 'GET',
  headers: { Authorization: 'Bearer ...' },
});
// result: { success, status, contentType, body }
```

### Layout Providers

Register and access layout-scoped providers from plugin UI:

```tsx
import { registerProvider, configureProvider, getProvider, hasProvider } from '@kontourai/station-sdk';

// Register a client-side provider
registerProvider('my-plugin/crm', { layout: 'my-layout', type: 'crm' }, () => myCRMProvider);

// Set it as the active provider for this layout
configureProvider('my-layout', 'crm', 'my-plugin/crm');

// Access a provider
const svc = getProvider<IMyCRMProvider>('my-layout', 'crm');
```

## Provider Interfaces

Providers are server-side modules loaded from `providers/` in your plugin. Each type has a specific interface.

### auth

```js
// providers/auth.js
module.exports = () => ({
  async getStatus() {
    // Returns: { provider, status, expiresAt, message }
    return { provider: 'my-auth', status: 'valid', expiresAt: null, message: 'OK' };
  },
  async renew() {
    // Returns: { success, message }
    return { success: true, message: 'Renewed' };
  },
});
```

### branding

```js
// providers/branding.js
module.exports = () => ({
  async getAppName() { return 'My App'; },
  async getLogo() { return { src: '/logo.png', alt: 'My App' }; },
  async getTheme() { return null; }, // or CSS custom property overrides
  async getWelcomeMessage() { return 'Welcome to My App'; },
});
```

### userIdentity

```js
module.exports = () => ({
  async getCurrentUser() {
    // Returns: { alias, name, title, email, profileUrl }
    return { alias: 'jdoe', name: 'Jane Doe' };
  },
});
```

### userDirectory

```js
module.exports = () => ({
  async lookup(alias) {
    // Returns: UserDetailVM or null
    return { alias, name: 'Jane Doe', email: `${alias}@example.com` };
  },
});
```

### agentRegistry

```js
module.exports = () => ({
  async listAvailable() {
    // Returns: Array<{ id, displayName, description, version, status, installed }>
    return [{ id: 'my-agent', displayName: 'My Agent', installed: false }];
  },
  async listInstalled() { return []; },
  async install(id) { return { success: true, message: 'Installed' }; },
  async uninstall(id) { return { success: true, message: 'Removed' }; },
});
```

Alternatively, point `module` at a JSON file and the server auto-wraps it with `JsonManifestRegistryProvider`.

### integrationRegistry

Same interface as `agentRegistry` but for MCP integrations.

### settings

```js
module.exports = () => ({
  async getDefaults() {
    // Returns: Partial<AppConfig> — default config values contributed by this plugin
    return { region: 'us-east-1' };
  },
});
```

## Plugin Permissions

Plugins declare permissions in `plugin.json`. The server enforces them at install time and runtime.

### Permission Tiers

| Tier | Behavior | Permissions |
|------|----------|-------------|
| `passive` | Auto-granted on install, no prompt | `navigation.dock` |
| `active` | Requires user consent | `network.fetch`, `agents.invoke`, `tools.invoke`, `ui.confirm` |
| `trusted` | Requires approval on a separate Station host page | `providers.register`, `system.config`, `plugin.server`, `events.subscribe`, `events.read-payload` |

### Declaring Permissions

```json
{
  "permissions": [
    "navigation.dock",
    "network.fetch",
    "agents.invoke"
  ]
}
```

### Runtime Enforcement

- `network.fetch` — required to use `useServerFetch` / `POST /api/plugins/:name/fetch`
- `ui.confirm` — required to raise the shell's confirm dialog (`host.confirm`). Without it the request is refused with `permission-required` and resolves `'cancelled'`; no dialog is shown. It is `active` rather than `passive` because the dialog is a focus-trapping, full-viewport overlay rendered in Station's own chrome with body text you supply — interrupting the user is something the user agrees to.
- `providers.register` — required to register server-side providers
- `system.config` — required to modify app config
- `events.subscribe` — required for unattended durable operational-event observation
- `events.read-payload` — additionally required when a subscription requests the full event envelope; metadata subscriptions never receive payload data

Grants are stored in `<STATION_HOME>/plugin-grants.json` and revoked on plugin removal.

Trusted permissions are not granted from plugin-rendered UI. Station opens a
short-lived, host-owned review page that lists the exact requested capabilities.
Approving enables the plugin's trusted server behavior; denying leaves its server
module unloaded. You can revisit an installed plugin from **Plugins**, select it,
and choose **Review Permissions**.

### Managing Grants via API

```bash
# View declared vs granted permissions
GET /api/plugins/:name/permissions

# Grant active permissions
POST /api/plugins/:name/grant
{ "permissions": ["network.fetch"] }
```

The public grant endpoint rejects trusted permissions. Trusted grants must go
through the host approval UI so plugin code cannot silently elevate itself.

## Plugin Dependencies

Plugins can declare dependencies on other plugins. The server resolves and installs them automatically.

```json
{
  "dependencies": [
    { "id": "auth-plugin", "source": "git@github.com:org/auth-plugin.git" },
    { "id": "registry-plugin" }
  ]
}
```

- If `source` is provided and the dependency isn't installed, it's cloned and installed automatically
- Relative dependency sources resolve from the declaring local plugin directory
  but must remain inside its physical sibling package root; traversal and
  symlinked ancestors are refused
- If no `source`, the server tries the configured registry
- Dependencies are resolved recursively (cycle detection included)
- `station plugin preview <source>` shows dependency resolution status, exact content digest, and dependency-specific permissions before install
- Every supplied dependency approval binds its staged source bytes, permissions, and dependency ids, even for declarative-only packages. Newly installed dependencies with browser entrypoints, prebuilt browser bundles, permissions, providers, or settings require that preview-bound approval; naming the dependency id alone is insufficient. Declarative-only dependencies remain supported without an individual approval for older clients. Unsupported lifecycle contributions remain refused.
- Already-installed dependencies are adopted without granting deletion ownership or replacing their active provider/settings lifecycle. If an installed entrypoint is rebuilt, its current installed bytes must match the preview approval, checked under the content lock held through that rebuild. Read-only adoption does not claim to install the previewed source over an existing tree.
- Provider/settings-only dependencies use the canonical plugin lifecycle. Station records which dependency trees the parent created in host-owned, digest-bound install authority beside the existing per-plugin grant state; neither the mutable parent manifest nor files in the plugin tree can mint deletion authority. Station rolls dependency grants/providers/bytes back in reverse dependency order with a failed parent install, and removes owned dependencies plus their registry aliases with the parent unless another installed plugin references them directly or transitively, or their lock-protected content changed. A dependency whose exact creation digest is unavailable is preserved rather than deleted by name. A dependency that already existed is never adopted for deletion, and a failed parent uninstall restores every dependency it already removed.
- Removing a creator, or replacing it with a smaller graph, hands an unchanged
  managed dependency's existing cleanup claim to a verified surviving root
  consumer. This is custody transfer, not new grant or execution authority.
  The recipient copy is durable before the creator's claim disappears; an
  interrupted handoff may leave duplicate claims, but the last consumer still
  performs one dependency cleanup. Metadata-only rollback compares the written
  ownership revision and preserves newer grants. Unmanaged adopted plugins stay
  unmanaged. An unverifiable successor, exhausted capacity, legacy unbound
  recipient grants, or unsupported nested custody causes safe refusal instead
  of orphaning authority or promoting permissions. Recipient verification and
  the handoff use the canonical publication/content locks.
- Trusted dependency permissions such as `providers.register` remain pending for the separate host-owned approval surface; dependency installation does not downgrade that authority.
  Other dependency permissions (for example `network.fetch`) currently lack
  canonical dependency lifecycle support and are rejected by preview before
  offering approval; approving them does not expand the supported permission set.
  The Plugins and Registry install flows route each installed dependency through
  that existing host approval before claiming its providers are active.

## Installation Flow

### CLI

```bash
# Install from git URL
station plugin install git@github.com:org/my-plugin.git

# Install from git URL at a specific branch
station plugin install git@github.com:org/my-plugin.git#my-branch

# Install from local path
station plugin install /path/to/my-plugin

# Preview before installing (validate + show components/conflicts)
station plugin preview git@github.com:org/my-plugin.git

# Skip specific components during install
station plugin install git@github.com:org/my-plugin.git --skip=agent:my-plugin:assistant,layout:my-layout
```

### API

An install carries the approval a preview produced (station#4288). `POST
/api/plugins/install` with no `consent` is refused with a 400 before the source
is staged, so preview first — it is the only thing that reports the
`contentDigest` the install has to name.

```bash
API_BASE="${STATION_API_BASE:-http://127.0.0.1:18141}"
: "${STATION_API_CREDENTIAL:?set a paired Station bearer for direct API use}"

# 1. Preview: stages a copy, reports what installing it would require, and
#    throws the copy away. Writes nothing.
curl -X POST "$API_BASE/api/plugins/preview" \
  -H "Authorization: Bearer $STATION_API_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  -d '{"source": "git@github.com:org/my-plugin.git"}'
# → { "valid": true, "manifest": …, "dependencies": [...],
#     "contentDigest": "sha256:…",
#     "permissions": { "required": [...], "autoGranted": [...],
#                      "pendingConsent": [{ "permission": …, "tier": … }] } }

# 2. Install: the answer to what the preview reported, about those bytes.
curl -X POST "$API_BASE/api/plugins/install" \
  -H "Authorization: Bearer $STATION_API_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  -d '{
        "source": "git@github.com:org/my-plugin.git",
        "consent": {
          "permissions": ["navigation.dock", "network.fetch"],
          "contentDigest": "sha256:…",
          "dependencies": ["shared-lib"],
          "dependencyApprovals": [{
            "id": "shared-lib",
            "permissions": ["providers.register"],
            "contentDigest": "sha256:…",
            "dependencies": []
          }]
        }
      }'

# Install with skip list — same consent, plus the components to leave out
curl -X POST "$API_BASE/api/plugins/install" \
  -H "Authorization: Bearer $STATION_API_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  -d '{
        "source": "/path/to/plugin",
        "skip": ["provider:auth"],
        "consent": {
          "permissions": [],
          "contentDigest": "sha256:…",
          "dependencies": []
        }
      }'

# List installed
GET /api/plugins

# Update (git pull + rebuild)
POST /api/plugins/:name/update

# Remove
DELETE /api/plugins/:name

# Check for updates across all plugins
GET /api/plugins/check-updates
```

### What Happens on Install

1. Source is cloned (git) or copied (local path) to a temp directory
2. `plugin.json` is validated
3. Dependencies are resolved and installed recursively
4. Plugin is moved to `<STATION_HOME>/plugins/<name>/`
5. Agents are copied to `<STATION_HOME>/agents/<plugin>:<slug>/`
6. Plugin layout source stays with the installed plugin and can be applied into project layouts
7. Plugin is built (`buildPlugin()` / esbuild)
8. Bundled tool configs are copied to `<STATION_HOME>/integrations/`
9. Providers are loaded into the server
10. Passive permissions are auto-granted; active/trusted permissions are returned as `pendingConsent`

Install, update, reload, and removal publish one runtime configuration generation. Replacement removes agent directories no longer declared by the plugin, and update rejects a changed manifest name. Station waits for displaced provider adapters to stop before reporting activation complete; an accepted file mutation that still needs runtime reconciliation returns HTTP `202` with a `configurationActivation` receipt.

### Registry supply-chain policy tracer

Station now has a server-side policy and record seam for registry package
signatures, exact source/version/content pins, and byte-identical
last-known-good snapshots. It is deliberately not active in the Registry UI or
installer yet: no configured registry currently supplies a package claim, and
Station has no configured trusted signing-key source or explicit pin-update
action. Enforcing a required-signature policy without those trust anchors would
make every current Registry item uninstallable while claiming stronger safety.

The seam binds the canonical Agent Plugins 1.0.0 manifest schema target,
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, not legacy
Station-only manifest contribution fields. That target identifies the published
schema the registry claim says its root `plugin.json` uses; this tracer does not
yet validate the manifest against that schema. Trust anchors
come from local policy and never from the registry document being verified.
The signature binds registry identity, registry source, package identity,
version, source, and complete source-tree digest. A source/version change is
refused under exact pinning unless a separately authorized pin update is
present; an accepted provenance change explicitly requires the existing
installer to invalidate/rebind grants before loading replacement code.

`RegistryLastKnownGoodStore` writes no live plugin tree. It archives one prior
tree under the Station home, verifies the copy's complete tree digest, and can
produce a second verified staging tree. Runtime rollback must feed that staging
tree back through `installPluginFromSource` so the existing content lock,
agents, integrations, grants, providers, configuration generation, and rollback
receipts remain the only installation transaction. Until that integration is
landed, signed installation, explicit pin updates, and user-triggered rollback
are **NOT_AVAILABLE**.

## Build System

Layout plugins (with `entrypoint`) are built automatically by the server using esbuild. No custom build script needed.

### package.json

This is what `station plugin create` scaffolds:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsx build.ts",
    "dev": "tsx build.ts --dev"
  },
  "peerDependencies": {
    "@kontourai/station-sdk": "^0.7.0",
    "@kontourai/station-shared": "^0.7.0",
    "react": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "tsx": "^4.23.1"
  }
}
```

The scripts do not require the Station CLI. They run the scaffolded `build.ts`
instead, which calls the same `buildPlugin()` the Station CLI and the server
both call:

```ts
import { buildPlugin } from '@kontourai/station-shared/build';

const mode = process.argv.includes('--dev') ? 'dev' : 'production';
const result = await buildPlugin(process.cwd(), mode);

if (!result.built) {
  console.log('No entrypoint in plugin.json — nothing to bundle.');
} else {
  console.log(`Built ${result.bundlePath}`);
  if (result.cssPath) console.log(`Built ${result.cssPath}`);
}
```

`tsx` is the TS-aware loader: `@kontourai/station-shared` ships TypeScript
source, and Node will not strip types for files under `node_modules`.

The two Station dependency ranges come from
`config/plugin-scaffold-dependencies.json`, the single scaffold authority used
by `plugin create`. `npm run plugin-scaffold:public-deps` resolves those exact
ranges against the public npm registry, and package publishing runs that check
before building or publishing. A local workspace version is never substituted
unless that range already resolves for an external author on public npm.

`@kontourai/station-sdk` and `@kontourai/station-shared` are peer dependencies —
the Station host provides them at runtime, and `buildPlugin` externalizes them
rather than bundling them.

### Shared Modules (Externals)

These are provided by the host at runtime via `window.__station_ai_shared` and must NOT be bundled:

| Module | Notes |
|--------|-------|
| `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` | React runtime |
| `@kontourai/station-sdk` | All SDK hooks and utilities |
| `@kontourai/station-components` | Shared UI components |
| `@tanstack/react-query` | Shares host's QueryClient |
| `dompurify` | HTML sanitization — host-loaded on demand (see below) |
| `debug` | Debug logging |
| `zod` | Schema validation — host-loaded on demand (see below) |

Only `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `@tanstack/react-query`
and `debug` are published synchronously at boot — the host genuinely ships those
in its first-paint bundle. Everything else in the table, including
`@kontourai/station-sdk` and `@kontourai/station-components`, is fetched on
demand the first time a plugin bundle is about to run.

**The plugin contract is unchanged.** `PluginRegistry` awaits that load before
it injects any bundle, so `require('@kontourai/station-sdk')`, `require('zod')`
and the rest resolve exactly as before by the time your code executes.

What changed (station#883) is page-level access: reading
`window.__station_ai_shared['@kontourai/station-sdk']` from a page script
before any plugin has loaded is no longer guaranteed, because on a Station with
no plugins installed nothing triggers the load. Await the readiness handle
first:

```js
await window.__station_ai_shared_ready();
const sdk = window.__station_ai_shared['@kontourai/station-sdk'];
```

The SDK barrel moved because it was published with a namespace import, which
materializes every export whether or not the host app uses it — pinning 43
app-unreached SDK modules into the entry chunk. Deferring it took ~22.8KB gzip
out of first paint.

The centralized build handles externalization automatically. If you use a custom `build.mjs`, externalize these modules and add the runtime shim (see `packages/shared/src/index.ts` for `RUNTIME_SHIM` and `SHARED_EXTERNALS`).

### Output

Build produces `dist/bundle.js` (and optionally `dist/bundle.css`). Do not commit `dist/` to git — the server rebuilds on install/update.

## Development Workflow

This workflow uses the published `@kontourai/station-cli`. Install the stable
client with `npm install -g @kontourai/station-cli@latest`, or use the
repo-root `./station` launcher while developing Station itself. The manual
build path is in the published
[`@kontourai/station-sdk` README](https://www.npmjs.com/package/@kontourai/station-sdk)
and in [Build Your First Plugin](./build-your-first-plugin.md).
This reference describes current `main`; a released CLI may scaffold the
package ranges current when that CLI version shipped, so inspect the generated
`package.json` before choosing a newer published SDK line.

### 1. Scaffold

```bash
station plugin create my-plugin --template=full
cd my-plugin
```

This creates the full plugin structure with a working entry point, layout
config, and agent. `plugin create`/`build`/`dev`/`install` resolve paths against
the directory where you invoke `station`, so `my-plugin/` is scaffolded in —
and the rest of this workflow operates on — your actual working directory.

Available templates:

- `full` — layout + agent + build config
- `layout` — UI-focused starter
- `provider` — server-side starter with `serverModule` and provider examples

### 2. Dev Server

```bash
station plugin dev              # starts on port 4200
station plugin dev 3000         # custom port
station plugin dev --no-mcp     # disable MCP tool connections
station plugin dev --tools-dir=./tools  # custom tools directory
```

The dev server:
- Builds the plugin in dev mode (inline sourcemaps)
- Serves the plugin UI at `http://127.0.0.1:4200` and binds only IPv4 loopback
- Watches `src/` for changes and hot-rebuilds
- Connects to MCP servers defined in agent configs
- Provides a mock SDK (`window.__station_ai_shared`) that simulates the host environment
- Provides a restricted local development API surface:
  - `GET /agents/:slug/tools` — list available tools
  - `POST /agents/:slug/tools/:toolName` — call a tool
  - `POST /api/plugins/fetch` — server-side fetch proxy

Dependencies declared in `plugin.json` are auto-installed from
`<STATION_HOME>/plugins/` on dev server start.

Direct `--host` or non-loopback HTTP exposure is not supported. For remote development, run `station plugin dev 4300` on the development host, forward it with `ssh -N -L 4300:127.0.0.1:4300 user@dev-host`, and open `http://127.0.0.1:4300` locally. The privileged file, MCP, fetch, and reload routes enforce the same exact loopback browser boundary.

The development fetch proxy accepts public HTTP(S) destinations only. It validates every DNS answer and redirect, strips credential and hop-by-hop headers, forces identity encoding and rejects encoded upstream responses, and rejects private, loopback, link-local, and cloud-metadata addresses. Limits are 1 MiB per JSON request, 10 MiB per identity fetch response, 10 seconds per DNS-through-response hop, five redirects, and 32 simultaneous reload streams.

### 3. Build

```bash
npm run build   # tsx build.ts        — dist/bundle.js, production, no sourcemaps
npm run dev     # tsx build.ts --dev  — dist/bundle-dev.js, inline sourcemaps
```

Both run `buildPlugin()` from `@kontourai/station-shared`. These are one-shot
builds — they do not watch or serve; use `station plugin dev` above for the
watching preview server.

`station plugin build` is the equivalent wrapper
around the same call.

### 4. Install Locally for Testing

```bash
station plugin install ./my-plugin   # run from the parent directory
station plugin install .             # or run from inside the plugin directory
```

Installs the given directory as a plugin into the running Station instance. Local paths are resolved from the directory where Station was invoked, so both an explicit relative path and bare `.` are supported.

### 5. Plugin Management

```bash
station plugin list             # list installed plugins
station plugin info my-plugin   # show plugin details
station plugin update my-plugin # git pull + rebuild
station plugin remove my-plugin # uninstall
station plugin preview <source> # validate before installing
station registry [url]          # browse or set registry URL
station registry install <id>
```

## Request-Scoped Server Modules

Plugins that need server routes can declare `serverModule` in `plugin.json`. Station loads that module per plugin and mounts it under `/api/plugins/<plugin-name>`.

The module can export:

- `register(app, context)` — register Hono routes for the plugin
- `hooks.onRequest(context)` — request-start lifecycle hook
- `hooks.onResponse(context)` — response lifecycle hook
- `hooks.onError(context)` — error lifecycle hook
- `operationalEvents.observe(input)` — handle one manifest-declared operational event with a stable idempotency key, attempt, host-selected projection, and abort signal

Each request gets a correlation ID. Station exposes it to request hooks and returns it as the `x-station-correlation-id` response header. The `register()` context itself contains `pluginName`, `projectHomeDir`, `logger`, and config helpers.

```js
export const hooks = {
  onRequest({ correlationId, path }) {
    console.log('plugin request', correlationId, path);
  },
};

export function register(app, context) {
  app.get('/ping', (c) =>
    c.json({
      ok: true,
      plugin: context.pluginName,
      correlationId: c.req.header('x-station-correlation-id') || null,
    }),
  );
}
```

### Durable operational event subscriptions

`operationalEventSubscriptions` is inert manifest data. A declaration names
only its stable id/version, event types, exact required scopes, and requested
`metadata` or `envelope` projection. It never supplies a consumer id, delivery
cursor, grant, or retry policy. Station derives those from the installed plugin
identity and the current host-owned grants.

Every subscription requires `plugin.server` and `events.subscribe`. An
`envelope` projection additionally requires `events.read-payload`; otherwise
the subscription is not opened. Grants and the exact installed manifest are
rechecked before every delivery and again immediately before the observer is
invoked, so revocation or replacement stops new plugin effects without a
Station restart.

```js
export function register() {}

export const operationalEvents = {
  async observe({
    subscriptionId,
    projection,
    idempotencyKey,
    attempt,
    signal,
  }) {
    // At-least-once: deduplicate external effects by idempotencyKey.
    // Respect signal so Station can bound shutdown and delivery timeouts.
    await recordProjection(projection, { idempotencyKey, attempt, signal });
    return { kind: 'accepted' };
  },
};
```

Observers return `{kind:'accepted'}`, `{kind:'retry', failureCode}`, or
`{kind:'rejected', failureCode}`. Failure codes are bounded lowercase
identifiers. A thrown observer becomes a durable retry; timeout or explicit
rejection becomes a dead letter. If observer code ignores its abort signal, its
Promise remains a live fence: Station will not invoke it again, replace its
server module, or report subscription shutdown complete until that Promise
settles. Retention gaps remain host-visible and are never silently acknowledged
by plugin code.

## Agent Config (agent.json)

```json
{
  "name": "Assistant",
  "prompt": "You are a helpful assistant.",
  "description": "General purpose assistant",
  "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "region": "us-east-1",
  "guardrails": {
    "maxTokens": 4096,
    "temperature": 0.7,
    "topP": 0.9,
    "maxSteps": 10
  },
  "tools": {
    "mcpServers": ["my-mcp-tool"],
    "available": ["search_files", "read_file"],
    "autoApprove": ["read_file"],
    "aliases": { "search": "search_files" }
  },
  "commands": {
    "summarize": {
      "name": "Summarize",
      "description": "Summarize the current context",
      "prompt": "Please summarize: {{input}}",
      "params": [{ "name": "input", "required": true }]
    }
  },
  "ui": {
    "component": "my-plugin-chat",
    "quickPrompts": [
      { "id": "help", "label": "Help", "prompt": "What can you help me with?" }
    ]
  }
}
```

Agent slugs are namespaced as `<plugin-name>:<agent-slug>` when installed.

## Links

Plugins can inject external links into the host UI:

```json
{
  "links": [
    {
      "label": "Activity Dashboard",
      "href": "https://example.com/dashboard",
      "icon": "/icon.png",
      "placement": "achievements"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `label` | yes | Display text |
| `href` | yes | URL (opens in new tab) |
| `icon` | no | Icon image path |
| `placement` | no | `"achievements"` (profile page) or omit for global |

## Examples

| Example | What it shows |
|---------|---------------|
| `examples/demo-layout/` | Full layout with agents, tabs, SDK hooks |
| `examples/minimal-layout/` | Minimal entry point, no agents |
| `examples/custom-branding/` | Branding provider only |
| `examples/elevenlabs-voice/` | STT/TTS voice provider |
| `examples/nova-sonic-voice/` | Nova Sonic voice provider |
| `examples/meeting-transcription/` | Context provider for meeting transcription |
| `examples/builder-delivery-viewer/` | Read-only Builder Kit lifecycle artifacts, Surface report, and exact Flow-run join |

The Builder Delivery Viewer composes only published contracts: Flow Agents'
root validator and shipped JSON Schemas, Surface's `buildTrustReport` and
`@kontourai/surface/trust-panel/element`, and Station SDK Flow-run queries.
It is intentionally a bounded read model; Builder Kit and Flow remain the only
lifecycle writers. Host-mediated enforcement of
server-module filesystem authority is tracked in
[Station #501](https://github.com/kontourai/station/issues/501).

### Minimal Layout (examples/minimal-layout)

```tsx
import { useAgents, useNavigation, useToast, type LayoutComponentProps } from '@kontourai/station-sdk';

export default function Main({ layout, onShowChat }: LayoutComponentProps) {
  const agents = useAgents();
  const { setDockState } = useNavigation();
  const { showToast } = useToast();

  return (
    <div style={{ padding: '2rem' }}>
      <h1>{layout?.name}</h1>
      <button onClick={() => { setDockState(true); showToast({ type: 'info', message: 'Chat opened' }); }}>
        Open Chat
      </button>
    </div>
  );
}

export const components = { 'minimal-layout-main': Main };
```

### Custom Branding (examples/custom-branding)

```js
// providers/branding.js
module.exports = () => ({
  async getAppName() { return 'Project Station'; },
  async getLogo() { return { src: '/favicon.png', alt: 'Station' }; },
  async getTheme() { return null; },
  async getWelcomeMessage() { return 'Welcome to Project Station'; },
});
```

```json
{
  "name": "custom-branding",
  "version": "1.0.0",
  "providers": [{ "type": "branding", "module": "./providers/branding.js" }]
}
```
