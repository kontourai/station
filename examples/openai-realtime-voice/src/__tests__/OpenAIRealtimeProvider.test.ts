import {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from '@kontourai/station-sdk/testing';
import { VoiceSessionAdapterRegistry } from '@kontourai/station-sdk/voice';
import { describe, expect, it } from 'vitest';
import { activate } from '../index';
import { OpenAIRealtimeProvider } from '../OpenAIRealtimeProvider';

describe('OpenAIRealtimeProvider', () => {
  it('passes the common fake-transport conformance probe', async () => {
    const provider = new OpenAIRealtimeProvider(readyTransport());
    const report = await runVoiceRealtimeConformance({
      provider,
      requiredEvents: ['speech', 'transcript', 'usage', 'disconnect'],
      exercise: (connection) => emitRequiredEvents(connection),
    });

    expect(report.ok).toBe(true);
    expect(report.events).toEqual(
      expect.arrayContaining(['speech', 'transcript', 'usage', 'disconnect']),
    );
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

function emitRequiredEvents(connection: object): void {
  const emitter = connection as { emit(event: unknown): void };
  emitter.emit({ type: 'speech', audio: new Uint8Array([1]) });
  emitter.emit({ type: 'transcript', text: 'conformance', role: 'assistant' });
  emitter.emit({ type: 'usage', inputAudioMs: 1 });
  emitter.emit({ type: 'disconnect' });
}
