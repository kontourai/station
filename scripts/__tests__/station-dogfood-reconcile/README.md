# Dogfood reconcile test architecture

The six `station-dogfood-reconcile*.test.ts` files remain the physical Vitest
shards. `station-dogfood-reconcile.shared.ts` is their lazy dispatcher: a
focused shard imports only its behavior modules.

Behavior files own scenarios by contract rather than by shared setup:

- promotion policy and failure handling
- legacy adoption, its real CLI boundary, and adoption authority
- runtime recovery and supervision
- installer transactions and static/LaunchAgent rollback
- lifecycle locking
- the cutover matrix

`fixture.ts` is the only shared test capability layer. Keep filesystem cleanup,
command recording/stubs, state readers, and fixed identities there. Prefer a
small behavior-local helper when an abstraction is not shared across contracts;
do not turn the harness into a generic reconciliation DSL.

`scenario-names.json` is the parity ratchet captured before this split. The
`dogfood-reconcile-scenario-parity.test.ts` test compares the sorted full-name
multiset, including physical shard paths and intentional duplicate parameterized
names. Update it only when a scenario rename, addition, removal, or shard move is
intentional and reviewed.
