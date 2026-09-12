import { describe, expect, test } from 'vitest';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import {
  nativeSessionIdentityMatchesSource,
  providerNativeSessionIdentity,
} from '../provider-session-identity.js';

const CLAUDE_AFFINITY = {
  kind: 'claude-config-home',
  ref: 'a'.repeat(64),
};
const CODEX_AFFINITY = {
  kind: 'codex-config-home',
  ref: 'b'.repeat(64),
};

describe('provider native session identity', () => {
  test('projects legacy and source-bound Claude cursors', () => {
    const adapter = new ClaudeAdapter();

    expect(providerNativeSessionIdentity(adapter, 'claude-session')).toEqual({
      sessionId: 'claude-session',
    });
    expect(
      providerNativeSessionIdentity(adapter, {
        claudeSessionId: 'claude-session',
        sourceAffinity: CLAUDE_AFFINITY,
      }),
    ).toEqual({ sessionId: 'claude-session', affinity: CLAUDE_AFFINITY });
  });

  test('projects source-bound Codex cursors without exposing cursor shape to callers', () => {
    const adapter = new CodexAdapter();

    expect(
      providerNativeSessionIdentity(adapter, {
        codexThreadId: '11111111-1111-4111-8111-111111111111',
        sourceAffinity: CODEX_AFFINITY,
      }),
    ).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      affinity: CODEX_AFFINITY,
    });
  });

  test('matches unknown legacy affinity but refuses two known different homes', () => {
    const legacy = { sessionId: 'native-session' };
    const bound = { sessionId: 'native-session', affinity: CLAUDE_AFFINITY };

    expect(
      nativeSessionIdentityMatchesSource(
        legacy,
        'native-session',
        CLAUDE_AFFINITY,
      ),
    ).toBe(true);
    expect(
      nativeSessionIdentityMatchesSource(bound, 'native-session', {
        ...CLAUDE_AFFINITY,
        ref: 'c'.repeat(64),
      }),
    ).toBe(false);
  });

  test('contains throwing adapter projections and invalid returned identities', () => {
    const throwing = {
      nativeSessionIdentity: () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error('untrusted getter');
            },
          },
        ),
    } as unknown as ProviderAdapterShape;
    const oversized = {
      nativeSessionIdentity: () => ({ sessionId: 'x'.repeat(513) }),
    } as unknown as ProviderAdapterShape;

    expect(providerNativeSessionIdentity(throwing, {})).toBeUndefined();
    expect(providerNativeSessionIdentity(oversized, {})).toBeUndefined();
  });
});
