import {
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
  type StationClientCompatibilityPolicy,
} from '@kontourai/station-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_COMPATIBILITY_POLICY,
  checkHostCompatibility,
  evaluateCompatibility,
} from '../lib/compatibility';
import { isBlockingCompatibility } from '../lib/compatibilityLoader';

/**
 * The client this repo ships. Every "too old" case below has to be constructed
 * against an explicit policy rather than by mutating this one, so the matrix
 * still means something after the real constants are bumped.
 */
const shippedPolicy = CLIENT_COMPATIBILITY_POLICY;

function policy(
  clientProtocol: number,
  minServerProtocol: number,
): StationClientCompatibilityPolicy {
  return { clientProtocol, minServerProtocol };
}

const serverBlock = (overrides: Record<string, unknown> = {}) => ({
  serverVersion: '0.4.1',
  protocolVersion: 3,
  minClientProtocol: 2,
  capabilities: { remoteAuth: 1, devicePairing: 1 },
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe('evaluateCompatibility', () => {
  it('accepts a host inside the window both sides declare', () => {
    const result = evaluateCompatibility(policy(3, 3), serverBlock());
    expect(result.verdict).toBe('compatible');
    expect(result.blocking).toBe(false);
    expect(result.serverVersion).toBe('0.4.1');
    expect(result.serverProtocol).toBe(3);
  });

  it('accepts a client newer than the host, while the host still serves it', () => {
    const result = evaluateCompatibility(
      policy(9, 1),
      serverBlock({ protocolVersion: 3, minClientProtocol: 2 }),
    );
    expect(result.verdict).toBe('compatible');
  });

  it('accepts a client exactly at the host floor (boundary, not off-by-one)', () => {
    const result = evaluateCompatibility(
      policy(2, 1),
      serverBlock({ minClientProtocol: 2 }),
    );
    expect(result.verdict).toBe('compatible');
  });

  it('accepts a host exactly at the client floor (boundary, not off-by-one)', () => {
    const result = evaluateCompatibility(
      policy(3, 3),
      serverBlock({ protocolVersion: 3 }),
    );
    expect(result.verdict).toBe('compatible');
  });

  it('tells the user to update the app when the host stopped serving clients this old', () => {
    const result = evaluateCompatibility(
      policy(1, 1),
      serverBlock({ minClientProtocol: 2 }),
    );
    expect(result.verdict).toBe('client-too-old');
    expect(result.blocking).toBe(true);
    expect(result.reason).toMatch(/Update this app/);
    // The message must name the side to update and how, not just a number.
    expect(result.reason).toMatch(/Install the latest Station app/);
    expect(result.reason).toContain('0.4.1');
  });

  it('tells the user to update the host when the host is below the client floor', () => {
    const result = evaluateCompatibility(
      policy(5, 4),
      serverBlock({ protocolVersion: 3, minClientProtocol: 1 }),
    );
    expect(result.verdict).toBe('server-too-old');
    expect(result.blocking).toBe(true);
    expect(result.reason).toMatch(/Update the Station host/);
    expect(result.reason).toMatch(/Upgrade Station on the host machine/);
  });

  it("prefers the host's own refusal when both sides could complain", () => {
    // Host serves >= 6 but itself speaks 3; the client speaks 1 and needs >= 4.
    // Telling this user to upgrade the host would not help — the host would
    // still refuse a protocol-1 client.
    const result = evaluateCompatibility(
      policy(1, 4),
      serverBlock({ protocolVersion: 3, minClientProtocol: 6 }),
    );
    expect(result.verdict).toBe('client-too-old');
  });

  describe('verification failures', () => {
    it.each([
      ['absent (older host)', undefined],
      ['explicitly null', null],
      ['not an object', 'v1'],
      ['an array', []],
      ['missing serverVersion', serverBlock({ serverVersion: undefined })],
      ['empty serverVersion', serverBlock({ serverVersion: '' })],
      ['non-integer protocolVersion', serverBlock({ protocolVersion: '3' })],
      ['fractional protocolVersion', serverBlock({ protocolVersion: 3.5 })],
      ['missing minClientProtocol', serverBlock({ minClientProtocol: null })],
    ] as const)('blocks %s with an actionable update path', (_label, block) => {
      const result = evaluateCompatibility(shippedPolicy, block);
      expect(result.verdict).toBe('unknown');
      expect(result.blocking).toBe(true);
      expect(result.reason).toMatch(/could not be verified/);
      expect(result.reason).toMatch(/Update Station on the host/);
    });

    it('blocks a compatibility block with malformed capability entries', () => {
      const result = evaluateCompatibility(
        policy(3, 3),
        serverBlock({ capabilities: { remoteAuth: 1, bogus: 'x' } }),
      );
      expect(result).toMatchObject({ verdict: 'unknown', blocking: true });
    });

    it('blocks a capabilities value that is not a map', () => {
      const result = evaluateCompatibility(
        policy(3, 3),
        serverBlock({ capabilities: 'all' }),
      );
      expect(result).toMatchObject({ verdict: 'unknown', blocking: true });
    });
  });

  it('is compatible with the contract this repo currently ships on both sides', () => {
    // Both directions of "today's build talks to today's build". If a future
    // bump ever makes the shipped client and the shipped host disagree, this
    // fails before anyone ships it.
    const result = evaluateCompatibility(shippedPolicy, {
      serverVersion: '0.0.0-test',
      protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
      minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
    });
    expect(result.verdict).toBe('compatible');
  });
});

describe('checkHostCompatibility', () => {
  it('reads the compatibility block off the public handshake', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ compatibility: serverBlock({ minClientProtocol: 9 }) }),
    );
    await expect(
      checkHostCompatibility(
        'https://station.example.test',
        undefined,
        policy(1, 1),
      ),
    ).resolves.toMatchObject({ verdict: 'client-too-old', blocking: true });
    expect(vi.mocked(fetch).mock.calls[0][0]).toStrictEqual(
      new URL('/.well-known/station/v1', 'https://station.example.test'),
    );
  });

  it('blocks a host that answers without a compatibility declaration', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        schemaVersion: 1,
        environmentId: 'environment-1',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
      }),
    );
    await expect(
      checkHostCompatibility('https://station.example.test'),
    ).resolves.toMatchObject({ verdict: 'unknown', blocking: true });
  });

  it.each([
    [
      'a non-OK response',
      () => Promise.resolve(new Response('', { status: 404 })),
    ],
    ['a transport failure', () => Promise.reject(new TypeError('offline'))],
    ['a non-JSON body', () => Promise.resolve(new Response('<html>'))],
    [
      'an aborted request',
      () =>
        Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
    ],
  ] as const)(
    'blocks %s with an actionable verification state',
    async (_label, respond) => {
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(respond as never);
      await expect(
        checkHostCompatibility('https://station.example.test'),
      ).resolves.toMatchObject({ verdict: 'unknown', blocking: true });
    },
  );
});

describe('isBlockingCompatibility', () => {
  it('blocks when no compatibility declaration can be evaluated', async () => {
    await expect(isBlockingCompatibility(undefined)).resolves.toBe(true);
  });
});
