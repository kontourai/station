import {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from '@kontourai/station-sdk/testing';
import { VoiceSessionAdapterRegistry } from '@kontourai/station-sdk/voice';
import { describe, expect, it } from 'vitest';
import { ElevenLabsRealtimeProvider } from '../ElevenLabsRealtimeProvider';
import { activate } from '../index';

describe('ElevenLabsRealtimeProvider', () => {
  // The transport's connection reaches the runner unwrapped, so event
  // delivery is the SDK fake's; this probe pins operations and capabilities.
  it('passes the common operation and capability conformance probe', async () => {
    const provider = new ElevenLabsRealtimeProvider(readyTransport());
    const report = await runVoiceRealtimeConformance({
      provider,
      requiredEvents: [],
      exercise: () => undefined,
    });

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('projects transport readiness instead of claiming ready without configuration', async () => {
    const provider = new ElevenLabsRealtimeProvider({
      mint: async () => ({ endpoint: 'ignored' }),
      open: async () => {
        throw new Error('not reached');
      },
    });

    await expect(provider.readiness()).resolves.toEqual({
      status: 'unconfigured',
      reason: 'missing-configuration',
    });
  });

  it('registers and disposes realtime alongside legacy activation', async () => {
    const registry = new VoiceSessionAdapterRegistry();

    const dispose = activate({ apiBase: 'https://station.test' }, registry);
    const adapter = registry.get('elevenlabs-realtime');

    expect(adapter).toBeDefined();
    await expect(adapter?.start()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unconfigured' },
    });
    dispose();
    expect(registry.get('elevenlabs-realtime')).toBeUndefined();
  });
});

function readyTransport() {
  const fake = createFakeVoiceRealtimeProvider();
  return {
    readiness: async () => ({ status: 'ready' as const }),
    mint: async () => ({ endpoint: 'ephemeral-endpoint' }),
    open: async () => {
      const lease = await fake.mint();
      await lease.open();
      return fake.currentConnection;
    },
  };
}
