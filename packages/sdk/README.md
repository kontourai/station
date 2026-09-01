# @kontourai/station-sdk

Station is Kontour's local-first agent workspace: you direct agent work, and the
gate verdicts, evidence, and trust state stay in the same context as the work.
Plugins are how the workspace is extended — a plugin contributes layouts,
agents, MCP integrations, providers, and knowledge namespaces to the Station
shell.

This package is the client-side SDK those plugins build against: theme-aware UI
components, React hooks for agents, chat, navigation and notifications, and
typed access to the Station host API.

Trusted server modules may also import the re-exported
`PluginOperationalEventObserver` and
`PluginOperationalEventSubscriptionEntry` types for durable, capability-scoped
event observation. The host retains consumer identity, grants, projection, and
settlement authority; see the plugin guide's durable operational-event section.

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
`TaskToolResultRequestError` keeps only a generic message and response status;
it does not expose a protected URL or an upstream error body.

These APIs do not change semantic answer standing or automatically promote an
Output. The native Basis item actions are a separate integration step.

## Workspace Pane authoring

Import `@kontourai/station-sdk/workspace-pane` for the opt-in portable Pane
contract. The [Workspace Pane authoring guide](../../docs/guides/workspace-pane-authoring.md)
covers descriptor identity, capabilities, placement, actions, alternatives,
provenance/version/lifecycle, and `npm run workspace-pane:conformance`.

## Requires a bundler (ships TypeScript source)

This package publishes **raw TypeScript**. Every entry in `exports` points at a
`.ts` file under `src/`; there is no compiled `dist/`. That is deliberate — the
supported consumer is a Station plugin, whose `npm run build` calls
`buildPlugin()` from `@kontourai/station-shared/build` and bundles the plugin
with esbuild, which reads `.ts` from `node_modules` directly.

- **Supported:** esbuild, Vite, webpack, Rollup, or any TS-aware loader/runtime
  (`tsx`, `ts-node`, Bun, Deno).
- **Not supported today:** plain-Node `require()` / `import` of this package
  without a TS-aware step.

This is a disclosed constraint, not an accident. If you need a precompiled
build for a non-bundled runtime, open an issue.

## Start from npm

A plugin needs nothing but npm and these two packages — no Station checkout.

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

Then build it:

```bash
npm run build   # production bundle at dist/bundle.js
npm run dev     # dev bundle with inline sourcemaps
```

React, `@tanstack/react-query`, and this SDK are supplied by the Station host at
runtime, so `buildPlugin` externalizes them instead of bundling them.

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

Install it with the CLI, which previews the source, prints what installing it
would require, and asks before anything is written:

```bash
station_checkout=/absolute/path/to/station
"$station_checkout/station" plugin install "$PWD"
```

The CLI uses the selected saved Station and its OS-keyring credential. Over raw
HTTP it is two calls, in this order: `POST /api/plugins/preview` reports what
installing would require from a copy it stages and throws away, and `POST
/api/plugins/install` carries that answer back as `consent` — the preview's
`permissions.required`, its `contentDigest`, and the ids in its `dependencies`.
An install with no `consent` is refused with a 400 before anything is staged
(station#4288), so the preview is not optional. The server re-derives all three
from its own staged copy and refuses, without writing anything, when they
disagree. What that establishes is sequence and binding for a client that shows
a person the preview; a script that echoes the values back unread satisfies the
check without anyone having decided anything.

Station copies the plugin to `<STATION_HOME>/plugins/<name>/`, rebuilds it, and
registers its layout; the layout is then available to add to a project. Active
permissions named in the approval are recorded against the installed tree.
Trusted ones come back as `pendingConsent`: they are decided on a separate,
host-owned review page, which a same-origin click cannot substitute for.

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

An adapter exposes an immutable `VoiceSessionSnapshot`. Its `revision` always
increases for that adapter or manager projection; subscribers must treat every
snapshot as a replacement rather than mutating it. The normalized lifecycle
states are `disconnected`, `connecting`, `connected-idle`, `listening`,
`transcribing`, `thinking`, `speaking`, `stopping`, and `error`.

Snapshots may additionally carry read-only presentation values when the
underlying provider has them: `transcript`, `transcriptRole` (`user` or
`assistant`), `muted`, and `inputAudioLevel` (normalized from 0 through 1).
They are optional so adapters that cannot observe a value remain compatible.

### Independent STT and TTS plugins

Existing plugins do not need to change their providers or registry calls.
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
reverse-proxy exposure, and authentication topology remain the explicit
non-goals owned by Station issue #243.

## Hooks

### Agent Management

```tsx
import { useAgents, useAgent } from '@kontourai/station-sdk';

const agents = useAgents();
const agent = useAgent('my-agent');
```

### Chat Operations

```tsx
import { useSendMessage, useCreateChatSession } from '@kontourai/station-sdk';

const sendMessage = useSendMessage();
const createSession = useCreateChatSession();

// Send a message
sendMessage('Hello, agent!');

// Create a new chat session
createSession('my-agent');
```

### Navigation

```tsx
import { useNavigation, useDockState } from '@kontourai/station-sdk';

const { setDockState } = useNavigation();
const [isDockOpen] = useDockState();

// Open chat dock
setDockState(true);
```

### Notifications

```tsx
import { useToast, useNotifications } from '@kontourai/station-sdk';

const { showToast } = useToast();
const { notify } = useNotifications();

showToast('Success!', 'success');
notify({ title: 'New message', message: 'You have a new message' });
```

### Tool Invocation

```tsx
import { callTool, invokeAgent } from '@kontourai/station-sdk';

// Call an MCP tool directly
const result = await callTool('my-agent', 'tool-name', { param: 'value' });

// Invoke agent silently
const response = await invokeAgent('my-agent', 'Do something');
```

## Layout Navigation

```tsx
import { useLayoutNavigation } from '@kontourai/station-sdk';

const { getTabState, setTabState } = useLayoutNavigation();

// Save state
setTabState('my-tab', 'key=value&other=data');

// Restore state
const state = getTabState('my-tab');
```

## Theme Variables

All components use CSS variables for theming:

- `--color-primary` - Primary brand color
- `--success-text` - Success state color
- `--warning-text` - Warning state color
- `--color-error` - Error state color
- `--color-bg` - Background color
- `--color-bg-secondary` - Secondary background
- `--color-text` - Primary text color
- `--color-text-secondary` - Secondary text color
- `--color-border` - Border color

Components automatically adapt to light/dark mode.

## Related packages

- [`@kontourai/station-shared`](https://www.npmjs.com/package/@kontourai/station-shared)
  — `buildPlugin`, manifest parsing, and the other runtime helpers.
- [`@kontourai/station-contracts`](https://www.npmjs.com/package/@kontourai/station-contracts)
  — the TypeScript contracts both packages are typed against.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
