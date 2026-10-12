import { describe, expect, test } from 'vitest';
import { acpAdvertisedModelIds } from '../acp-advertised-models.js';

const OBSERVED = '2026-10-12T00:00:00.000Z';

function bridgeWith(
  connections: Array<{
    id: string;
    handshakeObservedAt?: string;
    configOptions: any[];
  }>,
) {
  return {
    getStatus: () => ({ connections, activeSessions: 0 }),
  };
}

describe('acpAdvertisedModelIds', () => {
  const ids = acpAdvertisedModelIds(
    bridgeWith([
      {
        id: 'opencode',
        handshakeObservedAt: OBSERVED,
        configOptions: [
          { category: 'mode', options: [{ value: 'plan' }] },
          {
            category: 'model',
            options: [
              { value: 'anthropic/claude-sonnet-4-6', name: 'Sonnet' },
              'bare-string-model',
              { value: '' },
              { name: 'no value' },
            ],
          },
        ],
      },
      {
        id: 'no-model-option',
        handshakeObservedAt: OBSERVED,
        configOptions: [{ category: 'mode', options: [{ value: 'plan' }] }],
      },
      {
        id: 'never-handshaked',
        configOptions: [
          { category: 'model', options: [{ value: 'stale-cache' }] },
        ],
      },
    ]),
  );

  test("answers the handshake's model option values, ignoring unusable entries", () => {
    expect(ids('opencode')).toEqual([
      'anthropic/claude-sonnet-4-6',
      'bare-string-model',
    ]);
  });

  test('an engine that advertised no model option makes no claim', () => {
    expect(ids('no-model-option')).toBeUndefined();
  });

  test('a connection never observed handshaking makes no claim, whatever it caches', () => {
    expect(ids('never-handshaked')).toBeUndefined();
  });

  test('an unknown or empty connection id makes no claim', () => {
    expect(ids('nope')).toBeUndefined();
    expect(ids('')).toBeUndefined();
  });

  test('a failing getStatus is evidence of nothing', () => {
    const failing = acpAdvertisedModelIds({
      getStatus: () => {
        throw new Error('bridge unavailable');
      },
    });
    expect(failing('opencode')).toBeUndefined();
  });
});
