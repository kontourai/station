const RECONCILE_SHARDS = [
  'core-promotion-adoption',
  'recovery-locking',
  'installer-static-launchd-rollback',
  'cutover-matrix-0',
  'cutover-matrix-1',
  'cutover-matrix-2',
] as const;

type ReconcileShard = (typeof RECONCILE_SHARDS)[number];

const shardRegistrars: Record<ReconcileShard, () => Promise<void>> = {
  'core-promotion-adoption': async () => {
    const [
      { registerPromotionPolicy },
      { registerLegacyAdoption },
      { registerLegacyAdoptionBoundary },
      { registerLegacyAdoptionAuthority },
    ] = await Promise.all([
      import('./station-dogfood-reconcile/promotion-policy.behavior.js'),
      import('./station-dogfood-reconcile/legacy-adoption.behavior.js'),
      import(
        './station-dogfood-reconcile/legacy-adoption-boundary.behavior.js'
      ),
      import(
        './station-dogfood-reconcile/legacy-adoption-authority.behavior.js'
      ),
    ]);
    registerPromotionPolicy();
    registerLegacyAdoption();
    registerLegacyAdoptionBoundary();
    registerLegacyAdoptionAuthority();
  },
  'recovery-locking': async () => {
    const [
      { registerPromotionFailures },
      { registerRuntimeRecovery },
      { registerInstallerTransactions },
      { registerLocking },
      { registerRecoverySupervision },
    ] = await Promise.all([
      import('./station-dogfood-reconcile/promotion-failure.behavior.js'),
      import('./station-dogfood-reconcile/runtime-recovery.behavior.js'),
      import('./station-dogfood-reconcile/installer-transaction.behavior.js'),
      import('./station-dogfood-reconcile/locking.behavior.js'),
      import('./station-dogfood-reconcile/recovery-supervision.behavior.js'),
    ]);
    registerPromotionFailures();
    registerRuntimeRecovery();
    registerInstallerTransactions();
    registerLocking();
    registerRecoverySupervision();
  },
  'installer-static-launchd-rollback': async () => {
    const { registerInstallerStaticAndLaunchdRollback } = await import(
      './station-dogfood-reconcile/installer-static-launchd-rollback.behavior.js'
    );
    registerInstallerStaticAndLaunchdRollback();
  },
  'cutover-matrix-0': async () => {
    const { registerCutoverMatrix } = await import(
      './station-dogfood-reconcile/cutover-matrix.behavior.js'
    );
    registerCutoverMatrix(0);
  },
  'cutover-matrix-1': async () => {
    const { registerCutoverMatrix } = await import(
      './station-dogfood-reconcile/cutover-matrix.behavior.js'
    );
    registerCutoverMatrix(1);
  },
  'cutover-matrix-2': async () => {
    const { registerCutoverMatrix } = await import(
      './station-dogfood-reconcile/cutover-matrix.behavior.js'
    );
    registerCutoverMatrix(2);
  },
};

export async function registerStationDogfoodReconcileShard(shard: string) {
  const register = shardRegistrars[shard as ReconcileShard];
  if (!register) {
    throw new Error(
      `unknown station dogfood reconcile shard: ${shard}. Expected one of: ${RECONCILE_SHARDS.join(', ')}`,
    );
  }

  await register();
}
