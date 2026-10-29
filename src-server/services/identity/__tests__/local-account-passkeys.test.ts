/**
 * #4303: member passkeys through the production local-account composition
 * (`loadLocalAccounts`) behind the real `/api/account-auth` route owner.
 * The software authenticator produces real WebAuthn bytes, so every accepted
 * ceremony passed the maintained plugin's verification, not a stub.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SoftwareAuthenticator } from '../../../__test-utils__/software-authenticator.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createDeploymentAuthenticationRoutes } from '../../../routes/system/deployment-authentication-routes.js';
import { createLogger } from '../../../utils/logger.js';
import { FeaturePreviewRegistry } from '../../feature-previews/feature-preview-registry.js';
import {
  MEMBER_PASSKEYS_PREVIEW_ID,
  PASSKEY_ADD_FRESHNESS_MS,
} from '../local-account-passkeys.js';
import {
  type LoadedLocalAccounts,
  loadLocalAccounts,
} from '../local-account-runtime.js';

// Registered first, so its after-hook removes the homes after the account
// stores below have closed.
const makeTempDir = trackTempDirs();
const loaded: LoadedLocalAccounts[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const accounts of loaded.splice(0)) await accounts.service.close();
});

const ORIGIN = 'https://station.example.test';
const INVITATION = 'pending-invitation-0123456789';

/** One browser: a cookie jar that honours Set-Cookie and expiry. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(readonly origin: string) {}
  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
  receive(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      const expired = attributes.some((attribute) =>
        /^\s*max-age=0\s*$/i.test(attribute),
      );
      if (expired || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function station(
  input: {
    origin?: string;
    stationId?: string;
    invitations?: Set<string>;
    /** The member-passkeys Feature Preview choice; on unless a test says off. */
    preview?: boolean;
    /** Other approved application origins (ALLOWED_ORIGINS). */
    allowedBrowserOrigins?: string[];
  } = {},
) {
  const origin = input.origin ?? ORIGIN;
  const homeDirectory = makeTempDir('station-passkeys-');
  const invitations = input.invitations ?? new Set([INVITATION]);
  // The production registry, bound with the definition the runtime binds.
  const previews = new FeaturePreviewRegistry(
    homeDirectory,
    createLogger({ name: 'member-passkeys-test', level: 'error' }),
  );
  const preview = previews.bind({
    id: MEMBER_PASSKEYS_PREVIEW_ID,
    label: 'Member passkeys',
    description: 'Member passkeys under test.',
  });
  if (input.preview !== false)
    await previews.setEnabled(MEMBER_PASSKEYS_PREVIEW_ID, true);
  const accounts = await loadLocalAccounts(
    {
      publicOrigin: origin,
      ...(input.allowedBrowserOrigins
        ? { allowedBrowserOrigins: [origin, ...input.allowedBrowserOrigins] }
        : {}),
    },
    { stationId: input.stationId ?? 'passkey-station', homeDirectory },
    { mayRegister: async ({ invitation }) => invitations.has(invitation) },
    { memberPasskeys: preview },
  );
  loaded.push(accounts);
  const app = new Hono();
  app.route(
    '/api/account-auth',
    createDeploymentAuthenticationRoutes(accounts),
  );

  async function call(
    browser: Browser,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const cookie = browser.header();
    const response = await app.request(`${origin}/api/account-auth${path}`, {
      method: 'POST',
      headers: {
        Origin: browser.origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    browser.receive(response);
    const json = (await response.json()) as {
      data?: Record<string, unknown>;
      error?: { code: string };
    };
    return { ...json, status: response.status };
  }

  async function session(browser: Browser) {
    const response = await app.request(`${origin}/api/account-auth/session`, {
      headers: { Cookie: browser.header() },
    });
    return response.status === 200
      ? (
          (await response.json()) as {
            data: { principal: { id: string }; issuer: string };
          }
        ).data
      : undefined;
  }

  /** The verified provider session behind a browser's account cookie. */
  async function verified(browser: Browser) {
    const result = await accounts.service.authenticate(
      new Request(origin, { headers: { Cookie: browser.header() } }),
    );
    return result;
  }

  return {
    origin,
    accounts,
    app,
    call,
    session,
    verified,
    invitations,
    previews,
  };
}
type Station = Awaited<ReturnType<typeof station>>;

/** A software authenticator with a monotonically increasing sign counter. */
class Device {
  readonly authenticator = new SoftwareAuthenticator();
  counter = 0;
  register(
    options: Record<string, unknown>,
    origin: string,
    overrides: { userVerified?: boolean; rpId?: string } = {},
  ) {
    return this.authenticator.register(
      options as { challenge: string; rp: { id?: string } },
      { origin, ...overrides },
    );
  }
  assert(
    options: Record<string, unknown>,
    origin: string,
    overrides: { userVerified?: boolean; rpId?: string } = {},
  ) {
    this.counter += 1;
    return this.authenticator.authenticate(
      options as { challenge: string; rpId?: string },
      { origin, counter: this.counter, ...overrides },
    );
  }
}

async function signUp(
  target: Station,
  browser: Browser,
  device: Device,
  username: string,
  invitation = INVITATION,
) {
  const headers = { 'x-station-invitation': invitation };
  const options = await target.call(
    browser,
    '/passkey/sign-up',
    { step: 'options', username },
    headers,
  );
  expect(options.status, JSON.stringify(options)).toBe(200);
  const response = device.register(
    options.data!.options as Record<string, unknown>,
    target.origin,
  );
  return target.call(
    browser,
    '/passkey/sign-up',
    { step: 'verify', response },
    headers,
  );
}

async function signIn(
  target: Station,
  browser: Browser,
  device: Device,
  overrides: { origin?: string; userVerified?: boolean; rpId?: string } = {},
) {
  const options = await target.call(browser, '/passkey/sign-in', {
    step: 'options',
  });
  expect(options.status, JSON.stringify(options)).toBe(200);
  const { origin = target.origin, ...rest } = overrides;
  const response = device.assert(
    options.data!.options as Record<string, unknown>,
    origin,
    rest,
  );
  return target.call(browser, '/passkey/sign-in', {
    step: 'verify',
    response,
  });
}

function accountId(target: Station, username: string): string {
  const account = target.accounts.administration
    .list()
    .find((entry) => entry.username === username);
  if (!account) throw new Error(`no account ${username}`);
  return account.accountId;
}

describe('member passkeys over the production account routes', () => {
  test('the descriptor advertises the six passkey operations as POST endpoints', async () => {
    const target = await station();
    const response = await target.app.request(`${ORIGIN}/api/account-auth`);
    const descriptor = (await response.json()) as {
      data: {
        endpoints: { path: string; methods: string[]; operation: string }[];
      };
    };
    expect(
      descriptor.data.endpoints
        .filter((endpoint) => endpoint.operation.startsWith('passkey-'))
        .map((endpoint) => [
          endpoint.operation,
          endpoint.path,
          endpoint.methods,
        ]),
    ).toEqual([
      ['passkey-sign-in', '/passkey/sign-in', ['POST']],
      ['passkey-register', '/passkey/sign-up', ['POST']],
      ['passkey-add', '/passkey/add', ['POST']],
      ['passkey-recover', '/passkey/recover', ['POST']],
      ['passkey-list', '/passkey/list', ['POST']],
      ['passkey-remove', '/passkey/remove', ['POST']],
    ]);
    // The plugin's own routes are never reachable from the network.
    const raw = await target.app.request(
      `${ORIGIN}/api/account-auth/passkey/generate-register-options`,
      { headers: { Origin: ORIGIN } },
    );
    expect(raw.status).toBe(404);
  });

  test('with the member-passkeys preview off nothing is offered or answered; the choice applies without a restart', async () => {
    const target = await station({ preview: false });
    const operations = async () => {
      const response = await target.app.request(`${ORIGIN}/api/account-auth`);
      const body = (await response.json()) as {
        data: { endpoints: { operation: string }[] };
      };
      return body.data.endpoints.map((endpoint) => endpoint.operation);
    };
    const offered = await operations();
    expect(
      offered.filter((operation) => operation.startsWith('passkey-')),
    ).toEqual([]);
    // Password accounts are unaffected.
    expect(offered).toEqual(
      expect.arrayContaining(['begin-login', 'register', 'logout']),
    );
    const refusal = {
      status: 404,
      success: false,
      code: 'feature_preview_disabled',
      previewId: 'member-passkeys',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    };
    const browser = new Browser(ORIGIN);
    for (const [path, body] of [
      ['/passkey/sign-in', { step: 'options' }],
      ['/passkey/sign-up', { step: 'options', username: 'too-early' }],
      ['/passkey/add', { step: 'options' }],
      ['/passkey/recover', { step: 'options', token: 'x'.repeat(24) }],
      ['/passkey/list', {}],
      ['/passkey/remove', { id: 'any' }],
    ] as const)
      expect(
        await target.call(browser, path, body, {
          'x-station-invitation': INVITATION,
        }),
      ).toMatchObject(refusal);
    // No challenge cookie, no account.
    expect(browser.cookies.size).toBe(0);
    expect(target.accounts.administration.list()).toEqual([]);

    await target.previews.setEnabled(MEMBER_PASSKEYS_PREVIEW_ID, true);
    expect(
      (await operations()).filter((operation) =>
        operation.startsWith('passkey-'),
      ),
    ).toHaveLength(6);
    const device = new Device();
    const joined = new Browser(ORIGIN);
    expect((await signUp(target, joined, device, 'after-on')).status).toBe(200);

    // Off again: the passkey stops signing in; an existing session is an
    // ordinary account session and stays until it ends or is revoked.
    await target.previews.setEnabled(MEMBER_PASSKEYS_PREVIEW_ID, false);
    expect(
      await target.call(new Browser(ORIGIN), '/passkey/sign-in', {
        step: 'options',
      }),
    ).toMatchObject(refusal);
    expect((await target.verified(joined)).kind).toBe('authenticated');
  });

  test('an invited person creates an account with a passkey and signs in with it; the subject stays opaque', async () => {
    const target = await station();
    const joining = new Browser(ORIGIN);
    const device = new Device();
    const created = await signUp(target, joining, device, 'Passkey.Person');
    expect(created.status, JSON.stringify(created)).toBe(200);
    expect(created.data).toEqual({ success: true });
    const first = await target.session(joining);
    expect(first?.issuer).toBe('urn:station:local-accounts:passkey-station');
    expect(first?.principal.id).toMatch(/^human:deployment:[a-f0-9]{64}$/);
    // Usernames normalize exactly as the password path does.
    const id = accountId(target, 'passkey.person');
    const fresh = new Browser(ORIGIN);
    const signedIn = await signIn(target, fresh, device);
    expect(signedIn.status, JSON.stringify(signedIn)).toBe(200);
    const second = await target.session(fresh);
    expect(second?.principal.id).toBe(first?.principal.id);
    const verified = await target.verified(fresh);
    expect(verified.kind).toBe('authenticated');
    if (verified.kind !== 'authenticated') return;
    expect(verified.session.subject).toBe(id);
    expect(verified.session.subject).not.toContain('passkey.person');
  });

  test('registration needs a real pending invitation at both steps', async () => {
    const target = await station();
    const browser = new Browser(ORIGIN);
    const device = new Device();
    const missing = await target.call(browser, '/passkey/sign-up', {
      step: 'options',
      username: 'no-invite',
    });
    expect(missing).toMatchObject({
      status: 403,
      error: { code: 'invitation_required' },
    });
    const unknown = await target.call(
      browser,
      '/passkey/sign-up',
      { step: 'options', username: 'no-invite' },
      { 'x-station-invitation': 'not-a-pending-invitation-123' },
    );
    expect(unknown).toMatchObject({
      status: 403,
      error: { code: 'invitation_required' },
    });
    // Accepted, cancelled or expired between the two steps: nothing is created.
    const headers = { 'x-station-invitation': INVITATION };
    const options = await target.call(
      browser,
      '/passkey/sign-up',
      { step: 'options', username: 'late-invite' },
      headers,
    );
    expect(options.status).toBe(200);
    target.invitations.delete(INVITATION);
    const late = await target.call(
      browser,
      '/passkey/sign-up',
      {
        step: 'verify',
        response: device.register(
          options.data!.options as Record<string, unknown>,
          ORIGIN,
        ),
      },
      headers,
    );
    expect(late).toMatchObject({
      status: 403,
      error: { code: 'invitation_required' },
    });
    expect(target.accounts.administration.list()).toEqual([]);
    expect(await target.session(browser)).toBeUndefined();
  });

  test('a ceremony started under one invitation cannot finish under another', async () => {
    const other = 'second-pending-invitation-42';
    const target = await station({
      invitations: new Set([INVITATION, other]),
    });
    const browser = new Browser(ORIGIN);
    const options = await target.call(
      browser,
      '/passkey/sign-up',
      { step: 'options', username: 'swapped' },
      { 'x-station-invitation': INVITATION },
    );
    const swapped = await target.call(
      browser,
      '/passkey/sign-up',
      {
        step: 'verify',
        response: new Device().register(
          options.data!.options as Record<string, unknown>,
          ORIGIN,
        ),
      },
      { 'x-station-invitation': other },
    );
    expect(swapped.status).toBe(403);
    expect(target.accounts.administration.list()).toEqual([]);
  });

  test('a taken username is refused before the ceremony, and registration requires user verification', async () => {
    const target = await station();
    await signUp(target, new Browser(ORIGIN), new Device(), 'taken');
    const browser = new Browser(ORIGIN);
    expect(
      await target.call(
        browser,
        '/passkey/sign-up',
        { step: 'options', username: 'TAKEN' },
        { 'x-station-invitation': INVITATION },
      ),
    ).toMatchObject({ status: 409, error: { code: 'username_unavailable' } });
    const headers = { 'x-station-invitation': INVITATION };
    const options = await target.call(
      browser,
      '/passkey/sign-up',
      { step: 'options', username: 'no-uv' },
      headers,
    );
    expect(
      (options.data!.options as { authenticatorSelection: unknown })
        .authenticatorSelection,
    ).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    const unverified = await target.call(
      browser,
      '/passkey/sign-up',
      {
        step: 'verify',
        response: new Device().register(
          options.data!.options as Record<string, unknown>,
          ORIGIN,
          { userVerified: false },
        ),
      },
      headers,
    );
    expect(unverified.status).toBe(403);
    expect(
      target.accounts.administration.list().map((entry) => entry.username),
    ).toEqual(['taken']);
  });

  test('sign-in without user verification is refused', async () => {
    const target = await station();
    const device = new Device();
    await signUp(target, new Browser(ORIGIN), device, 'uv-person');
    const browser = new Browser(ORIGIN);
    expect(
      await signIn(target, browser, device, { userVerified: false }),
    ).toMatchObject({ status: 401, error: { code: 'passkey_rejected' } });
    expect(await target.session(browser)).toBeUndefined();
  });

  test('disabling the account refuses passkey sign-in and ends passkey sessions exactly like password sessions', async () => {
    const target = await station();
    const device = new Device();
    const joined = new Browser(ORIGIN);
    await signUp(target, joined, device, 'to-disable');
    const id = accountId(target, 'to-disable');
    // The synchronous commit-seam witness (isVerifiedSessionCurrent) and the
    // personal access token directory (#3586).
    const admitted = new Request(ORIGIN, {
      headers: { Cookie: joined.header() },
    });
    expect((await target.accounts.service.authenticate(admitted)).kind).toBe(
      'authenticated',
    );
    const witness = target.accounts.service.captureCurrentSession(admitted);
    expect(witness()).toBe(true);
    expect(target.accounts.accountDirectory.standing(id)).toBe('current');

    target.accounts.administration.setDisabled(id, true);
    expect(witness()).toBe(false);
    expect(target.accounts.accountDirectory.standing(id)).toBe('disabled');
    expect((await target.verified(joined)).kind).toBe('invalid');
    const browser = new Browser(ORIGIN);
    expect(await signIn(target, browser, device)).toMatchObject({
      status: 401,
      error: { code: 'passkey_rejected' },
    });
    expect(await target.session(browser)).toBeUndefined();
    // A disabled account cannot add or list credentials with an old cookie.
    expect(
      await target.call(joined, '/passkey/add', { step: 'options' }),
    ).toMatchObject({ status: 401 });
    expect(await target.call(joined, '/passkey/list', {})).toMatchObject({
      status: 401,
    });

    target.accounts.administration.setDisabled(id, false);
    expect((await signIn(target, new Browser(ORIGIN), device)).status).toBe(
      200,
    );
  });

  test('signing out everywhere ends passkey sessions; the passkey still signs in afresh', async () => {
    const target = await station();
    const device = new Device();
    const old = new Browser(ORIGIN);
    await signUp(target, old, device, 'everywhere');
    const id = accountId(target, 'everywhere');
    const admitted = new Request(ORIGIN, { headers: { Cookie: old.header() } });
    expect((await target.accounts.service.authenticate(admitted)).kind).toBe(
      'authenticated',
    );
    const witness = target.accounts.service.captureCurrentSession(admitted);
    const since = Date.now();
    target.accounts.administration.revokeSessions(id);
    expect(witness()).toBe(false);
    expect((await target.verified(old)).kind).toBe('invalid');
    expect(target.accounts.accountDirectory.standing(id, since)).toBe(
      'disabled',
    );
    // Better Auth still holds the row; Station's verdict must gate passkey
    // management, not the library's session view.
    expect(
      await target.call(old, '/passkey/add', { step: 'options' }),
    ).toMatchObject({
      status: 401,
      error: { code: 'authentication_required' },
    });
    // A session must be created strictly after the sign-out-everywhere mark.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const fresh = new Browser(ORIGIN);
    expect((await signIn(target, fresh, device)).status).toBe(200);
    expect((await target.verified(fresh)).kind).toBe('authenticated');
  });

  test('members add, list and remove passkeys; a removed passkey no longer signs in; the last sign-in method stays', async () => {
    const target = await station();
    const first = new Device();
    const browser = new Browser(ORIGIN);
    await signUp(target, browser, first, 'manager');
    const second = new Device();
    const options = await target.call(browser, '/passkey/add', {
      step: 'options',
    });
    expect(options.status, JSON.stringify(options)).toBe(200);
    expect(
      (options.data!.options as { user: { name: string } }).user.name,
    ).toBe('manager');
    const added = await target.call(browser, '/passkey/add', {
      step: 'verify',
      label: 'Work laptop',
      response: second.register(
        options.data!.options as Record<string, unknown>,
        ORIGIN,
      ),
    });
    expect(added.status, JSON.stringify(added)).toBe(200);
    const listed = await target.call(browser, '/passkey/list', {});
    const passkeys = listed.data!.passkeys as {
      id: string;
      name?: string;
      createdAt: string | null;
    }[];
    expect(passkeys).toHaveLength(2);
    expect(passkeys.map((entry) => entry.name ?? null)).toEqual([
      null,
      'Work laptop',
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/publicKey|credentialID/);

    // Another member cannot remove this member's passkey.
    const intruder = new Browser(ORIGIN);
    await signUp(target, intruder, new Device(), 'intruder');
    expect(
      await target.call(intruder, '/passkey/remove', { id: passkeys[0]!.id }),
    ).toMatchObject({ status: 404, error: { code: 'passkey_not_found' } });

    expect(
      (await target.call(browser, '/passkey/remove', { id: passkeys[0]!.id }))
        .status,
    ).toBe(200);
    expect(await signIn(target, new Browser(ORIGIN), first)).toMatchObject({
      status: 401,
      error: { code: 'passkey_rejected' },
    });
    expect((await signIn(target, new Browser(ORIGIN), second)).status).toBe(
      200,
    );
    expect(
      await target.call(browser, '/passkey/remove', { id: passkeys[1]!.id }),
    ).toMatchObject({ status: 409, error: { code: 'last_sign_in_method' } });
  });

  test('adding a passkey needs a recent sign-in', async () => {
    const target = await station();
    const browser = new Browser(ORIGIN);
    await signUp(target, browser, new Device(), 'stale');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    vi.advanceTimersByTime(PASSKEY_ADD_FRESHNESS_MS + 1_000);
    expect(
      await target.call(browser, '/passkey/add', { step: 'options' }),
    ).toMatchObject({
      status: 403,
      error: { code: 'reauthentication_required' },
    });
    // Listing is not a credential change and stays available.
    expect((await target.call(browser, '/passkey/list', {})).status).toBe(200);
  });

  test('an operator recovery link enrols a new passkey once, signs in, and ends other sessions', async () => {
    const target = await station();
    const lost = new Device();
    const old = new Browser(ORIGIN);
    await signUp(target, old, lost, 'recovering');
    const id = accountId(target, 'recovering');
    const url = new URL(await target.accounts.issueRecovery(id));
    const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
    const browser = new Browser(ORIGIN);
    const replacement = new Device();
    const options = await target.call(browser, '/passkey/recover', {
      step: 'options',
      token,
    });
    expect(options.status, JSON.stringify(options)).toBe(200);
    const recovered = await target.call(browser, '/passkey/recover', {
      step: 'verify',
      token,
      response: replacement.register(
        options.data!.options as Record<string, unknown>,
        ORIGIN,
      ),
    });
    expect(recovered.status, JSON.stringify(recovered)).toBe(200);
    const signedIn = await target.verified(browser);
    expect(signedIn.kind).toBe('authenticated');
    if (signedIn.kind === 'authenticated')
      expect(signedIn.session.subject).toBe(id);
    expect((await target.verified(old)).kind).toBe('invalid');
    // Single use, shared with password reset.
    expect(
      await target.call(new Browser(ORIGIN), '/passkey/recover', {
        step: 'options',
        token,
      }),
    ).toMatchObject({ status: 403, error: { code: 'recovery_unavailable' } });
    const reset = await target.call(new Browser(ORIGIN), '/reset-password', {
      token,
      newPassword: 'A new password 123456',
    });
    expect(reset.status).toBe(400);
    expect(
      (await signIn(target, new Browser(ORIGIN), replacement)).status,
    ).toBe(200);
  });

  test('a recovery link is refused for a disabled account and after it is used for a password', async () => {
    const target = await station();
    await signUp(target, new Browser(ORIGIN), new Device(), 'recover-disabled');
    const id = accountId(target, 'recover-disabled');
    const token = (url: string) =>
      new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
    const first = token(await target.accounts.issueRecovery(id));
    const options = await target.call(new Browser(ORIGIN), '/passkey/recover', {
      step: 'options',
      token: first,
    });
    expect(options.status).toBe(200);
    target.accounts.administration.setDisabled(id, true);
    expect(
      await target.call(new Browser(ORIGIN), '/passkey/recover', {
        step: 'options',
        token: first,
      }),
    ).toMatchObject({ status: 403, error: { code: 'recovery_unavailable' } });
    target.accounts.administration.setDisabled(id, false);
    const second = token(await target.accounts.issueRecovery(id));
    const reset = await target.call(new Browser(ORIGIN), '/reset-password', {
      token: second,
      newPassword: 'A new password 123456',
    });
    expect(reset.status).toBe(200);
    expect(
      await target.call(new Browser(ORIGIN), '/passkey/recover', {
        step: 'options',
        token: second,
      }),
    ).toMatchObject({ status: 403, error: { code: 'recovery_unavailable' } });
  });

  test('a passkey from another Station or origin never signs in', async () => {
    const home = await station({ stationId: 'home-station' });
    const device = new Device();
    await signUp(home, new Browser(ORIGIN), device, 'traveller');
    // Same host, different port: the same RP ID, a different Station.
    const sibling = await station({
      origin: 'https://station.example.test:8443',
      stationId: 'sibling-station',
    });
    const elsewhere = await station({
      origin: 'https://other.example.test',
      stationId: 'other-station',
    });
    for (const target of [sibling, elsewhere]) {
      const browser = new Browser(target.origin);
      expect(await signIn(target, browser, device)).toMatchObject({
        status: 401,
        error: { code: 'passkey_rejected' },
      });
      expect(await target.session(browser)).toBeUndefined();
    }
    // At home, an assertion made for another origin or RP ID is refused.
    for (const overrides of [
      { origin: 'https://other.example.test' },
      { rpId: 'other.example.test' },
    ]) {
      const browser = new Browser(ORIGIN);
      expect(await signIn(home, browser, device, overrides)).toMatchObject({
        status: 401,
      });
      expect(await home.session(browser)).toBeUndefined();
    }
    expect((await signIn(home, new Browser(ORIGIN), device)).status).toBe(200);
  });

  test('an approved application origin that is not the authentication origin starts no passkey ceremony', async () => {
    const app = 'https://app.example.test';
    const target = await station({ allowedBrowserOrigins: [app] });
    const device = new Device();
    await signUp(target, new Browser(ORIGIN), device, 'other-origin');
    const browser = new Browser(app);
    // The route admits this origin for accounts; WebAuthn here would bind to
    // the wrong origin, so no challenge is minted.
    for (const [path, body] of [
      ['/passkey/sign-in', { step: 'options' }],
      ['/passkey/sign-up', { step: 'options', username: 'from-app' }],
    ] as const)
      expect(
        await target.call(browser, path, body, {
          'x-station-invitation': INVITATION,
        }),
      ).toMatchObject({
        status: 403,
        error: { code: 'passkey_origin_unsupported' },
      });
    expect(browser.cookies.size).toBe(0);
    expect(
      target.accounts.administration.list().map((entry) => entry.username),
    ).toEqual(['other-origin']);
    // The same passkey still works at the authentication origin.
    expect((await signIn(target, new Browser(ORIGIN), device)).status).toBe(
      200,
    );
  });
});
