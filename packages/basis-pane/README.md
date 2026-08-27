# Station Basis Pane

First-party, capability-free Station Workspace Pane over published SDK and Surface view contracts.

## Whole Task composition

`@kontourai/station-basis-pane/task-basis-collection-view` exposes the pure
`buildStationTaskBasisCollectionView` function. Callers explicitly supply either
an authorized full Station collection or a bounded Station page. Native Whole
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
web-only; native shells retain the native pane. The host alone issues its narrow
continuation capability, bound to the exact Task, caller, and read authority.
Opaque occurrence/token metadata expires, rotates, and revokes on teardown;
pages replace each other rather than accumulating protected state. Generic
unavailable covers stale, revoked, malformed, and failed reads.

The browser never fetches protected Basis data. It receives host-mediated
results and sets the selected raw projection on Surface's public Basis element.
Station owns collection chrome and selection; Surface owns every answer's
semantics. Whole Task has no aggregate standing.

## Exact execution actions

The native pane supplies published Surface result refs to its typed
`renderExecutionActions` host slot. Station's connected host implements safe
inspection and identity-only Keep in Task; inspection itself never writes.
Whole Task v4 collections retain separate bounded kept-result and Flow gate
evaluation streams, even
when no answer is available. Result activity never changes answer support.

Hosts capture a non-secret request scope before invoking protected reads or
mutations. Connection activation and native authorization epochs partition
queries and reject late responses; native receipts are attached only to scoped
requests. No raw credentials belong in cache keys or pane props.
