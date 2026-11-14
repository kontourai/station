import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  type BuiltinAgentEngineBinding,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { recordAdoptedBuiltinEngine } from '../builtin-engine-adoption.js';

const makeTempDir = trackTempDirs();
const loaders: ConfigLoader[] = [];
afterEach(async () => {
  for (const loader of loaders.splice(0)) await loader.dispose();
});
async function fixture() {
  const home = makeTempDir('builtin-adoption-');
  const loader = new ConfigLoader({
    projectHomeDir: home,
    enforceHomeSchema: true,
  });
  loaders.push(loader);
  await loader.ensureHomeSchema();
  await loader.loadAppConfig();
  return { loader, home, file: join(home, 'config', 'app.json') };
}
const binding: BuiltinAgentEngineBinding = {
  connectionId: engineConnectionId('opencode'),
  matrix: resolveEngineCapabilityMatrix('opencode', { engineId: 'opencode' }),
};

test('records an undecided home once through the real config owner', async () => {
  const f = await fixture();
  await recordAdoptedBuiltinEngine({
    configLoader: f.loader,
    explicitConnectionId: undefined,
    binding,
  });
  expect((await f.loader.loadAppConfig()).builtinAgentEngineConnectionId).toBe(
    'opencode',
  );
  const bytes = readFileSync(f.file);
  await recordAdoptedBuiltinEngine({
    configLoader: f.loader,
    explicitConnectionId: undefined,
    binding,
  });
  expect(readFileSync(f.file)).toEqual(bytes);
});

test.each([engineConnectionId('claude'), null])(
  'preserves authored choice %s even when readiness captured absence',
  async (choice) => {
    const f = await fixture();
    const observed = (await f.loader.loadAppConfig())
      .builtinAgentEngineConnectionId;
    expect(observed).toBeUndefined();
    // The choice commits after the readiness snapshot, before adoption's locked mutation.
    await f.loader.updateAppConfig({ builtinAgentEngineConnectionId: choice });
    const bytes = readFileSync(f.file);
    await recordAdoptedBuiltinEngine({
      configLoader: f.loader,
      explicitConnectionId: observed,
      binding,
    });
    expect(
      (await f.loader.loadAppConfig()).builtinAgentEngineConnectionId,
    ).toBe(choice);
    expect(readFileSync(f.file)).toEqual(bytes);
  },
);

test.each([engineConnectionId('claude'), null])(
  'does not attempt adoption for captured explicit choice %s',
  async (choice) => {
    const f = await fixture();
    await f.loader.updateAppConfig({ builtinAgentEngineConnectionId: choice });
    const mutation = vi.spyOn(f.loader, 'mutateAppConfig');
    await recordAdoptedBuiltinEngine({
      configLoader: f.loader,
      explicitConnectionId: choice,
      binding,
    });
    expect(mutation).not.toHaveBeenCalled();
  },
);

test('does not write when readiness adopts no engine', async () => {
  const f = await fixture();
  const mutation = vi.spyOn(f.loader, 'mutateAppConfig');
  await recordAdoptedBuiltinEngine({
    configLoader: f.loader,
    explicitConnectionId: undefined,
    binding: null,
  });
  expect(mutation).not.toHaveBeenCalled();
});

test('a failed adoption write remains a warning without claiming persistence', async () => {
  const f = await fixture();
  vi.spyOn(f.loader, 'mutateAppConfig').mockRejectedValueOnce(
    new Error('read-only home'),
  );
  const warn = vi.fn();
  await expect(
    recordAdoptedBuiltinEngine({
      configLoader: f.loader,
      explicitConnectionId: undefined,
      binding,
      logger: { warn },
    }),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(
    (await f.loader.loadAppConfig()).builtinAgentEngineConnectionId,
  ).toBeUndefined();
});
