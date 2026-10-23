import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  type BuiltinAgentEngineBinding,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { describe, expect, test, vi } from 'vitest';
import { recordAdoptedBuiltinEngine } from '../builtin-engine-adoption.js';

/**
 * The behavior this recording exists for: an unchosen home adopts its only
 * capable engine, and from then on readiness must not be able to take it back.
 * Today that is exactly what happens — a second engine becoming ready made the
 * resolver's ambiguity rule withdraw the first (2026-10-22), so the built-in
 * assistant stopped working because a DIFFERENT engine's credentials were
 * repaired.
 */

function bindingFor(connectionId: string): BuiltinAgentEngineBinding {
  return {
    connectionId: engineConnectionId(connectionId),
    matrix: resolveEngineCapabilityMatrix(connectionId, {
      engineId: 'opencode',
    }),
  };
}

function createRecorder() {
  const updateAppConfig = vi.fn().mockResolvedValue({});
  return { configLoader: { updateAppConfig }, updateAppConfig };
}

describe('recordAdoptedBuiltinEngine', () => {
  test('records the adopted engine when the home has never chosen one', async () => {
    const { configLoader, updateAppConfig } = createRecorder();

    await recordAdoptedBuiltinEngine({
      configLoader,
      explicitConnectionId: undefined,
      binding: bindingFor('opencode'),
    });

    expect(updateAppConfig).toHaveBeenCalledTimes(1);
    expect(updateAppConfig).toHaveBeenCalledWith({
      builtinAgentEngineConnectionId: 'opencode',
    });
  });

  test('never overwrites an explicit engine choice', async () => {
    // The user already answered, and a later resolution that would prefer a
    // different engine must not rewrite that answer.
    const { configLoader, updateAppConfig } = createRecorder();

    await recordAdoptedBuiltinEngine({
      configLoader,
      explicitConnectionId: engineConnectionId('claude'),
      binding: bindingFor('opencode'),
    });

    expect(updateAppConfig).not.toHaveBeenCalled();
  });

  test('never overwrites an explicit Station choice', async () => {
    // `null` is "the user chose Station's own engine", which is not the same
    // as "nothing chosen" — the distinction the resolver itself rests on.
    const { configLoader, updateAppConfig } = createRecorder();

    await recordAdoptedBuiltinEngine({
      configLoader,
      explicitConnectionId: null,
      binding: bindingFor('opencode'),
    });

    expect(updateAppConfig).not.toHaveBeenCalled();
  });

  test('writes nothing when readiness adopted no engine', async () => {
    // No capable engine, or genuine ambiguity: not an adoption, so nothing is
    // recorded and the state stays exactly as undecided as it was.
    const { configLoader, updateAppConfig } = createRecorder();

    await recordAdoptedBuiltinEngine({
      configLoader,
      explicitConnectionId: undefined,
      binding: null,
    });

    expect(updateAppConfig).not.toHaveBeenCalled();
  });

  test('a home that cannot be written still runs on the resolved binding', async () => {
    const { configLoader } = createRecorder();
    configLoader.updateAppConfig.mockRejectedValue(
      new Error('EROFS: read-only file system'),
    );
    const warn = vi.fn();

    await expect(
      recordAdoptedBuiltinEngine({
        configLoader,
        explicitConnectionId: undefined,
        binding: bindingFor('opencode'),
        logger: { warn },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
