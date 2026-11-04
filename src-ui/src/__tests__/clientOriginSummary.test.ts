import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { describe, expect, test } from 'vitest';
import { clientOriginSummary } from '../utils/clientOrigin';

function origin(
  actor: ClientOrigin['actor'],
  surface: ClientOrigin['reported']['surface'],
): ClientOrigin {
  return { version: 1, actor, reported: { version: 1, surface, build: null } };
}

describe('#4402: clientOriginSummary speaks plainly', () => {
  test("Station's own turns read as Station, with no unreported surface", () => {
    expect(clientOriginSummary(origin({ kind: 'internal' }, 'unknown'))).toBe(
      'Station',
    );
  });

  test('a reported surface is still named', () => {
    expect(
      clientOriginSummary(origin({ kind: 'device', deviceId: 'd1' }, 'mobile')),
    ).toBe('Paired device · Mobile app');
    expect(clientOriginSummary(origin({ kind: 'unknown' }, 'cli'))).toBe(
      'Unknown sender · CLI',
    );
  });
});
