const shard = 'recovery-locking';
const { registerStationDogfoodReconcileShard } = await import(
  './station-dogfood-reconcile.shared'
);

await registerStationDogfoodReconcileShard(shard);
