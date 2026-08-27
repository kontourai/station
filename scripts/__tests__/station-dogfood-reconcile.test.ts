// Keep the historical path as the core physical shard so focused commands and
// editor integrations continue to resolve a stable reconcile-suite entrypoint.
const shard = 'core-promotion-adoption';
const { registerStationDogfoodReconcileShard } = await import(
  './station-dogfood-reconcile.shared'
);

await registerStationDogfoodReconcileShard(shard);
