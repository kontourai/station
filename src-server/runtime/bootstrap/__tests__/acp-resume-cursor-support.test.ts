import { describe, expect, test } from 'vitest';
import { acpResumeCursorSupport } from '../acp-resume-cursor-support.js';

function bridgeWith(
  connections: Array<{
    id: string;
    handshakeObservedAt?: string;
    capabilities?: { loadSession?: boolean };
  }>,
) {
  return {
    getStatus: () => ({ connections, activeSessions: 0 }),
  };
}

/** #764 review round 2: the production derivation, exercised directly with a
 * fake acpBridge.getStatus(). The four connections cover every evidence
 * state the manager view can project for `loadSession`. */
describe('acpResumeCursorSupport', () => {
  test('true / false / false / undefined across the four evidence states', () => {
    const support = acpResumeCursorSupport(
      bridgeWith([
        {
          id: 'conn-supported',
          handshakeObservedAt: '2026-08-28T00:00:00.000Z',
          capabilities: { loadSession: true },
        },
        {
          id: 'conn-refused',
          handshakeObservedAt: '2026-08-28T00:00:00.000Z',
          capabilities: { loadSession: false },
        },
        {
          // A successful handshake that advertised NO capabilities — a real
          // observation whose answer is "unsupported", not "unknown".
          id: 'conn-bare',
          handshakeObservedAt: '2026-08-28T00:00:00.000Z',
        },
      ]),
    );

    expect(support({ provider: 'acp', connectionId: 'conn-supported' })).toBe(
      true,
    );
    expect(support({ provider: 'acp', connectionId: 'conn-refused' })).toBe(
      false,
    );
    expect(support({ provider: 'acp', connectionId: 'conn-bare' })).toBe(false);
    // Never met this CLI: no handshake evidence, so the adapter's own
    // fail-closed ruling stays authoritative (cursor path kept).
    expect(support({ provider: 'acp', connectionId: 'conn-unknown' })).toBe(
      undefined,
    );
  });

  test('non-ACP providers and missing connection ids keep the cursor path', () => {
    const support = acpResumeCursorSupport(bridgeWith([]));
    expect(support({ provider: 'claude', connectionId: 'conn-a' })).toBe(
      undefined,
    );
    expect(support({ provider: 'acp' })).toBe(undefined);
  });

  test('a failing getStatus is evidence of nothing, not of refusal', () => {
    const support = acpResumeCursorSupport({
      getStatus: () => {
        throw new Error('bridge unavailable');
      },
    });
    expect(support({ provider: 'acp', connectionId: 'conn-a' })).toBe(
      undefined,
    );
  });
});
