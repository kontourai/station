import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('failed rollback retains the actual authorization lease, not only its diagnostic fence', () => {
  // A private child exposes GC without changing the Vitest worker's runtime.
  // The assertion is reachability after forced collection, not elapsed time.
  const subject = new URL('../plugin-composition.ts', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--expose-gc',
      '--import=tsx',
      '--input-type=module',
      '-e',
      `
      import { createPluginCompositionModule } from ${JSON.stringify(subject)};
      let weak;
      const scope = { kind: 'project', projectId: 'retained' };
      const module = createPluginCompositionModule({
        disposerTimeoutMs: 5,
        authorizer: {
          authorize(input) {
            const lease = {
              bindings: input.contributions.map(c => ({
                instanceIdentity: c.instanceIdentity,
                pluginId: c.contribution.pluginId,
                contributionId: c.contribution.contributionId,
                implementationId: c.contribution.implementationId,
                installationGeneration: 'install:1',
                factory: {
                  async stage() {
                    if (c.contribution.instanceId === 'b') throw Error('stage failed');
                    return { async dispose() { throw Error('dispose failed'); } };
                  },
                },
              })),
              isCurrent: () => true,
              release() {},
            };
            weak = new WeakRef(lease);
            return { kind: 'granted', lease };
          },
        },
      });
      await module.apply({
        profileId: 'profile', scope,
        contributions: ['a', 'b'].map(id => ({
          instanceId: id, pluginId: 'plugin', contributionId: id,
          implementationId: id, capability: 'workspace.' + id, version: '1',
          configuration: {}, isolation: 'profile', requires: [],
        })),
      });
      await module.retire(scope);
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      console.log(JSON.stringify({
        actualLeaseRetained: weak.deref() !== undefined,
        retirement: (await module.retire(scope)).kind,
      }));
    `,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  expect(JSON.parse(output)).toEqual({
    actualLeaseRetained: true,
    retirement: 'pending',
  });
});
