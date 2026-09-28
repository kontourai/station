import {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from '@kontourai/station-sdk/testing';
import { VoiceSessionAdapterRegistry } from '@kontourai/station-sdk/voice';
import { describe, expect, it } from 'vitest';
import { activate } from '../index';
import { OpenAIRealtimeProvider } from '../OpenAIRealtimeProvider';

describe('OpenAIRealtimeProvider', () => {
  // The transport's connection reaches the runner unwrapped, so event
  // delivery is the SDK fake's; this probe pins operations and capabilities.
  it('passes the common operation and capability conformance probe', async () => {
    const provider = new OpenAIRealtimeProvider(readyTransport());
    const report = await runVoiceRealtimeConformance({
      provider,
      requiredEvents: [],
      exercise: () => undefined,
    });

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('returns a transport-provided unavailable state without provider details', async () => {
    const provider = new OpenAIRealtimeProvider({
      readiness: async () => ({
        status: 'unavailable' as const,
        reason: 'service-unavailable' as const,
      }),
      mint: async () => ({ endpoint: 'ignored' }),
      open: async () => {
        throw new Error('not reached');
      },
    });

    await expect(provider.readiness()).resolves.toEqual({
      status: 'unavailable',
      reason: 'service-unavailable',
    });
  });

  it('registers a disableable unconfigured adapter during plugin activation', async () => {
    const registry = new VoiceSessionAdapterRegistry();

    const dispose = activate({ apiBase: 'https://station.test' }, registry);
    const adapter = registry.get('openai-realtime-compatible');

    expect(adapter).toBeDefined();
    await expect(adapter?.start()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unconfigured' },
    });
    dispose();
    expect(registry.get('openai-realtime-compatible')).toBeUndefined();
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
