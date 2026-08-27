import {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from '@kontourai/station-sdk/testing';
import { VoiceSessionAdapterRegistry } from '@kontourai/station-sdk/voice';
import { describe, expect, it } from 'vitest';
import { ElevenLabsRealtimeProvider } from '../ElevenLabsRealtimeProvider';
import { activate } from '../index';

describe('ElevenLabsRealtimeProvider', () => {
  it('passes the common fake-transport conformance probe', async () => {
    const provider = new ElevenLabsRealtimeProvider(readyTransport());
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

function emitRequiredEvents(connection: object): void {
  const emitter = connection as { emit(event: unknown): void };
  emitter.emit({ type: 'speech', audio: new Uint8Array([1]) });
  emitter.emit({ type: 'transcript', text: 'conformance', role: 'assistant' });
  emitter.emit({ type: 'usage', inputAudioMs: 1 });
  emitter.emit({ type: 'disconnect' });
}
