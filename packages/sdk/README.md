# @kontourai/station-sdk

The SDK connects plugin UI to Station's host contexts and APIs. It provides
React components, hooks for Agents, chat, navigation and notifications, and
explicit client subpaths. The [SDK reference](../../docs/reference/sdk.md)
owns the detailed public API; [package.json](./package.json) owns the available
entry points.

The root entry is a React/host surface. `@kontourai/station-sdk/client` is the
React-free request surface with explicit API-base arguments; it does not create
credentials or authorization. Voice, Workspace Pane and protected-query surfaces
have separate opt-in entries. Use a release containing the required exports;
source availability in this checkout does not prove npm publication.

Trusted server modules may also import the re-exported
`PluginOperationalEventObserver` and
`PluginOperationalEventSubscriptionEntry` types for durable, capability-scoped
event observation. The host retains consumer identity, grants, projection, and
settlement authority; see the plugin guide's durable operational-event section.

## Choose an SDK surface

Use the root and documented UI subpaths for plug-in hooks, components, and host
integration. Use `@kontourai/station-sdk/agent` for headless Agent definitions,
execution, delegation, decisions, observation, and outputs. `/client` remains
the broader React-free Station API entry. All reuse canonical contracts and
client owners. The Agent entry adds no runtime, automatic retry policy, or
global selected Station.

See [Agent development](../../docs/guides/agent-development.md), the
[headless example](../../examples/headless-agent/README.md), and
[ADR 0021](../../docs/adr/0021-separate-plugin-and-agent-sdk-surfaces.md).
The Agent entry is present in this source checkout; published versions must
include it in their export map. The package still has its existing React peers.

## Installation

```bash
npm install @kontourai/station-sdk
```

## Exact tool results

The React-free `@kontourai/station-sdk/client` entry exports
`getSessionToolResult(apiBase, sessionId, eventId)`,
`attachTaskToolResultReference(apiBase, taskId, { sessionId, eventId })`, and
`getTaskToolResultReferences(apiBase, taskId)`. Result identity is the exact
terminal event, not a tool-call ID or matching text. Reads return Thread's
bounded inert projection; Keep stores an identity reference, never raw arguments
or a copied result. Station reauthorizes each read and the actual queued write.

`@kontourai/station-sdk/task-tool-results` is the separate React query surface.
Its protected query withholds cached content during revalidation, clears prior
content on failure, and cancels obsolete requests when the Task changes.
`TaskToolResultRequestError` keeps a generic message, the response status and
the refusal's machine `code` and delta-seconds `Retry-After` as `retryAfterMs`;
it remains a plain `Error` subclass and does not expose a protected URL or
an upstream error body.

These APIs do not change semantic answer standing or automatically promote an
Output. The [connected Basis host](../../src-ui/src/workspace-panes/ConnectedStationBasisPane.tsx)
wires inspection and identity-only Keep actions to them; it captures the current
request authority before a read or mutation.

## Plugin installation results

Plugin install mutations expose typed current parent/dependency permission status
through `PluginInstallResult`. See the canonical [Plugin Query Hooks reference](../../docs/reference/sdk.md#plugin-query-hooks)
for older-server unknown-status handling and registry result types.

## Workspace Pane authoring

Import `@kontourai/station-sdk/workspace-pane` for the opt-in portable Pane
contract. The [Workspace Pane authoring guide](../../docs/guides/workspace-pane-authoring.md)
covers descriptor identity, capabilities, placement, actions, alternatives,
provenance/version/lifecycle, and `npm run workspace-pane:conformance`.

## Visual skill experiences

The React-free `/client` entry reads installed experience inventory and immutable
Session history, and carries an explicit source-bound start through canonical
foreground chat. The canonical inventory and Session reader is a static import
of that entry and validates each successful feature response before exposing
data. The SDK root supplies the corresponding
React Query hooks.
Inventory without `executionContract: '1.0'` remains a preview; source identity
and invocation preconditions are revalidated before execution.

The opt-in `/workspace-pane` helper `createSkillExperiencePaneHost` connects an
isolated, self-rendering declared pane to its host-bound read, question answer
and stage preparation methods. It receives no credential or arbitrary HTTP
bridge. See the [public contract](../../docs/reference/skill-experiences.md),
[SDK reference](../../docs/reference/sdk.md#visual-skill-experiences) and
[independent rich example](../../examples/rich-skill-experience/README.md).
Use a published release containing these exports; local source and controlled
tests do not establish registry publication or native rendering.

## Source distribution and host requirements

The package manifest exports **TypeScript source** under `src/`, including a
`.tsx` component entry. The local `build` script emits `dist/` and copies CSS,
but the package's export map and published-file list use source, not that output.

Station's plugin build uses esbuild through
`@kontourai/station-shared/build`. A different consumer must handle TypeScript,
JSX, source imports and CSS where its chosen entry needs them. A TS-aware loader
alone does not supply React contexts, browser APIs or Station's host runtime;
this README does not establish compatibility with every bundler or runtime.

## Start from npm

An external plugin can use the package build helper without a Station checkout.
Use Node 24 for `station-shared`'s declared build/runtime requirement. The example
below creates a separate authoring directory; inside the Station repository,
use the managed `npm run dependencies:ci` workflow instead of these install steps.

```bash
mkdir hello-station && cd hello-station
npm init -y
npm pkg set type=module
npm pkg set scripts.build="tsx build.ts"
npm pkg set scripts.dev="tsx build.ts --dev"

npm install @kontourai/station-sdk @kontourai/station-shared
npm install -D tsx @types/react

mkdir src
```

`plugin.json` — the manifest Station reads:

```json
{
  "name": "hello-station",
  "version": "1.0.0",
  "sdkVersion": "^0.7.0",
  "displayName": "Hello Station",
  "description": "A Station layout plugin",
  "entrypoint": "src/index.tsx",
  "capabilities": ["navigation"],
  "permissions": ["navigation.dock"],
  "layout": { "slug": "hello-station", "source": "./layout.json" }
}
```

`layout.json` — the layout the manifest points at:

```json
{
  "name": "Hello Station",
  "slug": "hello-station",
  "icon": "👋",
  "tabs": [{ "id": "home", "label": "Home", "component": "hello-station-home" }]
}
```

`src/index.tsx` — the entrypoint. Export a `components` map keyed by the tab
`component` ids in `layout.json`:

```tsx
import { type LayoutComponentProps, useNavigation } from '@kontourai/station-sdk';

function Home({ onShowChat }: LayoutComponentProps) {
  const { setDockState } = useNavigation();
  return (
    <section style={{ padding: '1.5rem' }}>
      <h1>Hello Station</h1>
      <button type="button" onClick={() => { setDockState(true); onShowChat?.(); }}>
        Open Chat
      </button>
    </section>
  );
}

export const components = { 'hello-station-home': Home };
export default Home;
```

`build.ts` — the build. `buildPlugin` is the same function Station itself runs;
`tsx` is what lets Node import it from the TypeScript source these packages
ship:

```ts
import { buildPlugin } from '@kontourai/station-shared/build';

const mode = process.argv.includes('--dev') ? 'dev' : 'production';
const result = await buildPlugin(process.cwd(), mode);

if (!result.built) console.log('No entrypoint in plugin.json — nothing to bundle.');
else console.log(`Built ${result.bundlePath}`);
```

Then build it. Both commands produce a bundle once; `--dev` selects development
output and does not start a watcher:

```bash
npm run build   # production bundle at dist/bundle.js
npm run dev     # dist/bundle-dev.js with inline sourcemaps
```

The host supplies React, `@tanstack/react-query`, the root SDK, and its listed
client/voice entries through the [shared runtime](../../src-ui/src/core/pluginSharedRuntime.ts).
The build helper's [external allowlist](../shared/src/build.ts) is exact; not
every SDK subpath is externalized. The resulting bundle expects Station's host
registration and contexts; it is not a standalone web application.

## Deployment capability facts

`GET /api/system/capabilities` keeps its existing runtime, voice, context, and
scheduler fields and may also return provider-neutral deployment facts:

```ts
type DeploymentCapabilityState = 'supported' | 'unsupported' | 'unknown';

interface ServerCapabilities {
  deployment?: {
    features?: Partial<
      Record<
        'web-push' | 'scheduler',
        { state: DeploymentCapabilityState }
      >
    >;
  };
}
```

Use `getDeploymentCapabilityState(capabilities, id)` instead of treating an
absent field as support. The helper returns `unknown` for an older server,
unknown capability ID, or malformed payload. Product rollout, configuration,
permission, and transient health remain separate facts; deployment support
does not imply any of them.

## Workspace Pane contract

Use the opt-in `@kontourai/station-sdk/workspace-pane` entrypoint to describe
or read panes. It is deliberately outside the main React SDK barrel: the
contract stays host-neutral and does not add parser/adapter code to an ordinary
plugin UI bundle. A descriptor declares what it supports; an instance records
the exact context currently bound to it. Neither form installs, authorizes, or
executes a renderer.

This SDK subpath also exports a React query hook. Consumers needing only pure
contract values/parsers can use `@kontourai/station-contracts/workspace-pane`;
do not assume the SDK entry is React-free because its data contract is host-neutral.

```ts
import {
  createWorkspacePaneCatalog,
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
} from '@kontourai/station-sdk/workspace-pane';

// This synthetic catalog preserves all three renderer/security classes. It
// describes panes only; it does not install, authorize, or execute them.
const parsedDescriptors = [
  {
    version: '1.0',
    id: 'builtin-files',
    name: 'Files',
    rendererId: 'builtin-files-renderer',
    renderer: { kind: 'builtin-component', name: 'file-tree' },
    placement: { supportedRegions: ['primary'] },
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'stable' },
  },
  {
    version: '1.0',
    id: 'plugin-review',
    name: 'Review queue',
    rendererId: 'plugin-review-renderer',
    renderer: { kind: 'plugin-component', name: 'review-queue' },
    placement: { supportedRegions: ['primary', 'secondary'] },
    provenance: { origin: 'plugin', pluginId: 'hello-station' },
    lifecycle: { stage: 'stable' },
  },
  {
    version: '1.0',
    id: 'mcp-issues',
    name: 'Issues',
    rendererId: 'mcp-issues-renderer',
    renderer: { kind: 'mcp-tool-ui', ref: 'issue-tracker/issues' },
    placement: { supportedRegions: ['standalone'] },
    provenance: { origin: 'mcp', mcpServerId: 'issue-tracker' },
    lifecycle: { stage: 'stable' },
  },
].map(parseWorkspacePaneDescriptor);

const descriptors = parsedDescriptors.filter(
  (descriptor): descriptor is WorkspacePaneDescriptor => descriptor !== null,
);
if (descriptors.length !== parsedDescriptors.length) {
  throw new Error('invalid pane contract');
}

const catalog = createWorkspacePaneCatalog({
  descriptors,
  instances: descriptors.map((descriptor) => {
    const instance = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: descriptor.id,
      instanceId: `example:${descriptor.id}`,
      stateKey: `example-state:${descriptor.id}`,
      boundContext: { sourceId: descriptor.id },
    });
    if (!instance) throw new Error('invalid pane instance');
    return instance;
  }),
});
```

The example has a synthetic built-in pane, a trusted-plugin pane, and a
sandboxed MCP App pane. `plugin-component` represents trusted plugin React
code; `mcp-tool-ui` represents a sandboxed MCP App. Do not flatten those
provenance/security classes when presenting catalog data. A plugin may
contribute an `mcp-tool-ui` pane; that record retains both its `pluginId`
contributor and its `mcpServerId` renderer attribution. Baseline layout tabs
continue to adapt through the same subpath and round-trip unchanged as retained
layout data.

For a current, data-only host catalog in React, use the same opt-in Pane entrypoint:

```tsx
import { useProjectWorkspacePanesQuery } from '@kontourai/station-sdk/workspace-pane';

const panes = useProjectWorkspacePanesQuery('project-a');
// `panes.data` contains descriptor requirements, instance bindings, and
// read-only source contributions. Disabled contributions carry a display reason;
// none of this authorizes or executes a renderer.
```

### Load the bundle

Install it with the CLI, which previews the source and asks for an installation
decision. Previewing and building can stage files and prepare dependencies;
approval is not a promise that no filesystem work has occurred:

```bash
station_checkout=/absolute/path/to/station
"$station_checkout/station" plugin install "$PWD"
```

The CLI resolves the selected Station and credential through its normal target
owner. A directory source requires an automatically resolved active-local target
or the default loopback fallback. Explicit `--api-base` and saved-Station
selections are refused for directory input even when their URL is localhost.
Use a Git URL for those selections; the CLI does not upload a local directory. The
[install command](../cli/src/commands/install.ts) performs preview before install
and carries the returned content digest, required permissions, registry/grant
revisions, dependency approvals and any `gitMetadata: "excluded"` into the
request. Prefer that client over a
hand-copied consent body. Missing or stale approval is refused; the transaction
may already have staged a source while checking it.

An approved installation makes supported contributions available for project
selection; it does not add a layout to every project. Trusted permissions can
remain `pendingConsent` for the parent or a dependency. Their separate host-owned
approval records a grant and requests runtime reconciliation; inspect both the
reconciliation result and current plugin status before treating a module or
provider as active. Changed or unreadable installed content can withhold recorded
permissions. See [Plugin permissions](../../docs/guides/plugins.md#plugin-permissions).

## UI Components

The SDK provides pre-built, theme-aware components for consistent styling across workspaces.

### Button

```tsx
import { Button } from '@kontourai/station-sdk';

function MyComponent() {
  return (
    <>
      <Button variant="primary" onClick={handleClick}>
        Primary Action
      </Button>
      
      <Button variant="secondary" size="sm">
        Secondary
      </Button>
      
      <Button variant="success" loading={isLoading}>
        Save Changes
      </Button>
      
      <Button variant="ghost" disabled>
        Disabled
      </Button>
    </>
  );
}
```

**Props:**
- `variant`: `'primary' | 'secondary' | 'success' | 'ghost'` (default: `'primary'`)
- `size`: `'sm' | 'md' | 'lg'` (default: `'md'`)
- `loading`: `boolean` - Shows loading state
- All standard button HTML attributes

### Pill

```tsx
import { Pill } from '@kontourai/station-sdk';

function MyComponent() {
  return (
    <>
      <Pill variant="primary">Active</Pill>
      
      <Pill variant="success">Completed</Pill>
      
      <Pill variant="warning">Pending</Pill>
      
      <Pill variant="error">Failed</Pill>
      
      <Pill 
        variant="default" 
        removable 
        onRemove={() => console.log('removed')}
      >
        Removable Tag
      </Pill>
    </>
  );
}
```

**Props:**
- `variant`: `'default' | 'primary' | 'success' | 'warning' | 'error'` (default: `'default'`)
- `size`: `'sm' | 'md'` (default: `'md'`)
- `removable`: `boolean` - Shows remove button
- `onRemove`: `() => void` - Called when remove button is clicked
- All standard span HTML attributes

## Voice session adapters

Use the `@kontourai/station-sdk/voice` entrypoint for one live, normalized
voice-session lifecycle. It intentionally stays outside the root SDK barrel so
plugins opt into the runtime contract explicitly.

```ts
import {
  VoiceSessionAdapterRegistry,
  VoiceSessionManager,
} from '@kontourai/station-sdk/voice';

const registry = new VoiceSessionAdapterRegistry();
registry.register(myVoiceSessionAdapter);

const manager = new VoiceSessionManager(registry);
manager.select(myVoiceSessionAdapter.descriptor.id);
await manager.start();
```

Adapters must publish immutable `VoiceSessionSnapshot` values with increasing
`revision` for that adapter or manager projection; subscribers must treat every
snapshot as a replacement rather than mutating it. The normalized lifecycle
states are `disconnected`, `connecting`, `connected-idle`, `listening`,
`transcribing`, `thinking`, `speaking`, `stopping`, and `error`.

Snapshots may additionally carry read-only presentation values when the
underlying provider has them: `transcript`, `transcriptRole` (`user` or
`assistant`), `muted`, and `inputAudioLevel` (normalized from 0 through 1).
They are optional so adapters that cannot observe a value remain compatible.

### Independent STT and TTS plugins

`STTProvider`, `TTSProvider`, and `voiceRegistry` remain the independent plugin
surface, including direct `startListening` / `stopListening` and `speak` /
`cancel` methods. To expose selected providers through the normalized
session lifecycle, compose the unchanged instances:

```ts
import { createProviderVoiceSessionAdapter } from '@kontourai/station-sdk/voice';

const adapter = createProviderVoiceSessionAdapter(sttProvider, ttsProvider);
await adapter.start();       // controls provider STT listening
ttsProvider.speak('Hello');  // still valid; adapter observes `speaking`
await adapter.interrupt();   // cancels TTS and retains active STT listening
await adapter.stop();        // stops STT and cancels TTS
await adapter.dispose();     // idempotently unsubscribes when replacing it
```

The provider-composition adapter has `interrupt: true` and `textTurn: false`. It does
not expose `sendText`: `sendText` is a user input text turn for adapters that
explicitly support a composed or realtime conversation, never a replacement
for provider TTS `speak`. Keep direct `speak` / `cancel` available to existing
plugin consumers.

Adapters must make terminal cleanup idempotent. A stop or disposal path should
settle provider work, unsubscribe listeners, and release every resource it
owns before reporting its terminal snapshot. Exercise custom adapters with
`runVoiceSessionAdapterConformance` from
`@kontourai/station-sdk/testing`; provider-specific fixtures should drive the
observable lifecycle states without weakening the shared contract.

This SDK contract does not redesign Voice transport topology. In particular,
dedicated Voice ports, REST-created IDs, WebSocket-created session identities,
reverse-proxy exposure, and authentication topology remain
host responsibilities recorded in archive#243; this interface does not establish
provider credentials, network exposure or a successful live voice session.

## Hooks

Call hooks inside React components under Station's `SDKProvider`. The
[host adapter](../../src-ui/src/core/SDKAdapter.tsx) supplies their contexts;
these hooks do not create a standalone Station runtime.

### Agent Management

```tsx
import { useAgents, useAgent } from '@kontourai/station-sdk';

const agents = useAgents();
const agent = useAgent('my-agent');
```

### Chat Operations

```tsx
import { useSendMessage, useCreateChatSession } from '@kontourai/station-sdk';

function StartAgentChat() {
  const sendMessage = useSendMessage();
  const createSession = useCreateChatSession();
  return (
    <button type="button" onClick={async () => {
      const dockSessionId = createSession('my-agent', 'My Agent');
      await sendMessage(dockSessionId, 'my-agent', undefined, 'Hello, agent!');
    }}>
      Start chat
    </button>
  );
}
```

Use an available Agent slug in place of `my-agent`. The host callback also
accepts an existing conversation ID in the third send
argument. A Dock entry ID is not proof that the server created a durable Session,
and a send may be queued or refused. Read server-returned identities for APIs
that require a durable Session ID.

### Navigation

```tsx
import { useNavigation, useDockState } from '@kontourai/station-sdk';

const { setDockState } = useNavigation();
const { isOpen: isDockOpen } = useDockState();

// Open chat dock
setDockState(true);
```

### Notifications

```tsx
import { useToast, useNotifications } from '@kontourai/station-sdk';

const { showToast } = useToast();
const { notify } = useNotifications();

showToast('Success!', 'success');
notify('You have a new message', { type: 'info' });
```

`notify` is an immediate toast. Use the hook's separate `schedule` method for a
server notification; neither call is proof of native or browser push delivery.

### Tool Invocation

```tsx
import { callTool, invokeAgent } from '@kontourai/station-sdk';

// Call an MCP tool directly
const result = await callTool('my-agent', 'tool-name', { param: 'value' });

// Invoke the Agent directly, without creating a Dock entry.
const response = await invokeAgent('my-agent', 'Do something');
```

These calls can execute tools or provider work. In particular, an indeterminate
invocation error means the provider may already have started; do not retry it
automatically. Runtime permissions and the selected Agent/engine still apply.

## Layout Navigation

This hook also requires the host's `LayoutNavigationProvider`.

```tsx
import { useLayoutNavigation } from '@kontourai/station-sdk';

const { getTabState, setTabState } = useLayoutNavigation();

// Save state
setTabState('my-tab', 'key=value&other=data');

// Restore state
const state = getTabState('my-tab');
```

## Theme Variables

Components consume host CSS variables. Common tokens include:

- `--color-primary` - Primary brand color
- `--success-text` - Success state color
- `--warning-text` - Warning state color
- `--color-error` - Error state color
- `--color-bg` - Background color
- `--color-bg-secondary` - Secondary background
- `--color-text` - Primary text color
- `--color-text-secondary` - Secondary text color
- `--color-border` - Border color

Station's theme supplies light/dark values. An independent host must provide
the applicable variables and component styles; importing a component does not
install Station's theme.

## Related packages

- [`@kontourai/station-shared`](https://www.npmjs.com/package/@kontourai/station-shared)
  — `buildPlugin`, manifest parsing, and the other runtime helpers.
- [`@kontourai/station-contracts`](https://www.npmjs.com/package/@kontourai/station-contracts)
  — the TypeScript contracts both packages are typed against.

## License

Apache-2.0 — see [LICENSE](./LICENSE).


The source-only additive `engine-accounts` entry provides authority-partitioned
account, quota, sign-in and engine-activity hooks. See the
[engine account query contract](../../docs/reference/sdk.md#engine-account-queries)
and use a package release that contains these exports.
