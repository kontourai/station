import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerRealtimeVoiceProvider } from '../voice/realtime-provider-registration.js';
import type {
  VoiceRealtimeLease,
  VoiceRealtimeProvider,
  VoiceRealtimeReadiness,
} from '../voice/realtime-types.js';
import { VoiceSessionAdapterRegistry } from '../voice/session-registry.js';

describe('Voice realtime contracts', () => {
  it('keeps readiness a content-free closed union', () => {
    const readiness: readonly VoiceRealtimeReadiness[] = [
      { status: 'ready' },
      { status: 'unsupported', reason: 'browser-unsupported' },
      { status: 'unconfigured', reason: 'missing-configuration' },
      { status: 'unavailable', reason: 'service-unavailable' },
      {
        status: 'rate-limited',
        reason: 'provider-rate-limited',
        retryAt: 1_700_000_000_000,
      },
    ];

    expect(readiness.map((entry) => entry.status)).toEqual([
      'ready',
      'unsupported',
      'unconfigured',
      'unavailable',
      'rate-limited',
    ]);
    expect(JSON.stringify(readiness)).not.toMatch(/token|key|signed|url/i);
  });

  it('only exposes an opaque lease opener, never authorization fields', async () => {
    const lease: VoiceRealtimeLease = {
      providerId: 'fake',
      expiresAt: 1_700_000_180_000,
      open: async () => {
        throw new Error('not used');
      },
    };
    const provider: VoiceRealtimeProvider = {
      descriptor: { id: 'fake', name: 'Fake realtime' },
      capabilities: { textTurn: true, audioInput: true },
      readiness: async () => ({ status: 'ready' }),
      mint: async () => lease,
    };

    expect(await provider.readiness()).toEqual({ status: 'ready' });
    expect(Object.keys(lease)).toEqual(['providerId', 'expiresAt', 'open']);
    expect(JSON.stringify(lease)).not.toMatch(/token|key|signed|url/i);
  });

  it('registers packs explicitly and restores a preceding same-ID pack on disposal', () => {
    const registry = new VoiceSessionAdapterRegistry();
    const first = providerWithId('same');
    const replacement = providerWithId('same');
    const firstHandle = registerRealtimeVoiceProvider(registry, first);
    const replacementHandle = registerRealtimeVoiceProvider(
      registry,
      replacement,
    );

    expect(registry.get('same')?.descriptor.name).toBe('Replacement');
    replacementHandle.dispose();
    expect(registry.get('same')?.descriptor.name).toBe('First');
    firstHandle.dispose();
    expect(registry.get('same')).toBeUndefined();
  });

  it('does not make upstream error text part of the public event contract', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../voice/realtime-types.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('readonly message?: string');
  });
});

function providerWithId(id: string): VoiceRealtimeProvider {
  const name = providerCount++ ? 'Replacement' : 'First';
  return {
    descriptor: { id, name },
    capabilities: {},
    readiness: async () => ({ status: 'ready' }),
    mint: async () => ({
      providerId: id,
      open: async () => {
        throw new Error('not used');
      },
    }),
  };
}
let providerCount = 0;
