const shard = 'cutover-matrix-1';
const { registerStationDogfoodReconcileShard } = await import(
  './station-dogfood-reconcile.shared'
);

await registerStationDogfoodReconcileShard(shard);
