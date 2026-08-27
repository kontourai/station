const shard = 'installer-static-launchd-rollback';
const { registerStationDogfoodReconcileShard } = await import(
  './station-dogfood-reconcile.shared'
);

await registerStationDogfoodReconcileShard(shard);
