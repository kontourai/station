import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { normalizePersistedToolServerReason } from '../../../security/tool-server-reason.js';
import { ToolServerCredentialStore } from '../tool-server-credential-store.js';
import {
  captureToolServerOperationFailure,
  classifyOAuthFailure,
  classifyToolServerProbeFailure,
  formatToolServerFailure,
  projectToolServerResult,
  requireHttpAuthorizationUrl,
  requireToolServerResult,
  StationToolServerOAuthProvider,
  validateOAuthCallbackUrl,
} from '../tool-server-oauth.js';

describe('remote failure containment', () => {
  test('resolved protocol failures retain no remote text', () => {
    const canary = 'opaque-remote-canary-split-across-text';
    const result = {
      isError: true,
      content: [{ type: 'text', text: canary }],
      structuredContent: { leaked: canary },
    };
    expect(JSON.stringify(projectToolServerResult(result))).not.toContain(
      canary,
    );
    expect(() => requireToolServerResult(result, 'tool-call', 'srv')).toThrow(
      'MCP tool call failed',
    );
  });

  test('the debug channel records shape only, never remote text', () => {
    const contexts: Record<string, unknown>[] = [];
    const secret = 'echoed-refresh-token-9d2f1a';
    const publicError = captureToolServerOperationFailure(
      new Error(`access_denied: ${secret}`),
      'authorize',
      'srv',
      {
        debug: (_m: string, ctx?: Record<string, unknown>) =>
          void contexts.push(ctx ?? {}),
      },
    );
    // Outward error carries Station vocabulary only.
    expect(publicError.message).not.toContain(secret);
    // Debug context carries no remote text in any field, including split forms.
    const serialized = JSON.stringify(contexts);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('access_denied');
    // …but still distinguishes "something came back" from "nothing did".
    expect(contexts[0]?.detailLength).toBeGreaterThan(0);
    expect(String(contexts[0]?.detailDigest)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('OAuth callback paste-back validation', () => {
  const redirect = 'http://127.0.0.1:4321/callback';

  test.each([
    ['javascript:alert(1)', 'scheme must be http or https'],
    [
      'http://evil.com:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://127.0.0.1:4321/callback?code=x&code=y&state=issued',
      'exactly one code',
    ],
    [
      'http://user:pass@127.0.0.1:4321/callback?code=x&state=issued',
      'must not contain credentials',
    ],
    [
      'http://127.0.0.1:4321/callback?code=x&state=issued#fragment',
      'must not contain a fragment',
    ],
    [
      'http://127.0.0.1:9999/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://127.0.0.1:4321/other?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://127.0.0.1:4321/callback?code=x&state=wrong',
      'state does not match',
    ],
    ['http://127.0.0.1:4321/callback?code=x', 'exactly one state'],
    [
      'http://LOCALHOST:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://0.0.0.0:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://localhost.evil.com:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://localhost.:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://locаlhost:4321/callback?code=x&state=issued',
      'does not match the redirect URI',
    ],
    [
      'http://[fe80::1%25lo0]:4321/callback?code=x&state=issued',
      'not a valid URL',
    ],
  ])('rejects %s because %s', (url, reason) => {
    expect(validateOAuthCallbackUrl(url, 'issued', redirect)).toEqual({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });

  test.each(['127.0.0.1', '127.1', '2130706433'])(
    'accepts URL-normalized spellings of the exact issued IPv4 loopback %s',
    (host) => {
      expect(
        validateOAuthCallbackUrl(
          `http://${host}:4321/callback?code=one&state=issued`,
          'issued',
          redirect,
        ).ok,
      ).toBe(true);
    },
  );
});

describe('OAuth authorization URL validation', () => {
  test.each(['file:///tmp/consent', 'custom-handler://consent'])(
    'rejects the %s authorization URL before browser launch',
    (value) => {
      expect(() => requireHttpAuthorizationUrl(new URL(value))).toThrowError(
        expect.objectContaining({ name: 'UnsafeOAuthAuthorizationUrlError' }),
      );
    },
  );

  test.each(['http://auth.example/consent', 'https://auth.example/consent'])(
    'accepts %s',
    (value) => {
      expect(requireHttpAuthorizationUrl(new URL(value)).href).toBe(value);
    },
  );
});

describe('StationToolServerOAuthProvider persistence', () => {
  test('stores tokens, client information, verifier, state, and discovery only in the credential store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-oauth-'));
    const store = new ToolServerCredentialStore(home);
    const provider = new StationToolServerOAuthProvider(
      store,
      'remote',
      'https://resource.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    await provider.saveTokens({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
    });
    await provider.saveClientInformation({ client_id: 'client-secret' });
    await provider.saveCodeVerifier('verifier-secret');
    const state = await provider.state();
    await provider.saveDiscoveryState({
      authorizationServerUrl: new URL('https://auth.example'),
    } as never);

    expect((await provider.tokens())?.access_token).toBe('access-secret');
    expect((await provider.clientInformation())?.client_id).toBe(
      'client-secret',
    );
    expect(await provider.codeVerifier()).toBe('verifier-secret');
    expect(await provider.expectedState()).toBe(state);
    expect(await provider.discoveryState()).toBeTruthy();
  });

  test('refuses and clears credentials bound to a different endpoint', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-oauth-bound-'));
    const store = new ToolServerCredentialStore(home);
    const endpointA = new StationToolServerOAuthProvider(
      store,
      'remote',
      'https://resource-a.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    await endpointA.saveTokens({
      access_token: 'endpoint-a-token',
      refresh_token: 'endpoint-a-refresh',
      token_type: 'Bearer',
    });
    await endpointA.saveCodeVerifier('endpoint-a-verifier');
    await endpointA.state();

    const endpointB = new StationToolServerOAuthProvider(
      store,
      'remote',
      'https://resource-b.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    expect(await endpointB.tokens()).toBeUndefined();
    expect(await endpointB.expectedState()).toBeUndefined();
    await expect(endpointB.codeVerifier()).rejects.toThrow(/missing/);
  });

  test('honors issuer context while retaining the resource-server token read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-oauth-issuer-'));
    const provider = new StationToolServerOAuthProvider(
      new ToolServerCredentialStore(home),
      'remote',
      'https://resource.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    await provider.saveTokens(
      { access_token: 'bound', token_type: 'Bearer' },
      { issuer: 'https://issuer-a.example' },
    );
    expect((await provider.tokens())?.access_token).toBe('bound');
    expect(
      await provider.tokens({ issuer: 'https://issuer-b.example' }),
    ).toBeUndefined();
  });

  test('expires and consumes state exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
    const home = mkdtempSync(join(tmpdir(), 'station-oauth-state-'));
    const provider = new StationToolServerOAuthProvider(
      new ToolServerCredentialStore(home),
      'remote',
      'https://resource.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    const first = await provider.state();
    expect(await provider.consumeState()).toBe(first);
    expect(await provider.consumeState()).toBeUndefined();
    await provider.state();
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(await provider.expectedState()).toBeUndefined();
    vi.useRealTimers();
  });

  test('all-scope invalidation leaves environment credentials intact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-oauth-invalidate-'));
    const store = new ToolServerCredentialStore(home);
    await store.upsert('remote', 'API_TOKEN', 'environment-secret');
    const provider = new StationToolServerOAuthProvider(
      store,
      'remote',
      'https://resource.example/mcp',
      'http://127.0.0.1:3141/oauth/callback',
    );
    await provider.saveTokens({
      access_token: 'oauth-secret',
      token_type: 'Bearer',
    });
    await provider.invalidateCredentials('all');
    expect(store.get('remote', 'API_TOKEN')).toBe('environment-secret');
    expect(await provider.tokens()).toBeUndefined();
  });
});

describe('OAuth error persistence safety', () => {
  test.each([
    [{ code: 'invalid_client', message: 'server text' }, 'invalid_client'],
    [{ code: 'unauthorized_client', message: 'server text' }, 'invalid_client'],
    [{ code: 'invalid_grant', message: 'server text' }, 'invalid_grant'],
    [{ code: 'access_denied', message: 'server text' }, 'access_denied'],
    [
      { code: 'temporarily_unavailable', message: 'server text' },
      'server_error',
    ],
    [{ status: 503, message: 'server text' }, 'server_error'],
    [
      { code: 'ECONNREFUSED', message: 'local transport text' },
      'network_error',
    ],
    [{ status: 418, message: 'server text' }, 'unexpected_response'],
  ] as const)(
    'classifies %j as the bounded %s vocabulary without retaining text',
    (error, code) => {
      const result = classifyOAuthFailure(error);
      expect(result.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain(error.message);
    },
  );

  test.each([
    [
      Object.assign(new Error('remote auth text'), { status: 401 }),
      'streamable-http',
      'authentication_error: Tool server authentication failed',
    ],
    [
      Object.assign(new Error('remote network text'), {
        code: 'ECONNRESET',
      }),
      'streamable-http',
      'network_error: Tool server could not be reached',
    ],
    [
      new Error('remote process text'),
      'stdio',
      'transport_error: Tool server transport failed',
    ],
    [
      new Error('remote protocol text'),
      'streamable-http',
      'protocol_error: Tool server returned an unexpected protocol response',
    ],
  ])(
    'classifies probe failures without retaining remote text',
    (error, transport, expected) => {
      const reason = formatToolServerFailure(
        classifyToolServerProbeFailure(error, transport),
      );
      expect(reason).toBe(expected);
      expect(reason).not.toContain(error.message);
    },
  );

  test('collapses legacy persisted free text instead of implying it can be scrubbed', () => {
    const raw =
      'token failed split-secret-left::attacker-gap::split-secret-right';
    const reason = normalizePersistedToolServerReason(raw);
    expect(reason).toBe(
      'protocol_error: Tool server returned an unexpected protocol response',
    );
    expect(reason).not.toContain(raw);
  });
});
