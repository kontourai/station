import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

test.each([
  { kind: 'object', late: false },
  { kind: 'function', late: false },
  { kind: 'object', late: true },
  { kind: 'function', late: true },
])(
  'an ambiguous $kind return retains actual raw value and lease (late=$late)',
  ({ kind, late }) => {
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
    let weakResource, weakLease, finishStage, invocations = 0;
    const scope = { kind: 'project', projectId: 'opaque' };
    const module = createPluginCompositionModule({ disposerTimeoutMs: 5, authorizer: { authorize(input) {
      const lease = { bindings: input.contributions.map(c => ({
        instanceIdentity: c.instanceIdentity, pluginId: c.contribution.pluginId,
        contributionId: c.contribution.contributionId, implementationId: c.contribution.implementationId,
        installationGeneration: 'install:1', factory: { async stage() {
          const raw = ${JSON.stringify(kind)} === 'function' ? function opaque() { invocations++; } : {};
          weakResource = new WeakRef(raw);
          if (${late}) await new Promise(resolve => { finishStage = resolve; });
          return raw;
        } },
      })), isCurrent: () => true, release() {} };
      weakLease = new WeakRef(lease); return { kind: 'granted', lease };
    } } });
    await module.apply({ profileId: 'profile', scope, contributions: [{
      instanceId: 'cache', pluginId: 'plugin', contributionId: 'cache', implementationId: 'cache',
      capability: 'workspace.cache', version: '1', configuration: {}, isolation: 'profile', requires: [],
    }] });
    if (${late}) { finishStage(); await new Promise(resolve => setImmediate(resolve)); }
    await module.retire(scope);
    for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
    console.log(JSON.stringify({ rawRetained: weakResource.deref() !== undefined,
      leaseRetained: weakLease.deref() !== undefined, invocations,
      retirement: (await module.retire(scope)).kind }));
  `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    expect(JSON.parse(output)).toEqual({
      rawRetained: true,
      leaseRetained: true,
      invocations: 0,
      retirement: 'pending',
    });
  },
);

test('a distinct shared-disposer conflict retains the actual resource and authorization capability', () => {
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
      let weakHandle;
      let weakLease;
      let disposals = 0;
      function sharedDispose() { disposals++; }
      const module = createPluginCompositionModule({
        disposerTimeoutMs: 5,
        authorizer: { authorize(input) {
          const second = input.scope.projectId === 'b';
          const lease = {
            bindings: input.contributions.map(c => ({
              instanceIdentity: c.instanceIdentity, pluginId: c.contribution.pluginId,
              contributionId: c.contribution.contributionId, implementationId: c.contribution.implementationId,
              installationGeneration: 'install:1', factory: { async stage() {
                const handle = { dispose: sharedDispose };
                if (second) weakHandle = new WeakRef(handle);
                return handle;
              } },
            })), isCurrent: () => true, release() {},
          };
          if (second) weakLease = new WeakRef(lease);
          return { kind: 'granted', lease };
        } },
      });
      for (const projectId of ['a', 'b']) await module.apply({
        profileId: 'profile', scope: { kind: 'project', projectId }, contributions: [{
          instanceId: 'cache', pluginId: 'plugin', contributionId: 'cache', implementationId: 'cache',
          capability: 'workspace.cache', version: '1', configuration: {}, isolation: 'profile', requires: [],
        }],
      });
      await module.retire({ kind: 'project', projectId: 'b' });
      for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
      console.log(JSON.stringify({
        actualResourceRetained: weakHandle.deref() !== undefined,
        actualLeaseRetained: weakLease.deref() !== undefined,
        activeOwner: module.inspect({ kind: 'project', projectId: 'a' }).active.length,
        retirement: (await module.retire({ kind: 'project', projectId: 'b' })).kind,
        disposals,
      }));
    `,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  expect(JSON.parse(output)).toEqual({
    actualResourceRetained: true,
    actualLeaseRetained: true,
    activeOwner: 1,
    retirement: 'pending',
    disposals: 0,
  });
});

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
