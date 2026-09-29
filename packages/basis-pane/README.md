# Station Basis Pane

First-party Station Workspace Pane over SDK and Surface view contracts. Its
descriptor declares no extra execution capability; protected reads and host
actions still require current authority.

## Package and host boundary

The [manifest](./package.json) marks this as a **private workspace package**.
Its export map points at TypeScript/TSX source; `publishConfig.access` does not
override `private: true` or prove a public release. `npm run build --prefix
packages/basis-pane` compiles locally, while consumers continue to use the
source export map through Station's bundler.

The root exports `StationBasisPane`, `AnswerBasisAffordance` and the built-in Pane
descriptor/instance helpers. Opt-in subpaths expose collection views, Session
inventory, and the portable MCP App resources. The
[connected host](../../src-ui/src/workspace-panes/ConnectedStationBasisPane.tsx)
captures request authority and supplies execution-action slots; Surface owns
answer presentation semantics. No plugin installation or new permission grant
is implied by importing the package.

## Whole Task composition

`@kontourai/station-basis-pane/task-basis-collection-view` exposes the pure
`buildStationTaskBasisCollectionView` function. Callers explicitly supply either
an authorized full Station collection or a bounded Station page. Built-in Whole
Task browsing retains the full collection; portable delivery can use pages.

Station owns collection order, exact answer selection, availability messages,
and unassociated kept items. Each answer's panel comes from Surface's
`buildBasisPanelViewModel`: Station does not combine standing, reinterpret
evidence, or promote surrounding context into support. Whole Task has no
aggregate standing. Invalid envelopes are unavailable, not empty collections.

The `@kontourai/station-contracts/task-basis-mcp` page builder only slices an
already-authorized in-memory collection. Its offsets are neither an access
grant nor a stable cursor over changing data. Protected continuation calls,
reauthorization, and stale-collection handling belong to the host, not this
view module. The page contract alone does not enable network pagination.

## Portable Whole Task MCP App

`@kontourai/station-basis-pane/task-basis-mcp-app` declares the read-only
`station-control/get_task_basis` App at `ui://station/basis/task/v3`. It is
web-only; native shells retain the built-in React pane. The host alone issues its narrow
continuation capability, bound to the exact Task, caller, and read authority.

The portable App iframe does not fetch protected Basis data directly. It
receives host-mediated results and supplies Surface's public Basis element with
the selected projection. Station owns collection chrome and selection; Surface
owns answer semantics. This does not describe the built-in pane's SDK queries.

## Portable Session inventory MCP App

`session-inventory-mcp-app` exposes the v1 and v2 resource URIs and renders
already-authorized inventory envelopes. A current-answer envelope may include
its captured Basis projection. The [App client](./src/session-inventory-mcp-app.browser.ts)
has group/density controls, host-mediated `openLink` navigation, and a Load more
action that calls `get_session_inventory` through `app.callServerTool` with the
supplied occurrence and continuation token. It does not issue an independent
protected HTTP fetch or synthesize live execution state.

The host owns continuation authority and its expiry/revocation. A successful
page merges previously unseen rows into the selected group, rejecting a changed
row with an existing key; the other groups stay in the retained projection.
Malformed or failed continuation clears the current projection to generic
unavailable. See the
[server tool owner](../../src-server/tools/station-control-session-inventory-tools.ts)
for currentness and authorization; the view alone cannot establish them.

## Exact execution actions

The built-in pane supplies published Surface result refs to its typed
`renderExecutionActions` host slot. Station's connected host implements safe
inspection and identity-only Keep in Task; inspection itself never writes.
Whole Task v4 collections retain separate bounded kept-result and Flow gate
evaluation streams, even
when no answer is available. Result activity never changes answer support.

Hosts capture a non-secret request scope before invoking protected reads or
mutations. Connection activation and native authorization epochs partition
queries and reject late responses; native receipts are attached only to scoped
requests. No raw credentials belong in cache keys or pane props.
