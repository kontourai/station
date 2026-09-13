import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
async function harness() {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), 'station-local-account-'),
  );
  roots.push(stateDirectory);
  const mail: LocalAccountEmail[] = [];
  const provider = await createLocalAccountProvider(
    {
      stationId: 'local-account-test',
      publicOrigin: origin,
      stateDirectory,
      basePath,
    },
    randomBytes(32).toString('hex'),
    {
      mayRegister: async ({ invitation, email }) =>
        invitation === 'valid-invitation' && email === 'invitee@example.test',
      deliver: async (message) => {
        mail.push(message);
      },
    },
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
  return { service, mail, post, administration: provider.administration };
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
});
