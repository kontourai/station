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

A new plugin (what `station plugin create` and **Plugins → New plugin**
scaffold, from `packages/shared/src/plugin-scaffold.ts`):

```
my-plugin/
├── plugin.json              # Agent Plugins 1.0 manifest (required)
├── package.json             # Node package
├── build.ts                 # Calls @kontourai/station-shared/build
├── src/
│   ├── index.tsx            # UI entry point — exports a `components` map
│   └── pane.css             # Imported by index.tsx; bundled to dist/bundle.css
├── agents/                  # Agent configs (optional)
│   └── assistant/
│       └── agent.json
├── tools/                   # Bundled MCP tool configs (optional)
│   └── my-tool/
│       └── tool.json
└── providers/               # Server-side provider modules (optional)
    └── my-auth.js
```

A legacy layout plugin also carries a `layout.json` (see
[layout.json](#layoutjson)); new plugins declare Workspace Panes instead.

## plugin.json — Manifest

New plugins use an [Agent Plugins 1.0](https://agent-plugins.org) manifest.
The portable fields sit at the root; everything Station reads sits under
`extensions["io.kontourai.station"]`, and the UI is declared as
`workspacePanes`. This is the shape the scaffolds emit:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does",
  "extensions": {
    "io.kontourai.station": {
      "schemaVersion": "1.0",
      "title": "My Plugin",
      "sdkVersion": "^0.7.0",
      "entrypoint": "./src/index.tsx",
      "capabilities": ["chat", "navigation"],
      "permissions": ["navigation.dock"],
      "workspacePanes": [
        {
          "version": "1.0",
          "id": "pane:plugin%3Amy-plugin:main:workspace",
          "name": "My Plugin",
          "rendererId": "renderer:plugin%3Amy-plugin:plugin-component:workspace",
          "renderer": { "kind": "plugin-component", "name": "my-plugin-workspace" },
          "placement": { "supportedRegions": ["primary"], "preferredRegion": "primary" },
          "modes": [{ "id": "default", "contextRequirement": { "project": true } }],
          "provenance": { "origin": "plugin", "pluginId": "my-plugin" },
          "lifecycle": { "stage": "stable" }
        }
      ]
    }
  }
}
```

An Agent Plugins manifest refuses the legacy `layout` and `layouts` fields.

### Legacy root manifest

Station still loads a manifest without `$schema`, with its fields at the root.
Common fields:

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
| `name` | string | yes | Unique logical plugin identifier; the host owns its storage location |
| `version` | string | yes | Semver version |
| `sdkVersion` | string | no | Semver range of `@kontourai/station-sdk` required |
| `displayName` | string | no | Human-readable name shown in UI |
| `description` | string | no | Short description |
| `entrypoint` | string | no | Path to UI entry point (layout plugins only) |
| `serverModule` | string | no | Path to a server-side module that registers request-scoped plugin routes and lifecycle hooks |
| `build` | string | no | Reserved; currently rejected so builds cannot execute manifest-supplied commands |
| `capabilities` | string[] | no | Declared capabilities, e.g. `["chat", "navigation"]` |
| `commands` | PluginCommandContribution[] | no | Palette-command declarations (at most 32). Each `id` must be `<name>.<command>` and unique; `navigate` names a destination id and uses the built-in palette's page behavior. Validated for both manifest formats; declarations that fail are dropped (the plugin still loads) and the inventory shows `commandsRejected.reason`. Declaration grants no execution authority, and every effect is admitted by Station (see [Plugin Command Effects](../reference/api.md#plugin-command-effects)) |
| `commandsRejected` | `{ reason: string }` | no | Set by Station, not by authors: the loader discards any value in `plugin.json` and sets it only when `commands` failed validation and was dropped |
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

`name` is the logical installation identity and the URL segment your server
module answers, `/api/plugins/<name>/…`. A legacy install normally uses it as
the directory name; a managed portable install selects a retained materialization
whose physical directory can differ. Installed names use the
[Agent Plugins grammar](../reference/agent-plugins.md#identity): 1–64 lowercase
ASCII letters, digits, hyphens, or periods, with alphanumeric endpoints and no
`--` or `..`. Both manifest parsers also reject `constructor` and `prototype`.
Station mounts some of its own routes
at literal first segments on that same prefix, and those registrations win — so
a plugin installed under one of those names would find Station's routes inside
the namespace it believes it owns. Install refuses these names outright:

```
check-updates   command-effects   fetch   home-role   host-approvals
install         preview           reload            validate    visibility
```

The [reserved-identity list](../../src-server/services/plugins/reserved-plugin-identities.ts)
is checked against actual route registrations by its tests, so it must change
when Station adds a colliding route. Only exact matches are reserved —
`installer` and `home-role-viewer` are fine. The event sentinel
`workspace-home-role` is also unavailable as a plugin name.

### Provider Entry Fields

```json
{ "type": "auth", "module": "./providers/auth.js", "layout": "my-layout" }
```

| Field | Description |
|-------|-------------|
| `type` | Registry key for the provider's consumer contract; see the consumer boundaries below. Custom keys can be registered but require a consumer. |
| `module` | Path to the JS module (relative to plugin root) |
| `layout` | Optional — scope this provider to a specific layout slug |

The [provider interfaces](../../src-server/providers/provider-interfaces.ts)
define host contracts such as `auth`, `branding`, `userIdentity`, `userDirectory`,
`agentRegistry`, `integrationRegistry`, `skillRegistry`, `pluginRegistry`,
`settings`, `scheduler`, `notification`, `acpConnectionRegistry`, `workItem`,
`pullRequest`, and `providerAdapter`. The `acpConnections` key is consumed by
runtime connection discovery; consult its caller's shape before contributing it.
The examples below cover selected contracts; registration alone does not make
an arbitrary object usable by one of these callers.

Generic registry metadata also names `llmProvider`, `embeddingProvider`, and
`vectorDbProvider`, but registering those keys does not connect a plugin to
Station's model or knowledge pipeline. Those consumers resolve configured
capability connections through
[`ProviderService`](../../src-server/services/connections/provider-service.ts)
and [runtime provider resolution](../../src-server/runtime/plugins/runtime-provider-resolution.ts).
`llm`, `embedding`, and `vectorDb` are not equivalent registration keys.
`layoutType` also appears in generic registry metadata. This guide does not
establish a consumer contract for it or for arbitrary `promptRegistry` or
`template` registrations.

### Dependency Entry Fields

```json
{ "id": "base-plugin", "source": "git@github.com:org/base-plugin.git" }
```

| Field | Description |
|-------|-------------|
| `id` | Plugin name (must match the dependency's `plugin.json` `name`) |
| `source` | Git URL or local path to install from if not already installed |

### Settings

Plugins can declare configurable settings that users edit in the Plugins UI.
Values are persisted as plaintext JSON in
`<STATION_HOME>/config/plugin-overrides.json` and passed to provider factory
functions at load time. `secret: true` masks the UI input and suppresses the
value in settings GET responses and settings-change events; it does not encrypt
the file or prevent the provider from reading the value. Agent Plugins
`secretReferences` currently uses this same path; see the
[secret boundary](../reference/agent-plugins.md#secret-boundary).

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

Saving establishes persistence, not provider activation. The
[settings route](../../src-server/routes/plugins/plugin-config-routes.ts)
saves and emits a settings-change event; the
[SDK mutation](../../packages/sdk/src/query-domains/plugin-mutations.ts)
invalidates the settings query. Neither reconstructs providers. The runtime's
file watcher reconciles Agent and integration files, not this settings file.
Factories receive the new values the next time the plugin provider loading
path constructs them; a successful settings save alone is not evidence that a
running provider has changed.

For local agent-assisted visual Skill conversion, review and evaluation, use
[Author a visual skill experience](authoring-skill-experiences.md).

## Plugin registry

The Registry page browses installable plugins from a JSON manifest.

When `registryUrl` is unset,
Station serves a bundled manifest at `examples/registry/default.json`, so a
checkout or distribution carrying that catalog can browse its local examples
without a separate registry account. These are templates, not preconfigured
external services. Building a source plugin may still prepare npm dependencies
and need registry access; a local catalog does not promise a network-free build.

| Plugin | What it shows |
|---|---|
| `getting-started-starter` | Agents, chat dock control, navigation, toast feedback |
| `coding-starter` | Two Workspace Panes with labelled code examples and an owner-qualified review action |
| `knowledge-docs-starter` | Static document/source UI and chat entry; no real intake or search |
| `minimal-layout` | The smallest useful layout surface |
| `demo-layout` | A tour of Station capabilities, no external services |
| `smart-routing` | A provider plugin with no UI entrypoint |
| `matt-pocock-engineering` | Attributed pinned Skills and five visual entry definitions; agent, project/tracker setup and authority remain prerequisites |

The fuller catalog at `examples/registry/manifest.json` adds examples that pull
npm dependencies (`enterprise-layout`, `survey-review-workbench`,
`fieldwork-review`). Point at it — or at your own manifest, or a hosted URL — by
setting `registryUrl`:

```json
{
  "registryUrl": "examples/registry/manifest.json"
}
```

Managing connected sources requires the Station operator and an
`access:manage` credential. Standard paired clients can browse ordinary
catalog items without gaining host source-management authority.

The Registry's Add marketplace flow connects additional public GitHub Skill
libraries, local Skill directories and local/HTTPS Station manifests without
changing `registryUrl`. Sources persist separately, can be refreshed or disabled,
and report offline/stale/error status independently. Offline plugin rows retain
the current installed state from the local Library, even after an update or
removal; cached catalog metadata cannot declare a package installed. Removing one preserves
installed content and provenance in the Library. Unsupported marketplace index
formats and private credential-bearing URLs are refused rather than imported
as an assumed compatible catalog. Plugin-contributed registry providers appear
through their existing visibility/grant lifecycle; manage their availability
through the owning plugin. Source configuration is a regular file bounded to
8 MiB, at most 32 user-added sources and 32 retained catalog snapshots, with
at most 512 rows in each snapshot. Corrupt, oversized, unsupported and
nonregular configuration is refused without replacing its bytes; restore the
existing file before continuing. Plugin catalog rows and package claims from
a Station manifest are read together from one fresh observation. Existing
bare-item registry aliases can become source-qualified on a reviewed update
only when the original item ID and registry key match. The update retains the
existing plugin data owner; a different registry key cannot claim it. See [marketplace APIs](../reference/api.md#manage-marketplaces)
and the published provider types in `@kontourai/station-contracts/catalog`.

A configured value always wins over the bundle. Relative paths resolve against
the install root; absolute paths and `https://` URLs are used as given. An
installation without an `examples/` directory simply registers no registry
rather than failing to start.

Two constraints govern what can appear in a manifest, both enforced by tests:

- **Registry path validation is not manifest-name validation.** The registry's
  path-segment check accepts `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`; installed manifest
  names must also satisfy the stricter lowercase, length, and reserved-name
  rules above. Put the human label in `displayName` (or the Agent Plugins
  Station namespace's `title`).
- **`build` is rejected.** `buildPlugin` refuses any manifest declaring a host
  shell build. Ship a prebuilt bundle or use a Station-supported entrypoint.

Entry `source` values (plugins and `tools`) are confined by
`JsonManifestRegistryProvider` in
`src-server/providers/registries/json-manifest-registry.ts`:

- **A local manifest's sources are plain directories inside the registry
  root**, which is the parent of the manifest's directory. That is why the
  bundled catalogs can name `../minimal-layout`. Relative and absolute paths
  are both checked after following symlinks.
- **Git sources must be remote URLs** (`https://`, `ssh://`, or
  `git@host:path`). A local source whose path ends in `.git`, contains `#`, or
  holds a `.git` entry (a working checkout) is refused, as is a `file:` URL.
  Both `.git` checks cover every spelling a filesystem may read as `.git`
  (case, trailing dots, `git~1`, and code points HFS+ ignores).
- **A hosted manifest never names local paths.** A relative source resolves as
  a URL on the manifest's host.

A refused entry stays listed without a source, and installing it reports why.

### Install and use a bundled layout

Registry is the discovery and installation surface; **Plugins** is the
installed-plugin management surface. On a fresh Station installation, open
**Registry → Plugins**, select a bundled starter such as **Minimal Layout**,
and choose **Install**. No local path is needed for a bundled item.

After installation, refresh Registry or open **Plugins** to confirm the item is
installed and runtime activation is ready. A ready installation makes a layout
contribution available; it does not add that layout to every project. Open the target project, choose **Add**, then
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

### Recover interrupted activation

An **Activation pending** plugin retains its code and data while its runtime
contributions remain unavailable. Open **Plugins**, select it, and choose
**Review recovery**. Review the permissions and retained dependencies, then
choose **Recover plugin** and confirm the permission review. Recovery does not
fetch replacement code or reset stored data. Trusted permissions still require
the separate host approval flow.

A recovery request may be accepted while runtime activation remains pending.
Use **Refresh status** to read its current state; do not automatically replay the
request. If a dependency must recover first, follow the server's dependency
message, then obtain a fresh review for the parent. A changed approval or
installation requires a new review, never reuse of an earlier decision.

## layout.json

Legacy layout plugins only. A plugin that declares `workspacePanes` has no
`layout.json`, and an Agent Plugins manifest refuses the `layout` field.

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

The legacy `type: "prompt"` action above is retained for review; its `data`
string is not a runnable command-skill reference. Use the
[workspace host action contract](#actions-that-belong-to-the-workspace-host) for executable
plugin-authored prompts.

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

Current MCP Apps support resolves the pinned integration/tool and declared
`ui://` resource, loads bounded resource content, and uses a different-origin
sandbox proxy for interactive rendering. The older embedded-result path is
limited to read-only-pinned layouts. The host bridge and server apply different
parts of `approvalPolicy`; a request-supplied policy is not independent proof
of a person's approval. Resource policy is drawn from resource metadata, not
tool-level policy. Secure-scheme filtering is not complete CSP source-expression
validation or browser-egress assurance. See [MCP Apps in Station](../design/mcp-ui-host.md)
for visibility, policy, transport custody and failure boundaries. A tool ref in
this example illustrates syntax; that tool must actually advertise a UI resource.

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

- Export a `components` map. Its keys match each Workspace Pane's
  `renderer.name` (or, in a legacy layout plugin, the layout.json tab
  `component` fields). Every plugin's components share one host registry, so
  prefix the keys with the plugin name (`my-plugin-workspace`); two plugins
  exporting the same key would replace each other.
- Components receive `LayoutComponentProps`: `{ layout, activeTab, onShowChat, onLaunchPrompt }`
- In-process components use exported hooks from `@kontourai/station-sdk`;
  isolated frames use the supported host-message contract rather than the
  host's React context
- `@tanstack/react-query` hooks share the host's QueryClient

## SDK Integration

Use the SDK root and owning UI subpaths for plug-in UI. For headless Agent
execution and delegation, use `@kontourai/station-sdk/agent`; the builder and
host bridge share its canonical clients. A plug-in can distribute an Agent and
invoke it from a Pane, while a headless application invokes the same identity.
See [Agent development](agent-development.md) and
[ADR 0021](../adr/0021-separate-plugin-and-agent-sdk-surfaces.md).

Use the documented SDK root or owning subpath. Key root hooks:

### Agents & Chat

- `useAgents()` lists every available Agent; `useAgent(slug)` reads one.
- `useSendToChat(agent)` sends a message to chat as a specific Agent and opens
  the dock. Name your own plugin's Agent as `'<plugin>:<agent>'`; the hook
  derives the Agent's identity from it and sends only when the named plugin
  contributed that Agent.
- `useSendMessage()` sends to the active conversation; `useCreateChatSession()`
  and `useOpenConversation()` start or reopen one in the chat dock.
- `useConversations()`, `useConversation(id)` and
  `useConversationMessages(id)` read conversations.

<!-- compile-checked: examples/docs-snippets/src/plugins-agents-and-chat.tsx -->
```tsx
import { useAgentInvokeMutation, useSendToChat } from '@kontourai/station-sdk';

export function SummarizeActions() {
  // Send a message to an Agent your plugin contributes. The qualified form
  // names the plugin too, and sends only when the named plugin contributed
  // that Agent.
  const sendToChat = useSendToChat('my-plugin:assistant');

  // Invoke an Agent programmatically (no chat UI), by its Agent id.
  const invoke = useAgentInvokeMutation('assistant');

  return (
    <>
      <button
        type="button"
        onClick={() => sendToChat('Summarize this document')}
      >
        Summarize in chat
      </button>
      <button type="button" onClick={() => invoke.mutate('Hello')}>
        Invoke without chat
      </button>
    </>
  );
}
```

### Auth & User

```tsx
import { useAuth, useUserLookup } from '@kontourai/station-sdk';

const { status, provider, user } = useAuth();
// status: 'valid' | 'expiring' | 'expired' | 'missing' | 'not-configured'
// user: { alias, name, email, ... }

const { data: profile, loading, error } = useUserLookup('jdoe');
```

Pass the alias to the [hook](../../packages/sdk/src/hooks/operations.ts); it
starts the lookup and returns reactive state, not an imperative `lookup` method.

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
const result = await callTool('assistant', 'search_files', { query: 'hello' });
// The operation's response value; its shape depends on the tool.
```

This calls `POST /agents/:slug/tools/:toolName` on the server (or dev server). The dev server proxies this to the connected MCP process.
This imperative API requires the clean persisted Agent ID. Unlike
`useSendToChat`, it does not accept a plugin-qualified reference. Failed
operations throw; it does not return the outer `success`/`response` envelope.

### Server-Side Fetch Proxy

For external HTTP calls from plugin UI (requires `network.fetch` permission):

```tsx
import { useServerFetch } from '@kontourai/station-sdk';

const serverFetch = useServerFetch();
const result = await serverFetch('https://api.example.com/data', {
  method: 'GET',
  headers: { Authorization: 'Bearer ...' },
});
// result: { status: number, contentType: string, body: string }
// A proxy response with success: false throws; handle errors at the call site.
```

The [hook implementation](../../packages/sdk/src/hooks/operations.ts) returns
the callable directly and strips the proxy's `success` field from a successful
result.

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
  async getTheme() { return null; }, // or white-label overrides; see examples/custom-branding
  async getWelcomeMessage() { return 'Welcome to My App'; },
});
```

### userIdentity

```js
module.exports = () => ({
  async getIdentity() {
    // Returns: { alias, name, title, email, profileUrl }
    return { alias: 'jdoe', name: 'Jane Doe' };
  },
});
```

### userDirectory

```js
module.exports = () => ({
  async lookupPerson(alias) {
    // Returns: UserDetailVM
    return { alias, name: 'Jane Doe', email: `${alias}@example.com` };
  },
  async searchPeople(query) {
    // Returns: UserDetailVM[]; an empty result is valid.
    return [];
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

Implements `listAvailable()`, `listInstalled()`, `install(id)`, and
`uninstall(id)` as above, plus these required methods:

| Method | Result |
| --- | --- |
| `getToolDef(id: string)` | `Promise<ToolDef \| null>` |
| `sync()` | `Promise<void>` |

`getToolDef` returns the integration definition or `null` when this provider
does not own the ID. `sync` reconciles that provider's definitions. The
[integration registry aggregator](../../src-server/providers/registries/integration-registry-provider.ts)
calls both methods on its providers. `update(id)` and
`installByCommand(command)` are optional. The
[auth routes](../../src-server/routes/system/auth.ts) similarly call
`getIdentity`, `lookupPerson`, and `searchPeople` with those exact names.

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
Approval records a durable grant against the reviewed code and then requests
runtime reconciliation. The [host approval route](../../src-server/routes/plugins/plugin-host-approval-routes.ts)
returns the reconciliation status, operation ID, generation, and any effects or
failures; it can report `incomplete`, including when the runtime is unavailable.
Recorded approval therefore does not establish that the server module or
providers are active. Inspect the reconciliation result and current plugin
status before treating trusted behavior as available. Denial does not grant the
requested permissions. You can revisit an installed plugin from **Plugins**,
select it, and choose **Review Permissions**.

Recorded permissions and currently effective permissions can also differ after
the code changes. The [grant derivation](../../src-server/services/plugins/plugin-permissions.ts)
compares the installed bytes with the reviewed content digest. Changed or
unreadable content sets `contentBinding: "changed"` and puts every recorded
permission in `withheld`, including passive permissions; those grants no longer
authorize the current code. The
[Permissions panel](../../src-ui/src/views/plugin-management/PluginPermissionsSection.tsx)
explains that state. A fresh approval or installation/update must bind the
current readable bytes before permissions apply again; approving one permission
does not restore all previously withheld permissions. When current content is
readable, older grants without a recorded digest are explicitly `unverified`
and retain their effect under the migration policy until a later approval or
update binds them.

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

Plugins can declare dependencies on other plugins. The server resolves them
recursively during the parent's reviewed installation; the declaration itself
does not grant trusted permissions.

```json
{
  "dependencies": [
    { "id": "auth-plugin", "source": "git@github.com:org/auth-plugin.git" },
    { "id": "registry-plugin" }
  ]
}
```

- If `source` is provided and the dependency isn't installed, it's cloned and installed automatically
- Local dependency sources, relative or absolute, resolve from the declaring
  local plugin directory and must stay inside its sibling package root (the
  directory holding the declaring plugin, judged through its real path).
  Traversal and symbolic links below that root are refused
- A local dependency is copied as a plain directory, never cloned, and every
  `.git` entry in it is left out, so a sibling that is its own git checkout
  still works. A declared path ending in `.git` or containing `#` is refused:
  name a git dependency by its remote URL (`https://…` or `git@host:path`)
- A plugin fetched from a remote source may declare only remote dependency
  sources, and so may each of its remote dependencies
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

Physical cleanup depends on the installation format. The digest-bound legacy
dependency path can remove owned trees under those conditions. Managed portable
dependencies instead withdraw their selections while retaining code and data
through the installation journal. Neither path gains deletion ownership over
an independently installed dependency merely by referencing it.

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

Echo the preview's `grantRevision` for the parent and each dependency approval,
as the [CLI installer](../../packages/cli/src/commands/install.ts) does. These
are opaque revisions, not values the client invents: they bind the decision to
the grant state that was reviewed. Changed grants or replacement installation
generations can supersede a pending operation; preview again rather than
reusing a stale decision.

Install, recovery, update, and removal are person-only lifecycle operations.
The [route guard](../../src-server/routes/plugins/plugin-person-approval.ts)
refuses Station's internal agent-tool identity and delegated or unconfirmed
device identities. Agent tools can propose an operation for a person to
complete. Install, recovery and update also run the package's code, so a paired
device additionally needs the operator's `coding:exec` grant (`403` with
`code: 'command-not-granted'` otherwise); the operator in person never does.
Preview only fetches and reads a manifest and needs no grant. This is an
authenticated Station API boundary, not isolation from arbitrary code running as
Station's operating-system user; that code can access the same local credentials
and files.

```bash
API_BASE="${STATION_API_BASE:-http://127.0.0.1:18141}"
: "${STATION_API_CREDENTIAL:?set a paired Station bearer for direct API use}"

# 1. Preview: stages a copy, reports what installing it would require, and
#    throws the copy away. Does not publish an installation or grant.
curl -X POST "$API_BASE/api/plugins/preview" \
  -H "Authorization: Bearer $STATION_API_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  -d '{"source": "git@github.com:org/my-plugin.git"}'
# → { "valid": true, "manifest": …, "dependencies": [...],
#     "contentDigest": "sha256:…",
#     "grantRevision": "<opaque parent revision>",
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
          "grantRevision": "<parent revision from preview>",
          "dependencies": ["shared-lib"],
          "dependencyApprovals": [{
            "id": "shared-lib",
            "permissions": ["providers.register"],
            "contentDigest": "sha256:…",
            "grantRevision": "<dependency revision from preview>",
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
          "grantRevision": "<parent revision from preview>",
          "dependencies": []
        }
      }'

# List installed
GET /api/plugins

# Update through the installed format's lifecycle transaction
POST /api/plugins/:name/update

# Remove
DELETE /api/plugins/:name

# Check for updates across all plugins
GET /api/plugins/check-updates
```

Update, update checks, git details, and the changelog read only the plugin
directory's own repository (its `.git`). A plugin without one reports no git
details and has no git update source, even when the Station home sits inside
another git checkout.

A local folder that an open install proposal names (one an agent asked for)
is copied with every `.git` entry left out, at any depth, and a proposed local
git repository is refused. The preview reports `gitMetadata: "excluded"` in
that case, and the install's `consent` sends it back, so both stage the same
bytes. Such a plugin has no git update source; reinstall it from its folder to
update it. Station remembers that folder (in `plugin-source-staging.json` in
the Station home), so every later preview and install of it leaves its git
metadata out too, after the proposal is completed or dismissed and after an
uninstall. To get git updates for it, install from the repository's remote
URL instead. An install from your own path, which no proposal has named,
keeps its `.git`.

### What Happens on Install

The [install transaction](../../src-server/services/plugins/plugin-install-transaction.ts)
has separate portable and legacy publication paths:

1. Acquire source into a temporary staging directory and parse its manifest
   format. Reject invalid identities before publication.
2. Check consent against the staged content digest, declared permissions,
   approved dependency graph, and captured grant revisions before changing
   installed bytes, grants, or registry aliases. Staging itself is temporary
   filesystem work, not installation. Required dependency decisions travel
   through the same admission checks.
3. Build the staged bytes and validate bundle containment. Under the publication
   transaction, recheck authority and conflicts before selecting the result.
4. For Agent Plugins, publish a retained materialization and installation
   generation with an independently scoped data directory. Portable Skills
   and `mcp.json` servers are read from that live package; MCP servers become
   owner-qualified ToolDefs, not copied integration definitions. Validated
   Station namespace contributions use their existing host owners.
5. For legacy manifests, copy the built staged tree into
   `<STATION_HOME>/plugins/<name>/`, synchronize declared Agent definitions,
   retain declared layout sources, and import eligible bundled integration
   definitions through the legacy path. These copies are not universal
   portable-package behavior.
6. Reconcile runtime contributions and current grants. Passive permissions can
   be granted automatically; active permissions need the reviewed consent,
   and trusted permissions still require the separate host approval. A pending
   permission is not an activated capability.

Publication is conditional on the captured grants and installation generation
still being current. Install, update, reload, and removal coordinate runtime
configuration activation; Station waits for displaced provider adapters to
stop before reporting completion. An accepted mutation that still needs runtime
reconciliation returns HTTP `202` with a `configurationActivation` receipt.
Replacement removes owned Agent definitions no longer declared and refuses a
changed manifest name.

A portable [update](../../src-server/routes/plugins/plugin-lifecycle-routes.ts)
captures the expected installation identity, generation, artifact, materialization,
and data scope, then stages its registry or Git source through the install
transaction while preserving data. It is not an in-place `git pull`: a missing
update source, changed authority, or a new consent requirement can refuse the
operation. Preview and install the new source when a fresh decision is needed.
The [installation lifecycle](../design/plugin-installation-lifecycle.md) owns
retained recovery, reset, and reclamation details.

### Applied registry trust policy

The local installer verifies registry claims under the host's applied
`registryTrust` policy. Configuration is a candidate until successful runtime
initialization or a full rebuild publishes it. A configured profile selects an
exact registry key and trusted public Ed25519 keys; neither a registry entry nor
an install request supplies host trust anchors. The default bundled catalog
has no automatic publisher trust badge.

A profile requires a corresponding package claim even when its signature mode
is `optional`. Preview exposes an opaque `registryTrustRevision`; install
consent echoes that observation, including dependency decisions. Verification
binds registry, source, package/version and source-tree digest. The manifest is
validated separately, and the built artifact has its own digest. A signature
does not establish harmless code, a sandbox or reproducible builds.

Managed retained recovery uses its journal-bound artifact, current policy and
fresh consent. It does not fetch the original source or registry. Changed
claims, signing principals or policy epochs require reviewed continuity; there
is no general pin-update/migration or user-facing code-rollback operation here.
`RegistryLastKnownGoodStore` remains a separate archive utility, not the owner
of managed recovery. See [Applied registry trust policy](../design/registry-trust-policy.md)
and [installation lifecycle](../design/plugin-installation-lifecycle.md) for
refusals, retention and the legacy path's limits.

## Build System

Layout plugins (with `entrypoint`) are built automatically by the server using esbuild. No custom build script needed.

The shared builder owns dependency preparation. A managed Station workspace
must already have its dependencies prepared with `npm run dependencies:ci`.
For a standalone plugin, `ensurePluginDeps` runs a bounded npm installation
with lifecycle scripts disabled, so registry access may be required before
bundling. A dependency timeout is a failed build attempt, not a ready plugin.

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

The scaffold declares SDK/shared peer dependencies. The browser SDK root and
its admitted client/voice entries are host-provided externals. The Node
`@kontourai/station-shared/build` entry is build-time tooling; shared runtime
helpers are not a blanket host external. Check the builder's actual allowlist
before importing another subpath into browser code.

### Shared Modules (Externals)

These are provided by the host at runtime via `window.__station_ai_shared` and must NOT be bundled:

| Module | Notes |
|--------|-------|
| `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` | React runtime |
| `@kontourai/station-sdk` | All SDK hooks and utilities |
| `@kontourai/station-sdk/agent`, `@kontourai/station-sdk/client`, `@kontourai/station-sdk/voice` | Admitted React-free client and voice runtime entries |
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

The earlier SDK-barrel change reported 43 app-unreached modules and about
22.8 KB gzip removed from first paint. Those figures describe that historical
measurement, not the current bundle size. The maintained contract is the lazy
readiness boundary above.

The centralized build handles externalization automatically. If you use a custom `build.mjs`, externalize these modules and add the runtime shim (see `packages/shared/src/build.ts` for `RUNTIME_SHIM` and `SHARED_EXTERNALS`).

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

This creates the full plugin structure with a working entry point, namespaced
Workspace Pane declarations, and an Agent. It does not generate `layout.json`.
`plugin create`/`build`/`dev`/`install` resolve paths against
the directory where you invoke `station`, so `my-plugin/` is scaffolded in —
and the rest of this workflow operates on — your actual working directory.

Available templates:

- `full` — Workspace Panes + Agent + build config (CLI default)
- `pane` — UI-focused Workspace Pane starter
- `provider` — server-side starter with `serverModule` and provider examples

The CLI also accepts `--template=layout` as an alias for `pane`. The shared
scaffold builder and Project scaffold API default to `pane`; the CLI wrapper
explicitly chooses `full` when no template is supplied.

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

The dev server reads installed dependencies from `<STATION_HOME>/plugins/` and
starts the existing install command for a missing dependency with a resolved
source. That is an installation attempt, not proof that consent, activation or
dependency readiness completed before the preview starts.

Direct `--host` or non-loopback HTTP exposure is not supported. For remote development, run `station plugin dev 4300` on the development host, forward it with `ssh -N -L 4300:127.0.0.1:4300 user@dev-host`, and open `http://127.0.0.1:4300` locally. The privileged file, MCP, fetch, and reload routes enforce the same exact loopback browser boundary.

The development fetch proxy accepts public HTTP(S) destinations only. It validates every DNS answer and redirect, strips credential and hop-by-hop headers, forces identity encoding and rejects encoded upstream responses, and rejects private, loopback, link-local, and cloud-metadata addresses. Limits are 1 MiB per JSON request, 10 MiB per identity fetch response, 10 seconds per DNS-through-response hop, five redirects, and 32 simultaneous reload streams.

### 3. Build

```bash
npm run build   # tsx build.ts        — dist/bundle.js, production, no sourcemaps
npm run dev     # tsx build.ts --dev  — dist/bundle-dev.js, inline sourcemaps
```

Both run `buildPlugin()` from `@kontourai/station-shared/build`. These are one-shot
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
station plugin update my-plugin # update through the installation lifecycle
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

An incoming correlation header is reused when present. Station does not inject
a newly generated ID into the plugin's request headers; use the lifecycle hook
or response header for that host-generated value.

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

Installed Agent IDs remain clean and globally unique; the installer refuses an
existing ID rather than adding a namespace prefix. Choose a unique ID if the
scaffold's `assistant` is already owned. The `'<plugin>:<agent>'` form accepted
by `useSendToChat` is an ownership-checked reference, not the stored Agent ID.

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
| `placement` | no | `"achievements"` is consumed by the profile page. Omission does not promise a global UI location. |

The current host consumer is the
[profile page](../../src-ui/src/pages/ProfilePage.tsx), which requests
`getLinks('achievements')`. A declaration without placement can be stored in
the registry, but no global host placement is established by that contract.

## Examples

| Example | What it shows |
|---------|---------------|
| `examples/demo-layout/` | Full layout with agents, tabs, SDK hooks |
| `examples/minimal-layout/` | Minimal entry point, no agents |
| `examples/custom-branding/` | Branding provider only |
| `examples/elevenlabs-voice/` | STT/TTS voice provider |
| `examples/nova-sonic-voice/` | Nova Sonic voice provider |
| `examples/meeting-transcription/` | Meeting transcription over a registered STT provider |
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

### Actions that belong to the workspace host

Declare package-wide actions once in `plugin.json.workspacePaneHost`, using
`version: "station.workspace-pane-host-contribution/v1"`. A Project's direct and
placed Pane views display the same host action bar, outside the individual Pane.
Use `agentSelection.availableAgents` and an optional explicit `defaultAgent` to
choose the package's Agents. An `own-plugin-agent` reference contains a clean
`agentId`; Station supplies installation ownership. `requiredAgents` only checks
availability and never selects an Agent.

An action's `intent` is either literal `prompt` data or an exact own-package
`plugin-prompt` id. Label text is never treated as a prompt or routing address.
An action may fix its own Agent; that binding takes precedence over the host
selector. Grant `agents.invoke` in Library, configure the native model or external
engine connection, and make the Agent available in the Project before running it.

The host confirms that a conversation was accepted and offers **Open
conversation**. If delivery is uncertain, inspect Activity; the host does not
retry a possibly started action. Revoked permissions, changed packages, missing
Agents, and unavailable execution modes remain visible failures.

The demo, enterprise, coding, getting-started, and knowledge-docs examples each
include an explicit old-to-new behavior table. Their package-global declarations
are migrated. Enterprise tab-local **Review** buttons focus their matching host control; invocation and Agent authority remain with that control. Existing persisted Layout records
are not rewritten, and this does not claim the entire structural Layout
migration is complete.

For an Agent Plugins 1.0 manifest, place the declaration at
`extensions["io.kontourai.station"].workspacePaneHost` alongside
`schemaVersion: "1.0"` and the namespace's `agents`. Station validates the host
shape with the same contribution parser used by legacy manifests. Registered
prompt actions read the normalized namespace's `prompts.source`; unknown
portable root fields never supply fallback actions or Agents.

Legacy plugin Layout actions never launch through an unqualified Agent fallback.
Station can project unambiguous `inline-prompt` and `globalSkills` declarations
from the installed artifact into the same captured host admission path, with an
explicit available/default Agent and the current invocation permission. Ambiguous
`prompt` declarations and unsupported action kinds remain review-only until the
plugin is updated. Saved plugin Layout controls cannot revive execution after
uninstall or a stale catalog response. User-authored Layouts without a plugin
owner retain their explicit Agent actions.

The five examples above retain their legacy manifest format because their
structural Layout declarations have not yet been mapped. The remaining
[example migration](https://github.com/kontourai/station/issues/265) work is specific; the related [authoring-default decision](https://github.com/kontourai/station/issues/346) supplies its authoring context:

| Example | Required structural mapping before switching its manifest schema |
| --- | --- |
| `demo-layout` | Map `layout` (`demo`, `./layout.json`) and its tab component references to declared Workspace Panes and placement. Preserve its original native `assistant`. |
| `coding-starter` | Map `layout` (`coding`, `./layout.json`) and each authored tab component to Workspace Panes and placement. Preserve the explicit `coding-starter-assistant` host default. |
| `getting-started-starter` | Map `layout` (`getting-started`, `./layout.json`) and its tabs to Workspace Panes and placement. Preserve the explicit `getting-started-starter-assistant` host default. |
| `knowledge-docs-starter` | Map `layout` (`knowledge-docs`, `./layout.json`) and its tabs to Workspace Panes and placement; retain its declared knowledge namespaces through their existing owner. |
| `enterprise-layout` | Map `layout` (`enterprise`, `./layout.json`) and Calendar/CRM Review links to Workspace Panes/placement; map the required `NOTES_VAULT_PATH` install input, the two file-based CRM/calendar integration declarations, and the local `../shared-providers` dependency source without discarding any of them. Preserve its original native `enterprise-assistant`, knowledge declaration, and four authored host prompts. |

For each conversion, move `displayName` to namespace `title`, make the
`entrypoint` explicitly package-relative (`./src/index.tsx`), and move the
supported Agent, capability, permission, and host-action declarations into the
Station namespace. A schema-only rewrite is insufficient: installation,
activation, each component, and real action execution must be verified together.

## Extension loading and recovery in the client

A remote Station's extensions are off until this device explicitly consents.
That is a normal trust setting, not a workspace-wide failure banner. The
Extensions screen explains it and offers Enable remote extensions, with the
existing warning about app-wide authority before consent is stored.

A failed inventory or bundle load produces a notification linking to Extensions.
The screen retains the failure message and Retry extensions until the registry
recovers. A failure to start the deferred registry itself produces a notification
with Reload Station; it does not displace unrelated work with a global banner.
Core shell and connection recovery retain their own failure surfaces.

Owners: [registry bootstrap](../../src-ui/src/components/registry/PluginRegistryGate.tsx),
[Extensions view](../../src-ui/src/views/RegistryView.tsx), and
[deferred capability boundary](../../src-ui/src/components/DeferredCapabilityBoundary.tsx).
These presentation changes do not enable bundles or alter consent storage,
origin binding, plugin permissions or native bridge authority.
