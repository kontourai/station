# Frontend patterns

These are contributor conventions and routes to current owners, not a claim
that every existing component follows one architecture. When a new pattern is
needed, verify its real callers and document it with its owner and evidence;
do not promote a one-off workaround into a repository-wide rule. Read the
[UI instructions](../../src-ui/AGENTS.md), [module map](../architecture/module-map.md)
and [SDK reference](../reference/sdk.md) before changing a shared boundary.

## Data ownership and layers

Prefer four responsibilities for ordinary remote-data views:

| Responsibility | Owner | What belongs there |
| --- | --- | --- |
| Request and query definition | SDK client/domain or query factory | Validated request/response, cache identity, refresh and cancellation contract |
| React query or mutation hook | SDK query domain | Reuse the request, expose loading/error/data or mutation state |
| Feature view model | Owning feature or plugin | Combine reads, derive display state and coordinate user actions |
| View | Component | Render those states and forward user intent |

This is a separation of responsibilities, not a requirement to create four
files for a simple feature. Streaming, local device settings, navigation,
editable drafts and command queues have their own state owners. For example,
`useLiveSurface` owns a stream and coalesced input rather than pretending frames
are a React Query result; the [module map](../architecture/module-map.md#shared-live-surface)
explains that exception.

Current SDK organization is split: `queryFactories.ts` contains shared query
configurations, `queries.ts` is largely an export surface,
`query-domains/` owns feature hooks, `client/` owns transport-facing operations,
and `query-core.ts` supplies common React Query policy. Context hooks in
`hooks.ts` consume host-provided values; they are not interchangeable with a
remote query. Plugin view models remain in the plugin, not in the public SDK.

## Reuse the query and transport owners

When a hook and an imperative action need the same read, use the same query
factory rather than copying its key or fetch implementation. Existing callers
include [the Agent query hooks](../../packages/sdk/src/query-domains/agentAdmin.ts)
and [the tools action](../../src-ui/src/slashCommands/tools.ts), which use
[agentQueries](../../packages/sdk/src/queryFactories.ts).

```ts
import { agentQueries } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';

export function useReadAgentTools() {
  const queryClient = useQueryClient();
  return (agentSlug: string) =>
    queryClient.fetchQuery(agentQueries.tools(agentSlug));
}
```

This example requires the host's configured SDK and QueryClient providers.
A returned cached value is not necessarily a new server observation. Choose
freshness deliberately; do not treat `fetchQuery`, a matching key or successful
render as proof that access was rechecked.

For an ordinary component read, prefer the public hook:

```tsx
import { useAgentQuery } from '@kontourai/station-sdk';

export function AgentName({ agentSlug }: { agentSlug: string }) {
  const query = useAgentQuery(agentSlug);
  if (query.isPending) return <p>Loading agent…</p>;
  if (query.isError) return <p role="alert">The agent could not be loaded.</p>;
  return <p>{query.data?.name}</p>;
}
```

Use the existing SDK request owner for new reads and mutations. Its
[authenticated transport](../../packages/sdk/src/client/http.ts) handles the
selected connection's credential/transport policy. A direct `fetch` copy can
lose that authority, timeout and failure behavior. Plugins consume public SDK
exports, never `src-ui` contexts or `src-server` services.

The UI clears the origin's previous header acceptance when a handshake starts.
Only the latest-started handshake at that origin may restore acceptance. Its
non-OK response, invalid JSON or transport failure leaves acceptance cleared;
an older overlapping success cannot restore cross-origin carriage.

The SDK also owns the client API protocol declaration. Cross-origin browser
requests carry `X-Station-Client-Protocol` only after a public handshake
advertises `compatibility.capabilities.clientProtocolHeader >= 1`; same-origin
and host-owned transports do not need that preflight negotiation. Use the
[shared policy](../../packages/shared/src/client-protocol.ts) for a necessary
non-SDK caller instead of unconditionally adding a custom header that older
hosts cannot preflight. A host's `426 client_protocol_unsupported` is a
compatibility refusal, not a missing credential. The
[Connect reference](../reference/connect.md) records the remaining caller gaps.

Do not run an effectful Agent/tool invocation merely because a query mounted
or refetched. Use the owning mutation/action contract and explicit user intent.
A successful HTTP acknowledgment, recorded run or cache invalidation does not
prove a provider completed an external effect. The
[Session API](../reference/session-api.md) owns foreground execution receipts;
[commands](../guides/commands.md) owns slash-command expansion and dispatch.

## Cache, freshness and failure

[query-core.ts](../../packages/sdk/src/query-core.ts) provides defaults, but
individual hooks can override them or use React Query directly. Its ordinary
`useApiQuery` default is five minutes stale time and ten minutes garbage
collection, with a registered per-key GC default taking precedence. Persisted
query families have a longer retention floor. These numbers are not universal
freshness promises.

For data changed elsewhere, follow its actual invalidation, event, polling or
explicit refresh owner. Station's cache-first defaults do not imply an automatic
refresh on focus/remount; a hook opts one read back in with
`refetchOnWindowFocus`. `keepPreviousData` is opt-in: callers must distinguish
placeholder content from the answer for the new key. Preserve loading, empty,
unavailable and error as different states.

Protected data also needs the current request authority and cache partition.
Use existing `ApiRequestScope`/authority-key owners for that family; credentials
must never become query keys. Review both the cache result and the waiting
caller when cancellation, Station switching or access changes race a request.
An ignored rejection is not evidence that stale private content cannot return.
For Station's host integration, follow
[authorityNamespace](../../src-ui/src/lib/authorityNamespace.ts) and
[query persistence](../../src-ui/src/lib/queryPersistence.ts); do not invent a
plugin-owned substitute for those boundaries.

## View models and components

Keep domain derivation near its feature. A useful view model combines named
reads and actions, returns explicit pending/error/ready states, and avoids JSX.
Views render those states and invoke actions. Avoid an extra abstraction that
only renames every query field, and avoid forcing domain-specific behavior into
the SDK because two components happen to render it.

The existing size convention uses 300 lines as a review point, 300–500 as a
reason to consider extraction, and over 500 as a requirement to extract coherent
responsibilities. Line count is not a correctness test or permission to create
thin pass-through hooks. Extract a real interface: a query/command owner, a
state machine, or an independently useful component. Keep loading and failure
behavior visible after the split. Lazy UI must use the owning pending/error
boundary rather than disappearing while a chunk loads.

Navigation and editable drafts have dedicated owners. Project layout changes
flow through canonical navigation/layout actions. A feature with unsaved state
registers `useUnsavedGuard`; ordinary `navigate` already enters that guard, so
wrapping the same navigation again produces duplicate prompts. Local actions
that do not navigate may use the guard explicitly. See
[UI instructions](../../src-ui/AGENTS.md) and the relevant owner tests.

## Styling and responsive behavior

Use Kontour UI's semantic `--k-*` tokens for new styles, following the
[shared design rules](https://github.com/kontourai/ui/blob/main/DESIGN.md):

```css
.feature-card {
  background: var(--k-bg);
  color: var(--k-text);
  border: 1px solid var(--k-line);
}
```

The [theming guide](../guides/theming.md) explains the existing Station aliases
and their cascade. Keep decisions marked OPEN in the shared design rules
unresolved. Static layout and
visual styling belong in CSS classes. Dynamic geometry and CSS custom-property
values can legitimately use `style`; `ResponsiveDialogSurface` is an existing
example. Do not ban its measured viewport/anchor values or replace them with
hardcoded offsets to satisfy a blanket “no inline styles” slogan.

Use Station's `Button` and `Dialog` for standard actions/chrome, and the public
package primitives where that surface already adopts them. A custom
`ResponsiveDialogSurface` needs its own visual styles. Follow the
[responsive guide](../guides/responsive-ui.md) for layers, safe areas, focus,
viewport geometry, touch targets and inventory requirements. Structural tests
and tokens do not prove computed contrast or phone interaction across the app.

## Package boundaries

| Need | Public boundary |
| --- | --- |
| Stable Agent, Project, Pane, tool or notification shape | `@kontourai/station-contracts/*` |
| Station requests, query hooks and host context hooks | `@kontourai/station-sdk` or its declared subpath |
| Connection/pairing/discovery host integration | `@kontourai/station-connect` inside Station's owning integration |
| Config parsers, build or Git helpers | Explicit `@kontourai/station-shared/parsers`, `/build`, `/git` subpaths, in the appropriate runtime |
| Shared visual tokens/primitives | Kontour UI's public package exports |

`packages/connect` owns saved Station connections, pairing, discovery and
transport lifecycle; SDK requests consume the selected connection. A reachability
candidate is not a trust grant. Connect is private in this checkout; use its
owning Station integration rather than assuming current publication as a plugin
dependency. Its [README](../../packages/connect/README.md) and
[reference](../reference/connect.md) own supported host setup and hook shapes;
copying an old provider snippet without its current credential/storage setup is
not a complete integration.

`packages/contracts` owns canonical cross-package types. Shared runtime helpers
use explicit subpaths; do not import helpers from the bare shared root or assume
every Node parser/build helper is browser-safe. Never copy server-only plugin
permission logic into an extension. See [plugin authoring](../guides/plugins.md)
for supported build/install/approval workflows; removing and reinstalling a
plugin is not a generic hot-reload instruction.

## Logging and verification

Station UI's [logger](../../src-ui/src/utils/logger.ts) exposes namespaced
`log.context`, `log.api`, `log.chat`, `log.workflow`, `log.plugin` and `log.auth`
functions backed by `debug`. `localStorage.debug = 'app:*'` enables those names;
development enables them by default when no selection is saved. Do not use
production `console.log` or log credentials, full private messages or arbitrary
API payloads. Plugins must not import this private UI module.

Before changing code, run `npm run gate:for -- <paths>`. Run the selected
existing tests through `npm run test:focused -- <files>` and the appropriate
typecheck lane when types change. A hook fixture proves its declared seams;
real layout, keyboard behavior, native transport and provider effects require
their own caller evidence. Add a new test only when it reaches a meaningful
failure the existing owner suite does not cover.
