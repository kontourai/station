import { afterEach, describe, expect, test, vi } from 'vitest';

const { mockStationControlMcpTokenMintedAdd } = vi.hoisted(() => ({
  mockStationControlMcpTokenMintedAdd: vi.fn(),
}));

vi.mock('../../../telemetry/metrics.js', () => ({
  stationControlMcpTokenMinted: { add: mockStationControlMcpTokenMintedAdd },
}));

import {
  __resetStationControlMcpTokensForTests,
  buildStationControlMcpHeaderUrl,
  buildStationControlMcpUrl,
  DEFAULT_TTL_MS,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
  STATION_CONTROL_MCP_PATH,
  verifyStationControlMcpToken,
} from '../station-control-mcp-token.js';

afterEach(() => {
  __resetStationControlMcpTokensForTests();
  vi.useRealTimers();
  mockStationControlMcpTokenMintedAdd.mockClear();
});

describe('station-control-mcp-token', () => {
  // Review fix (archive#1195 round 1, LOW): stationControlMcpTokenMinted
  // was declared in metrics.ts but never incremented anywhere.
  test('records stationControlMcpTokenMinted on every mint, distinguishing a fresh mint from one that replaced an already-live token', () => {
    mintStationControlMcpToken('thread-1', 'url-token');
    expect(mockStationControlMcpTokenMintedAdd).toHaveBeenCalledWith(1, {
      replaced_live_token: 'false',
      channel: 'url-token',
    });
    mintStationControlMcpToken('thread-1', 'url-token');
    expect(mockStationControlMcpTokenMintedAdd).toHaveBeenLastCalledWith(1, {
      replaced_live_token: 'true',
      channel: 'url-token',
    });
    expect(mockStationControlMcpTokenMintedAdd).toHaveBeenCalledTimes(2);
  });

  // archive#1684 review fix (M4): the refusal was already observable
  // (`agentCapabilityUndelivered`); the GRANT was not, and one
  // undifferentiated mint counter made an ACP grant and a Codex grant the
  // same datum.
  test('station#1684: the mint counter names the delivery channel, so an ACP grant is distinguishable from a Codex one', () => {
    mintStationControlMcpToken('codex-thread', 'url-token');
    mintStationControlMcpToken('acp-thread', 'http-header-token');

    expect(mockStationControlMcpTokenMintedAdd).toHaveBeenNthCalledWith(1, 1, {
      replaced_live_token: 'false',
      channel: 'url-token',
    });
    expect(mockStationControlMcpTokenMintedAdd).toHaveBeenNthCalledWith(2, 1, {
      replaced_live_token: 'false',
      channel: 'http-header-token',
    });
  });

  test('mints a token that verifies back to its session id', () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    expect(verifyStationControlMcpToken(token)).toEqual({
      sessionId: 'thread-1',
    });
  });

  test('binds a hosted execution context to the token instead of deriving it from the token', () => {
    const { token } = mintStationControlMcpToken(
      'thread-tenant',
      'url-token',
      undefined,
      {
        tenantId: 'alpha' as any,
        source: 'session',
      },
    );
    expect(verifyStationControlMcpToken(token)).toEqual({
      sessionId: 'thread-tenant',
      tenantExecutionContext: { tenantId: 'alpha', source: 'session' },
    });
  });

  test('rejects an unknown token', () => {
    mintStationControlMcpToken('thread-1', 'url-token');
    expect(verifyStationControlMcpToken('not-a-real-token')).toBeUndefined();
  });

  test('rejects a missing/empty/malformed candidate without throwing', () => {
    expect(verifyStationControlMcpToken(undefined)).toBeUndefined();
    expect(verifyStationControlMcpToken(null)).toBeUndefined();
    expect(verifyStationControlMcpToken('')).toBeUndefined();
  });

  test('re-minting for the same session invalidates the prior token (no lingering second live credential)', () => {
    const first = mintStationControlMcpToken('thread-1', 'url-token');
    const second = mintStationControlMcpToken('thread-1', 'url-token');
    expect(verifyStationControlMcpToken(first.token)).toBeUndefined();
    expect(verifyStationControlMcpToken(second.token)).toEqual({
      sessionId: 'thread-1',
    });
  });

  test('two different sessions each get independently valid tokens', () => {
    const a = mintStationControlMcpToken('thread-a', 'url-token');
    const b = mintStationControlMcpToken('thread-b', 'url-token');
    expect(verifyStationControlMcpToken(a.token)).toEqual({
      sessionId: 'thread-a',
    });
    expect(verifyStationControlMcpToken(b.token)).toEqual({
      sessionId: 'thread-b',
    });
  });

  test('revoking a session invalidates its token', () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    revokeStationControlMcpToken('thread-1');
    expect(verifyStationControlMcpToken(token)).toBeUndefined();
  });

  test('revoking an unknown/never-minted session id is a no-op, never throws', () => {
    expect(() => revokeStationControlMcpToken('never-existed')).not.toThrow();
  });

  test('a token expires after its TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { token } = mintStationControlMcpToken(
      'thread-1',
      'url-token',
      1_000,
    );
    expect(verifyStationControlMcpToken(token)).toEqual({
      sessionId: 'thread-1',
    });
    vi.setSystemTime(1_001);
    expect(verifyStationControlMcpToken(token)).toBeUndefined();
  });

  test('SECURITY: the token never appears verbatim in a JSON-serialized error/log-shaped object by accident (sanity: distinct from the URL builder output shape)', () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const url = buildStationControlMcpUrl(3141, token);
    expect(url).toBe(
      `http://127.0.0.1:3141${STATION_CONTROL_MCP_PATH}?token=${token}`,
    );
  });

  test('station#1684: buildStationControlMcpHeaderUrl points at the SAME endpoint with NO credential in it', () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const headerUrl = buildStationControlMcpHeaderUrl(3141);

    expect(headerUrl).toBe(`http://127.0.0.1:3141${STATION_CONTROL_MCP_PATH}`);
    // The whole reason this builder exists: on ACP's channel the credential
    // rides an Authorization header, so a token anywhere in the URL would be
    // a second copy in a field the external agent app may log.
    expect(headerUrl).not.toContain(token);
    expect(headerUrl).not.toContain('token=');
    expect(headerUrl).not.toContain('?');
    // Same endpoint as the query-string form, differing only in the query.
    expect(buildStationControlMcpUrl(3141, token).startsWith(headerUrl)).toBe(
      true,
    );
  });

  test('buildStationControlMcpUrl URL-encodes the token', () => {
    const url = buildStationControlMcpUrl(3141, 'a+b/c=');
    expect(url).toBe(
      `http://127.0.0.1:3141${STATION_CONTROL_MCP_PATH}?token=a%2Bb%2Fc%3D`,
    );
  });

  /**
   * archive#1684 review fix (uncaught injections #8/#9).
   *
   * The three properties Station's station-control-over-ACP security argument
   * inherits from archive#1195 — a token PER SESSION, revocable, on a BOUNDED
   * default lifetime — had no test that could see them applied on the
   * production path. Every adapter test injects `mintStationControlMcpAuth`
   * as a `vi.fn()`, and the only non-test closure lived inline in
   * `runtime-initialize.ts`, so inverting any of the three stayed green
   * across the whole corpus (verified: a 100-year TTL with a no-op revoke,
   * and one cached token handed to every session, both passed).
   *
   * These exercise the real functions, and the ACP-channel ones go through
   * `mintStationControlMcpHeaderAuth` — the exact export
   * `runtime-initialize.ts` now wires into the adapter.
   */
  describe('the credential properties the ACP delivery argument rests on', () => {
    test('the default lifetime is the bounded 12 hours, applied when the caller passes no TTL', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      expect(DEFAULT_TTL_MS).toBe(12 * 60 * 60 * 1000);
      const { expiresAt } = mintStationControlMcpToken(
        'thread-ttl',
        'url-token',
      );
      expect(expiresAt - Date.now()).toBe(DEFAULT_TTL_MS);
    });

    test('two sessions minted through the ACP closure get two DIFFERENT tokens, each verifying only to its own session', () => {
      const a = mintStationControlMcpHeaderAuth(3141, 'acp-thread-a');
      const b = mintStationControlMcpHeaderAuth(3141, 'acp-thread-b');

      // The injected fault this pins: one cached token for every session.
      expect(a.token).not.toBe(b.token);
      expect(verifyStationControlMcpToken(a.token)).toEqual({
        sessionId: 'acp-thread-a',
      });
      expect(verifyStationControlMcpToken(b.token)).toEqual({
        sessionId: 'acp-thread-b',
      });
      // Both point at the bare header-channel endpoint, credential-free.
      expect(a.url).toBe(buildStationControlMcpHeaderUrl(3141));
      expect(a.url).toBe(b.url);
    });

    test("revoking one ACP session's credential invalidates it and leaves the other session live", () => {
      const a = mintStationControlMcpHeaderAuth(3141, 'acp-thread-a');
      const b = mintStationControlMcpHeaderAuth(3141, 'acp-thread-b');

      revokeStationControlMcpToken('acp-thread-a');

      // The injected fault this pins: a no-op revoke.
      expect(verifyStationControlMcpToken(a.token)).toBeUndefined();
      // ...and revocation must be scoped, not a global flush.
      expect(verifyStationControlMcpToken(b.token)).toEqual({
        sessionId: 'acp-thread-b',
      });
    });

    test('a credential minted through the ACP closure expires at the bounded default, not on some unbounded horizon', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { token } = mintStationControlMcpHeaderAuth(3141, 'acp-thread-ttl');

      vi.setSystemTime(DEFAULT_TTL_MS - 1);
      expect(verifyStationControlMcpToken(token)).toEqual({
        sessionId: 'acp-thread-ttl',
      });
      // A closure passing an inflated TTL (the injected 100-year fault) is
      // still live here; the bounded default is not.
      vi.setSystemTime(DEFAULT_TTL_MS + 1);
      expect(verifyStationControlMcpToken(token)).toBeUndefined();
    });

    test('the ACP closure mints on the http-header-token channel and binds the hosted execution context to the token', () => {
      const { token } = mintStationControlMcpHeaderAuth(
        3141,
        'acp-thread-tenant',
        { tenantId: 'alpha' as any, source: 'session' },
      );

      expect(verifyStationControlMcpToken(token)).toEqual({
        sessionId: 'acp-thread-tenant',
        tenantExecutionContext: { tenantId: 'alpha', source: 'session' },
      });
      expect(mockStationControlMcpTokenMintedAdd).toHaveBeenLastCalledWith(1, {
        replaced_live_token: 'false',
        channel: 'http-header-token',
      });
    });
  });
});
