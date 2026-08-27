const shard = 'cutover-matrix-2';
const { registerStationDogfoodReconcileShard } = await import(
  './station-dogfood-reconcile.shared'
);

await registerStationDogfoodReconcileShard(shard);
