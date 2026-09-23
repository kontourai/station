import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationProvider,
  type DeploymentAuthenticationResult,
  type VerifiedAuthenticationSession,
} from '@kontourai/station-contracts/deployment-authentication';
import { describe, expect, test, vi } from 'vitest';
import { DeploymentAuthenticationService } from '../deployment-authentication-service.js';

const now = Date.parse('2026-09-12T12:00:00.000Z');
function session(subject = 'opaque-person'): VerifiedAuthenticationSession {
  return {
    subject,
    displayName: 'Example Person',
    sessionId: 'session-record',
    authenticatedAt: '2026-09-12T11:00:00.000Z',
    expiresAt: '2026-09-12T13:00:00.000Z',
    contacts: [
      {
        kind: 'email',
        value: 'person@example.test',
        verifiedAt: '2026-09-12T10:00:00.000Z',
      },
    ],
  };
}
function provider(
  result: DeploymentAuthenticationResult = {
    kind: 'authenticated',
    session: session(),
  },
): DeploymentAuthenticationProvider {
  return {
    version: DEPLOYMENT_AUTHENTICATION_VERSION,
    issuer: 'https://identity.example.test',
    displayName: 'Example login',
    sessionCookies: ['fixture_account'],
    endpoints: [{ path: '/logout', methods: ['POST'], operation: 'logout' }],
    authenticate: vi.fn(async () => result),
    handle: vi.fn(async () => new Response(null, { status: 204 })),
  };
}
function pendingProvider() {
  const adapter = provider();
  const result = {
    kind: 'pending' as const,
    session: {
      enrollmentId: 'A'.repeat(43),
      sessionId: 'pending-session-record',
      subject: 'opaque-person',
      displayName: 'Example Person',
      expiresAt: '2026-09-12T12:05:00.000Z',
    },
  };
  const pending = {
    create: vi.fn(async (_enrollmentId: string, _request: Request) => result),
    verify: vi.fn(
      async (_enrollmentId: string, _sessionId: string, _signal: AbortSignal) =>
        result,
    ),
    promote: vi.fn(
      async (
        _enrollmentId: string,
        _sessionId: string,
        _signal: AbortSignal,
      ) => {},
    ),
    discard: vi.fn(
      async (
        _enrollmentId: string,
        _sessionId: string | undefined,
        _signal: AbortSignal,
      ) => {},
    ),
  };
  adapter.login = {
    kind: 'username-password',
    signInPath: '/sign-in/username',
  };
  adapter.endpoints = [
    ...adapter.endpoints,
    {
      path: '/sign-in/username',
      methods: ['POST'],
      operation: 'begin-login',
    },
  ];
  adapter.sessionReferences = {
    verify: vi.fn(
      async (): Promise<DeploymentAuthenticationResult> => ({
        kind: 'invalid',
        reason: 'revoked',
      }),
    ),
    revoke: vi.fn(async (_sessionId: string, _signal: AbortSignal) => {}),
    pendingEnrollment: pending,
  };
  return { adapter, pending, result };
}
const request = (cookie = 'fixture_account=valid') =>
  new Request('https://station.example.test/api/account/session', {
    headers: cookie ? { Cookie: cookie } : {},
  });

describe('deployment authentication identity boundary', () => {
  test('ignores unrelated device cookies and refuses duplicate or empty account credentials', async () => {
    const adapter = provider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    expect(
      await service.authenticate(request('station-device=personal-device')),
    ).toEqual({ kind: 'absent' });
    expect(adapter.authenticate).not.toHaveBeenCalled();
    for (const cookie of [
      'fixture_account=',
      'fixture_account',
      'fixture_account=one; fixture_account=two',
    ]) {
      expect(await service.authenticate(request(cookie))).toEqual({
        kind: 'invalid',
        reason: 'invalid-credential',
      });
    }
    expect(adapter.authenticate).not.toHaveBeenCalled();
  });

  test('aborted and retired requests never publish a late authenticated identity', async () => {
    const adapter = provider();
    let finish!: (value: DeploymentAuthenticationResult) => void;
    const pending = new Promise<DeploymentAuthenticationResult>((resolve) => {
      finish = resolve;
    });
    vi.mocked(adapter.authenticate).mockReturnValue(pending);
    adapter.close = vi.fn(async () => {});
    const service = new DeploymentAuthenticationService(adapter, () => now);
    const controller = new AbortController();
    const incoming = new Request('https://station.example.test', {
      signal: controller.signal,
      headers: { Cookie: 'fixture_account=valid' },
    });
    const reading = service.authenticate(incoming);
    try {
      controller.abort();
      expect(await reading).toEqual({ kind: 'unavailable' });
      await service.close();
      await service.close();
      expect(adapter.close).toHaveBeenCalledOnce();
    } finally {
      finish({ kind: 'authenticated', session: session() });
    }
    await Promise.resolve();
    expect(service.current(incoming)).toEqual({ kind: 'unavailable' });
    expect(await service.authenticate(request())).toEqual({
      kind: 'unavailable',
    });
    expect((await service.handle(request(), '/logout')).status).toBe(503);
  });

  test('keeps exact issuer/subject identity stable across display, email and session changes', async () => {
    const adapter = provider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    const first = await service.authenticate(request());
    const next = session();
    next.displayName = 'Renamed Person';
    next.contacts = [];
    next.sessionId = 'second-device-session';
    vi.mocked(adapter.authenticate).mockResolvedValue({
      kind: 'authenticated',
      session: next,
    });
    const second = await service.authenticate(request());
    expect(first.kind).toBe('authenticated');
    expect(second.kind).toBe('authenticated');
    if (first.kind !== 'authenticated' || second.kind !== 'authenticated')
      throw new Error('fixture authentication failed');
    expect(second.principal.id).toBe(first.principal.id);
    expect(second.principal.display).toBe('Renamed Person');
    expect(second.principal.id).not.toContain('person@example.test');
    expect(second.principal.id).not.toBe('human:local:operator');
  });

  test('keeps equal contacts on different issuers or subjects separate', async () => {
    const a = provider();
    const b = provider();
    b.issuer = 'urn:station:another-authority';
    const c = provider({
      kind: 'authenticated',
      session: session('another-person'),
    });
    const results = await Promise.all(
      [a, b, c].map((adapter) =>
        new DeploymentAuthenticationService(adapter, () => now).authenticate(
          request(),
        ),
      ),
    );
    const principals = results.map((result) => {
      if (result.kind !== 'authenticated')
        throw new Error('fixture authentication failed');
      return result.principal.id;
    });
    expect(new Set(principals).size).toBe(3);
  });

  test.each([
    { kind: 'absent' },
    { kind: 'invalid', reason: 'invalid-credential' },
    { kind: 'invalid', reason: 'revoked' },
    { kind: 'invalid', reason: 'conflicting-identity' },
    { kind: 'unavailable' },
  ] satisfies DeploymentAuthenticationResult[])(
    'preserves the $kind outcome without operator fallback',
    async (result) => {
      const service = new DeploymentAuthenticationService(
        provider(result),
        () => now,
      );
      expect(
        await service.authenticate(
          request(result.kind === 'absent' ? '' : 'fixture_account=valid'),
        ),
      ).toEqual(result);
    },
  );

  test('rechecks account/session state for each request and refuses expiry at the boundary', async () => {
    const adapter = provider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    expect((await service.authenticate(request())).kind).toBe('authenticated');
    vi.mocked(adapter.authenticate).mockResolvedValue({
      kind: 'invalid',
      reason: 'revoked',
    });
    expect(await service.authenticate(request())).toEqual({
      kind: 'invalid',
      reason: 'revoked',
    });
    vi.mocked(adapter.authenticate).mockResolvedValue({
      kind: 'authenticated',
      session: { ...session(), expiresAt: new Date(now).toISOString() },
    });
    expect(await service.authenticate(request())).toEqual({
      kind: 'invalid',
      reason: 'expired',
    });
    expect(adapter.authenticate).toHaveBeenCalledTimes(3);
  });

  test('pending enrollment stays outside generic request authentication and verifies the exact provider attempt', async () => {
    const { adapter, pending, result } = pendingProvider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    expect(service.pendingEnrollmentCapabilities()).toEqual({
      available: true,
    });
    const incoming = new Request(
      'https://station.example.test/enrollment/login',
      {
        method: 'POST',
        headers: {
          Origin: 'https://client.example.test',
          'Content-Type': 'application/json',
          Cookie: 'fixture_account=must-not-adopt',
          Authorization: 'Bearer existing-device-credential',
          'X-Station-Account-Continuation': 'existing-continuation',
          'X-Station-Account-Proof': 'existing-proof',
        },
        body: '{}',
      },
    );
    expect(
      await service.createPendingEnrollment('A'.repeat(43), incoming),
    ).toEqual(result);
    const createRequest = vi.mocked(pending.create).mock.calls[0]?.[1];
    expect(createRequest?.headers.get('Cookie')).toBeNull();
    expect(createRequest?.headers.get('Authorization')).toBeNull();
    expect(createRequest?.headers.get('Origin')).toBe(
      'https://client.example.test',
    );
    expect(
      createRequest?.headers.get('X-Station-Account-Continuation'),
    ).toBeNull();
    expect(createRequest?.headers.get('X-Station-Account-Proof')).toBeNull();
    expect(adapter.authenticate).not.toHaveBeenCalled();
    expect(adapter.sessionReferences?.verify).not.toHaveBeenCalled();
    expect(service.current(request())).toBeUndefined();
    expect(
      await service.verifyPendingEnrollment(
        'A'.repeat(43),
        'pending-session-record',
        new AbortController().signal,
      ),
    ).toEqual(result);
    expect(pending.verify).toHaveBeenCalledWith(
      'A'.repeat(43),
      'pending-session-record',
      expect.any(AbortSignal),
    );

    vi.mocked(pending.verify).mockResolvedValueOnce({
      ...result,
      session: { ...result.session, enrollmentId: 'B'.repeat(43) },
    });
    expect(
      await service.verifyPendingEnrollment(
        'A'.repeat(43),
        'pending-session-record',
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'invalid', reason: 'conflicting-identity' });
  });

  test('pending-session promotion reports a commit that settles after caller abort', async () => {
    const { adapter, pending } = pendingProvider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    let committed!: () => void;
    const promotion = new Promise<void>((resolve) => {
      committed = resolve;
    });
    vi.mocked(pending.promote).mockReturnValue(promotion);
    const controller = new AbortController();
    const result = service.promotePendingEnrollment(
      'A'.repeat(43),
      'pending-session-record',
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    committed();
    await expect(result).resolves.toBeUndefined();
  });

  test('pending-session discard reports settled cleanup after caller abort', async () => {
    const { adapter, pending } = pendingProvider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    let committed!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      committed = resolve;
    });
    vi.mocked(pending.discard).mockReturnValue(cleanup);
    const controller = new AbortController();
    const result = service.discardPendingEnrollment(
      'A'.repeat(43),
      'pending-session-record',
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    committed();
    await expect(result).resolves.toBeUndefined();
  });

  test('generic session revocation reports provider commit after caller abort', async () => {
    const { adapter } = pendingProvider();
    const revoke = vi.fn();
    adapter.sessionReferences!.revoke = revoke;
    const service = new DeploymentAuthenticationService(adapter, () => now);
    let committed!: () => void;
    const revocation = new Promise<void>((resolve) => {
      committed = resolve;
    });
    vi.mocked(revoke).mockReturnValue(revocation);
    const controller = new AbortController();
    const result = service.revokeSessionReference(
      'pending-session-record',
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    committed();
    await expect(result).resolves.toBeUndefined();
  });

  test('treats provider exceptions, malformed results and authority-bearing claims as unavailable', async () => {
    const adapter = provider();
    const service = new DeploymentAuthenticationService(adapter, () => now);
    vi.mocked(adapter.authenticate).mockRejectedValueOnce(
      new Error('SECRET_CALLBACK_TOKEN'),
    );
    expect(await service.authenticate(request())).toEqual({
      kind: 'unavailable',
    });
    for (const value of [
      { kind: 'authenticated', session: { ...session(), operator: true } },
      { kind: 'authenticated', session: { ...session(), subject: '' } },
      {
        kind: 'authenticated',
        session: {
          ...session(),
          contacts: [{ kind: 'email', value: 'person@example.test' }],
        },
      },
      { kind: 'absent', principal: 'human:local:operator' },
      { kind: 'invalid', reason: 'provider-invented-outcome' },
    ]) {
      vi.mocked(adapter.authenticate).mockResolvedValue(
        value as unknown as DeploymentAuthenticationResult,
      );
      expect(await service.authenticate(request())).toEqual({
        kind: 'unavailable',
      });
    }
  });

  test('captures provider metadata and returns detached session data', async () => {
    const value = session();
    const adapter = provider({ kind: 'authenticated', session: value });
    const service = new DeploymentAuthenticationService(adapter, () => now);
    const description = service.describe();
    description.issuer = 'https://changed.example.test';
    adapter.issuer = 'https://another.example.test';
    const result = await service.authenticate(request());
    value.contacts = [];
    value.subject = 'changed';
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated')
      throw new Error('fixture authentication failed');
    expect(result.issuer).toBe('https://identity.example.test');
    expect(result.session.subject).toBe('opaque-person');
    expect(result.session.contacts).toHaveLength(1);
  });

  test('refuses unsupported contracts and endpoint ambiguity at setup', () => {
    const unknown = {
      ...provider(),
      version: 'station.authentication/v2',
    } as unknown as DeploymentAuthenticationProvider;
    expect(() => new DeploymentAuthenticationService(unknown)).toThrow(
      'Unsupported',
    );
    expect(
      () =>
        new DeploymentAuthenticationService({ ...provider(), endpoints: [] }),
    ).toThrow('logout');
    const duplicate = provider();
    duplicate.endpoints = [...duplicate.endpoints, ...duplicate.endpoints];
    expect(() => new DeploymentAuthenticationService(duplicate)).toThrow(
      'endpoint method',
    );
  });
});
