import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { serializeSignedCookie } from 'better-call';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeploymentAuthenticationService } from '../deployment-authentication-service.js';
import {
  createLocalAccountProvider,
  type LocalAccountEmail,
} from '../local-account-provider.js';

const roots: string[] = [];
const services: DeploymentAuthenticationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const origin = 'https://station.example.test';
const basePath = '/api/account-auth';
const password = 'Local fixture password 12345';
async function harness(
  mode: 'email-password' | 'username-password' = 'email-password',
  existingStateDirectory?: string,
  testHooks?: {
    beforePendingSessionCreate?: (enrollmentId: string) => Promise<void>;
  },
) {
  const stateDirectory =
    existingStateDirectory ??
    (await mkdtemp(join(tmpdir(), 'station-local-account-')));
  if (!existingStateDirectory) roots.push(stateDirectory);
  const mail: LocalAccountEmail[] = [];
  const secret = randomBytes(32).toString('hex');
  const provider = await createLocalAccountProvider(
    {
      stationId: 'local-account-test',
      publicOrigin: origin,
      stateDirectory,
      basePath,
    },
    secret,
    {
      mayRegister: async ({ invitation, email }) =>
        invitation === 'valid-invitation' &&
        (mode === 'username-password' || email === 'invitee@example.test'),
      deliver: async (message) => {
        mail.push(message);
      },
    },
    mode,
    [],
    testHooks,
  );
  const service = new DeploymentAuthenticationService(provider);
  services.push(service);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    service.handle(
      new Request(`${origin}${basePath}${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      }),
      path,
    );
  return {
    service,
    provider,
    mail,
    post,
    administration: provider.administration,
    stateDirectory,
    secret,
  };
}

function usernameLoginRequest(username: string, signal?: AbortSignal): Request {
  return new Request(`${origin}${basePath}/pending-enrollment-login`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
    signal,
  });
}

function readAccountSession(
  stateDirectory: string,
  sessionId: string,
): { token: string; pendingEnrollmentId: string | null } | undefined {
  const database = new DatabaseSync(
    join(stateDirectory, 'local-accounts.sqlite'),
  );
  try {
    const row = database
      .prepare(
        'SELECT token, stationPendingEnrollmentId FROM session WHERE id = ?',
      )
      .get(sessionId);
    if (typeof row?.token !== 'string') return undefined;
    return {
      token: row.token,
      pendingEnrollmentId:
        typeof row.stationPendingEnrollmentId === 'string'
          ? row.stationPendingEnrollmentId
          : null,
    };
  } finally {
    database.close();
  }
}

function countPendingSessions(
  stateDirectory: string,
  enrollmentId: string,
): number {
  const database = new DatabaseSync(
    join(stateDirectory, 'local-accounts.sqlite'),
  );
  try {
    return Number(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM session WHERE stationPendingEnrollmentId = ?',
        )
        .get(enrollmentId)?.count,
    );
  } finally {
    database.close();
  }
}

async function usernameHarness(testHooks?: {
  beforePendingSessionCreate?: (enrollmentId: string) => Promise<void>;
}) {
  const fixture = await harness('username-password', undefined, testHooks);
  const registered = await fixture.post(
    '/sign-up/username',
    { username: 'markeruser', password, name: 'Marker User' },
    { 'x-station-invitation': 'valid-invitation' },
  );
  expect(registered.status, await registered.clone().text()).toBe(200);
  return fixture;
}

function localAccountCookieRequest(
  provider: Awaited<ReturnType<typeof createLocalAccountProvider>>,
  stateDirectory: string,
  sessionId: string,
  secret: string,
): Promise<Request> {
  const row = readAccountSession(stateDirectory, sessionId);
  if (!row) throw new Error('Expected a persisted local-account session.');
  return serializeSignedCookie(
    provider.sessionCookies[0]!,
    row.token,
    secret,
  ).then((serialized) => {
    const cookie = serialized.split(';', 1)[0];
    return new Request(`${origin}${basePath}/session`, {
      headers: { Cookie: cookie },
    });
  });
}

function accountRequest(response: Response): Request {
  expect(response.status).toBe(200);
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  expect(cookies).toContain('session_token=');
  return new Request(`${origin}/api/account-auth/session`, {
    headers: { Cookie: cookies },
  });
}

describe('maintained Station-local email/password provider', () => {
  test('requires invitation eligibility and a separate delivered email verification before password sign-in', async () => {
    const { service, mail, post } = await harness();
    const user = { email: 'invitee@example.test', name: 'Invitee', password };
    const denied = await post('/sign-up/email', user);
    expect(denied.status).toBe(403);
    expect(mail).toHaveLength(0);

    const registered = await post('/sign-up/email', user, {
      'x-station-invitation': 'valid-invitation',
    });
    expect(registered.status, await registered.clone().text()).toBe(200);
    expect(registered.headers.get('set-cookie') ?? '').not.toContain(
      'session_token',
    );
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      kind: 'verify-email',
      recipient: 'invitee@example.test',
    });
    const premature = await post('/sign-in/email', {
      email: user.email,
      password,
    });
    expect(premature.status).toBe(403);
    const verification = await service.handle(
      new Request(mail[0]!.url),
      '/verify-email',
    );
    expect(
      verification.ok || verification.status === 302,
      await verification.clone().text(),
    ).toBe(true);
    const signedIn = await post('/sign-in/email', {
      email: user.email,
      password,
    });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    expect(await signedIn.clone().json()).toEqual({ success: true });
    const cookies = signedIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    expect(cookies).toContain('session_token=');
    const request = new Request(`${origin}/api/account-auth/session`, {
      headers: { Cookie: cookies },
    });
    const principal = await service.authenticate(request);
    expect(principal.kind).toBe('authenticated');
    if (principal.kind !== 'authenticated')
      throw new Error('Verified local account did not authenticate');
    expect(principal.session.contacts[0]?.value).toBe(user.email);
    expect(principal.principal.id).not.toContain(user.email);
    expect((await post('/sign-out', {}, { Cookie: cookies })).ok).toBe(true);
    expect((await service.authenticate(request)).kind).toBe('invalid');
  });

  test('never exposes the maintained library admin surface through the provider', async () => {
    const { post } = await harness();
    expect(
      (
        await post('/admin/create-user', {
          email: 'outsider@example.test',
          password,
          name: 'Outsider',
        })
      ).status,
    ).toBe(404);
  });

  test('password recovery consumes the delivered token once and revokes existing sessions', async () => {
    const { service, post, mail } = await harness();
    const login = { email: 'invitee@example.test', password };
    expect(
      (
        await post(
          '/sign-up/email',
          { ...login, name: 'Invitee' },
          { 'x-station-invitation': 'valid-invitation' },
        )
      ).ok,
    ).toBe(true);
    const verified = await service.handle(
      new Request(mail[0]!.url),
      '/verify-email',
    );
    expect(verified.status).toBe(302);
    const old = accountRequest(await post('/sign-in/email', login));
    expect((await service.authenticate(old)).kind).toBe('authenticated');
    expect(
      (await post('/request-password-reset', { email: login.email })).ok,
    ).toBe(true);
    const recovery = mail.find((message) => message.kind === 'reset-password');
    expect(recovery?.recipient).toBe(login.email);
    const token = new URLSearchParams(new URL(recovery!.url).hash.slice(1)).get(
      'token',
    );
    expect(token).toBeTruthy();
    const newPassword = 'Replacement fixture password 67890';
    expect((await post('/reset-password', { token, newPassword })).ok).toBe(
      true,
    );
    expect((await service.authenticate(old)).kind).toBe('invalid');
    expect((await post('/reset-password', { token, newPassword })).ok).toBe(
      false,
    );
    const fresh = accountRequest(
      await post('/sign-in/email', {
        email: login.email,
        password: newPassword,
      }),
    );
    expect((await service.authenticate(fresh)).kind).toBe('authenticated');
    expect((await post('/sign-in/email', login)).ok).toBe(false);
  });

  test('operator policy revokes every account session and disabling/re-enabling never revives old credentials', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, post, mail, administration } = await harness();
    const login = { email: 'invitee@example.test', password };
    expect(
      (
        await post(
          '/sign-up/email',
          { ...login, name: 'Invitee' },
          { 'x-station-invitation': 'valid-invitation' },
        )
      ).ok,
    ).toBe(true);
    const verified = await service.handle(
      new Request(mail[0]!.url),
      '/verify-email',
    );
    expect(verified.status, await verified.clone().text()).toBe(302);
    expect(verified.headers.get('location')).toBe('/');
    const first = accountRequest(await post('/sign-in/email', login));
    const second = accountRequest(await post('/sign-in/email', login));
    const initial = await service.authenticate(first);
    const other = await service.authenticate(second);
    if (initial.kind !== 'authenticated' || other.kind !== 'authenticated')
      throw new Error('Local account setup failed');
    expect(initial.principal.id).toBe(other.principal.id);
    expect(administration.list()).toEqual([
      {
        accountId: initial.session.subject,
        name: 'Invitee',
        email: login.email,
        emailVerified: true,
        disabled: false,
      },
    ]);
    administration.revokeSessions(initial.session.subject);
    expect((await service.authenticate(first)).kind).toBe('invalid');
    expect((await service.authenticate(second)).kind).toBe('invalid');
    vi.setSystemTime(Date.now() + 11_000);
    const fresh = accountRequest(await post('/sign-in/email', login));
    expect((await service.authenticate(fresh)).kind).toBe('authenticated');
    administration.setDisabled(initial.session.subject, true);
    expect((await service.authenticate(fresh)).kind).toBe('invalid');
    const disabledLogin = await post('/sign-in/email', login);
    expect(disabledLogin.ok).toBe(false);
    expect(disabledLogin.status).not.toBe(429);
    expect(administration.list()[0]?.disabled).toBe(true);
    // The maintained library allows three sign-in attempts per ten seconds.
    // A later legitimate retry must cross that window, not disable its limit.
    vi.setSystemTime(Date.now() + 11_000);
    administration.setDisabled(initial.session.subject, false);
    expect((await service.authenticate(fresh)).kind).toBe('invalid');
    expect((await service.authenticate(first)).kind).toBe('invalid');
    vi.setSystemTime(Date.now() + 1);
    const replacement = accountRequest(await post('/sign-in/email', login));
    expect((await service.authenticate(replacement)).kind).toBe(
      'authenticated',
    );
  });

  test('provider-owned pending enrollment stays outside generic session authority until promoted', async () => {
    const emailProvider = await harness();
    expect(
      emailProvider.provider.sessionReferences?.pendingEnrollment,
    ).toBeUndefined();

    const fixture = await usernameHarness();
    const pending = fixture.provider.sessionReferences?.pendingEnrollment;
    if (!pending || !fixture.provider.sessionReferences?.verify)
      throw new Error('Username provider did not expose pending enrollment.');

    const publicLogin = await fixture.post(
      '/sign-in/username',
      {
        username: 'markeruser',
        password,
        stationPendingEnrollmentId: 'attacker-body-marker',
      },
      { 'x-station-pending-enrollment-id': 'attacker-header-marker' },
    );
    expect(publicLogin.status, await publicLogin.clone().text()).toBe(200);
    const publicCookies = publicLogin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const ordinary = await fixture.provider.authenticate(
      new Request(`${origin}${basePath}/session`, {
        headers: { Cookie: publicCookies },
      }),
    );
    expect(ordinary.kind).toBe('authenticated');
    if (ordinary.kind !== 'authenticated')
      throw new Error('Public local username login did not authenticate.');
    expect(
      readAccountSession(fixture.stateDirectory, ordinary.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBeNull();

    const enrollmentId = 'enrollment-attempt-0001';
    const created = await pending.create(
      enrollmentId,
      usernameLoginRequest('markeruser'),
    );
    expect(created.kind).toBe('pending');
    if (created.kind !== 'pending')
      throw new Error('Expected a provider-owned pending session.');
    expect(created.session).toMatchObject({ enrollmentId });
    expect(created.session).not.toHaveProperty('token');
    expect(
      readAccountSession(fixture.stateDirectory, created.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBe(enrollmentId);
    expect(
      await fixture.provider.sessionReferences.verify(
        created.session.sessionId,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'invalid', reason: 'revoked' });
    const pendingCookieRequest = await localAccountCookieRequest(
      fixture.provider,
      fixture.stateDirectory,
      created.session.sessionId,
      fixture.secret,
    );
    expect(
      (await fixture.provider.authenticate(pendingCookieRequest)).kind,
    ).toBe('invalid');
    expect(
      await pending.verify(
        enrollmentId,
        created.session.sessionId,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'pending', session: created.session });

    const abortedPromotion = new AbortController();
    abortedPromotion.abort(new Error('cancel before promotion commit'));
    await expect(
      pending.promote(
        enrollmentId,
        created.session.sessionId,
        abortedPromotion.signal,
      ),
    ).rejects.toThrow('Pending enrollment promotion is unavailable.');
    expect(
      readAccountSession(fixture.stateDirectory, created.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBe(enrollmentId);

    const promotionSignal = new AbortController();
    await pending.promote(
      enrollmentId,
      created.session.sessionId,
      promotionSignal.signal,
    );
    promotionSignal.abort(new Error('cancel after promotion commit'));
    expect(
      readAccountSession(fixture.stateDirectory, created.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBeNull();
    expect(
      (
        await fixture.provider.sessionReferences.verify(
          created.session.sessionId,
          new AbortController().signal,
        )
      ).kind,
    ).toBe('authenticated');
    expect(
      (await fixture.provider.authenticate(pendingCookieRequest)).kind,
    ).toBe('authenticated');
    expect(
      await pending.create(enrollmentId, usernameLoginRequest('markeruser')),
    ).toEqual({ kind: 'invalid', reason: 'conflicting-identity' });
    expect(
      await pending.verify(
        enrollmentId,
        created.session.sessionId,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'invalid', reason: 'revoked' });
    await pending.discard(
      enrollmentId,
      created.session.sessionId,
      new AbortController().signal,
    );
    expect(
      (await fixture.provider.authenticate(pendingCookieRequest)).kind,
    ).toBe('authenticated');

    const discardedId = 'enrollment-attempt-discard';
    const discarded = await pending.create(
      discardedId,
      usernameLoginRequest('markeruser'),
    );
    expect(discarded.kind).toBe('pending');
    if (discarded.kind !== 'pending')
      throw new Error('Expected a second provider-owned pending session.');
    await expect(
      pending.discard(
        discardedId,
        'wrong-pending-session-id',
        new AbortController().signal,
      ),
    ).rejects.toThrow('Pending enrollment cleanup is unconfirmed.');
    expect(
      readAccountSession(fixture.stateDirectory, discarded.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBe(discardedId);
    await pending.discard(
      discardedId,
      discarded.session.sessionId,
      new AbortController().signal,
    );
    expect(
      readAccountSession(fixture.stateDirectory, discarded.session.sessionId),
    ).toBeUndefined();
    expect(
      await pending.create(discardedId, usernameLoginRequest('markeruser')),
    ).toEqual({ kind: 'invalid', reason: 'conflicting-identity' });

    const deleteFailureId = 'enrollment-attempt-delete-failure';
    const deleteFailure = await pending.create(
      deleteFailureId,
      usernameLoginRequest('markeruser'),
    );
    expect(deleteFailure.kind).toBe('pending');
    if (deleteFailure.kind !== 'pending')
      throw new Error('Expected a pending session for delete-failure test.');
    const triggerDb = new DatabaseSync(
      join(fixture.stateDirectory, 'local-accounts.sqlite'),
    );
    try {
      triggerDb.exec(`CREATE TRIGGER fail_pending_cleanup
        BEFORE DELETE ON session
        WHEN OLD.stationPendingEnrollmentId = '${deleteFailureId}'
        BEGIN SELECT RAISE(ABORT, 'injected pending cleanup failure'); END`);
      await expect(
        pending.discard(
          deleteFailureId,
          deleteFailure.session.sessionId,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Pending enrollment cleanup is unconfirmed.');
    } finally {
      triggerDb.exec('DROP TRIGGER IF EXISTS fail_pending_cleanup');
      triggerDb.close();
    }
    expect(countPendingSessions(fixture.stateDirectory, deleteFailureId)).toBe(
      1,
    );
    await pending.discard(
      deleteFailureId,
      deleteFailure.session.sessionId,
      new AbortController().signal,
    );
    expect(countPendingSessions(fixture.stateDirectory, deleteFailureId)).toBe(
      0,
    );
  });

  test('concurrent pending logins keep their ALS identities and discard wins over an in-flight verify', async () => {
    const fixture = await usernameHarness();
    const pending = fixture.provider.sessionReferences?.pendingEnrollment;
    if (!pending)
      throw new Error('Username provider lacks pending enrollment.');
    const enrollmentA = 'enrollment-attempt-parallel-a';
    const enrollmentB = 'enrollment-attempt-parallel-b';
    const [createdA, createdB] = await Promise.all([
      pending.create(enrollmentA, usernameLoginRequest('markeruser')),
      pending.create(enrollmentB, usernameLoginRequest('markeruser')),
    ]);
    expect(createdA.kind).toBe('pending');
    expect(createdB.kind).toBe('pending');
    if (createdA.kind !== 'pending' || createdB.kind !== 'pending')
      throw new Error('Concurrent pending local logins did not complete.');
    expect(
      readAccountSession(fixture.stateDirectory, createdA.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBe(enrollmentA);
    expect(
      readAccountSession(fixture.stateDirectory, createdB.session.sessionId)
        ?.pendingEnrollmentId,
    ).toBe(enrollmentB);

    const verification = pending.verify(
      enrollmentA,
      createdA.session.sessionId,
      new AbortController().signal,
    );
    const discard = pending.discard(
      enrollmentA,
      createdA.session.sessionId,
      new AbortController().signal,
    );
    const [verified] = await Promise.all([verification, discard]);
    expect(verified.kind).toBe('invalid');
    expect(
      readAccountSession(fixture.stateDirectory, createdA.session.sessionId),
    ).toBeUndefined();
    expect(
      await pending.verify(
        enrollmentB,
        createdB.session.sessionId,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'pending', session: createdB.session });
    const genericAuthentication = fixture.provider.authenticate(
      await localAccountCookieRequest(
        fixture.provider,
        fixture.stateDirectory,
        createdB.session.sessionId,
        fixture.secret,
      ),
    );
    const discardB = pending.discard(
      enrollmentB,
      createdB.session.sessionId,
      new AbortController().signal,
    );
    const [authentication] = await Promise.all([
      genericAuthentication,
      discardB,
    ]);
    expect(authentication.kind).toBe('invalid');
    expect(
      readAccountSession(fixture.stateDirectory, createdB.session.sessionId),
    ).toBeUndefined();
  });

  test('discard joins aborted late creates, reports timeout, and startup sweeps pending sessions', async () => {
    function barrier() {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { entered, enter, release, waiting };
    }
    const abortAttempt = 'enrollment-attempt-after-abort';
    const timeoutAttempt = 'enrollment-attempt-cleanup-timeout';
    const abortBarrier = barrier();
    const timeoutBarrier = barrier();
    const barriers = new Map([
      [abortAttempt, abortBarrier],
      [timeoutAttempt, timeoutBarrier],
    ]);
    const fixture = await usernameHarness({
      beforePendingSessionCreate: async (enrollmentId) => {
        const current = barriers.get(enrollmentId);
        if (!current) return;
        current.enter();
        await current.waiting;
      },
    });
    const pending = fixture.provider.sessionReferences?.pendingEnrollment;
    if (!pending)
      throw new Error('Username provider lacks pending enrollment.');
    const controller = new AbortController();
    const creation = pending.create(
      abortAttempt,
      usernameLoginRequest('markeruser', controller.signal),
    );
    await abortBarrier.entered;
    controller.abort(new Error('caller aborted after session creation'));
    expect(await creation).toEqual({ kind: 'unavailable' });
    let discardSettled = false;
    const abortDiscard = pending
      .discard(abortAttempt, undefined, new AbortController().signal)
      .then(() => {
        discardSettled = true;
      });
    await Promise.resolve();
    expect(discardSettled).toBe(false);
    abortBarrier.release();
    await abortDiscard;
    expect(countPendingSessions(fixture.stateDirectory, abortAttempt)).toBe(0);

    const timedCreation = pending.create(
      timeoutAttempt,
      usernameLoginRequest('markeruser'),
    );
    await timeoutBarrier.entered;
    await expect(
      pending.discard(timeoutAttempt, undefined, new AbortController().signal),
    ).rejects.toThrow('Pending enrollment cleanup is unconfirmed.');
    timeoutBarrier.release();
    expect(await timedCreation).toEqual({ kind: 'unavailable' });
    expect(countPendingSessions(fixture.stateDirectory, timeoutAttempt)).toBe(
      0,
    );

    const restartId = 'enrollment-attempt-crash-reopen';
    const beforeRestart = await pending.create(
      restartId,
      usernameLoginRequest('markeruser'),
    );
    expect(beforeRestart.kind).toBe('pending');
    if (beforeRestart.kind !== 'pending')
      throw new Error('Expected a pending session before provider restart.');
    await fixture.service.close();
    const reopened = await harness('username-password', fixture.stateDirectory);
    expect(
      readAccountSession(
        reopened.stateDirectory,
        beforeRestart.session.sessionId,
      ),
    ).toBeUndefined();
    const reopenedPending =
      reopened.provider.sessionReferences?.pendingEnrollment;
    if (!reopenedPending)
      throw new Error('Reopened username provider lacks pending enrollment.');
    expect(
      await reopenedPending.verify(
        restartId,
        beforeRestart.session.sessionId,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'invalid', reason: 'revoked' });
  }, 30_000);
});
