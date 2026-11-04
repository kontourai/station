/** @vitest-environment jsdom */
import { DEPLOYMENT_AUTHENTICATION_VERSION } from '@kontourai/station-contracts/deployment-authentication';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { StrictMode } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { AccountEntryPage, AccountEntryView } from '../AccountEntryView';

// The browser's WebAuthn boundary: the page's own requests stay real.
const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const apiBase = 'https://station.example.test';
const invitation = 'i'.repeat(43);
const descriptor = {
  version: DEPLOYMENT_AUTHENTICATION_VERSION,
  issuer: 'station:test',
  displayName: 'Example Station',
  sessionCookies: ['account_session'],
  login: {
    kind: 'email-password',
    signInPath: '/sign-in/email',
    signUpPath: '/sign-up/email',
  },
  endpoints: [
    { path: '/sign-in/email', methods: ['POST'], operation: 'begin-login' },
    { path: '/sign-up/email', methods: ['POST'], operation: 'register' },
    {
      path: '/request-password-reset',
      methods: ['POST'],
      operation: 'request-recovery',
    },
    {
      path: '/reset-password',
      methods: ['POST'],
      operation: 'complete-recovery',
    },
    { path: '/sign-out', methods: ['POST'], operation: 'logout' },
  ],
};
const account = {
  principal: humanPrincipal('deployment', 'invitee', 'Invited person'),
  issuer: descriptor.issuer,
  expiresAt: '2099-01-01T00:00:00.000Z',
  contacts: [
    {
      kind: 'email',
      value: 'invitee@example.test',
      verifiedAt: '2026-09-12T00:00:00.000Z',
    },
  ],
};
const clients: QueryClient[] = [];
const calls: { path: string; headers: Headers; body: unknown }[] = [];
let signedIn: boolean;
let signInFails: boolean;
let signInInvalid: boolean;
let joinFails: boolean;
let previewFails: boolean;
let provider: unknown;
let pairingMode: 'none' | 'approve' | 'deny' | 'personal';
let deviceReady: boolean;
let projectFailureStatus: number | undefined;
let passkeys: {
  id: string;
  name?: string;
  createdAt: string;
  synced: boolean;
}[];

// Invitation tests exercise onboarding after the account action, not chunk loading.
beforeAll(async () => {
  await import('../GuestDeviceOnboarding');
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  localStorage.clear();
  calls.length = 0;
  signedIn = false;
  signInFails = false;
  signInInvalid = false;
  joinFails = false;
  previewFails = false;
  provider = descriptor;
  pairingMode = 'none';
  deviceReady = false;
  projectFailureStatus = undefined;
  passkeys = [];
  webauthn.startRegistration.mockReset();
  webauthn.startAuthentication.mockReset();
  sessionStorage.clear();
  setClientCredentialResolver(() => ({
    origin: apiBase,
    credential: 'private-operator-credential',
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      calls.push({
        path,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const reply = (data: unknown) => Response.json({ data });
      if (path === '/api/account-auth') return reply(provider);
      if (path.endsWith('/invitation-preview'))
        return previewFails
          ? Response.json(
              { error: { message: 'Invitation unavailable.' } },
              { status: 409 },
            )
          : reply({
              projectName: 'Example Project',
              inviterName: 'Project owner',
              role: 'viewer',
              actions: ['view'],
              expiresAt: '2099-01-01T00:00:00.000Z',
              recipientEmail: null,
            });
      if (path.endsWith('/session'))
        return signedIn ? reply(account) : new Response(null, { status: 401 });
      if (
        path.endsWith('/sign-in/email') ||
        path.endsWith('/sign-in/username')
      ) {
        if (signInInvalid)
          return Response.json(
            {
              success: false,
              error: 'Validation failed',
              details: {
                formErrors: [],
                fieldErrors: { email: ['Enter a valid email address.'] },
              },
            },
            { status: 400 },
          );
        if (signInFails)
          return Response.json(
            { error: { message: 'Sign-in failed.' } },
            { status: 401 },
          );
        signedIn = true;
        return reply({});
      }
      if (path.endsWith('/accept-invitation'))
        return joinFails
          ? Response.json(
              { error: { message: 'Invitation cannot be accepted.' } },
              { status: 403 },
            )
          : reply({
              scope: { localProjectSlug: 'example' },
              grantsDeviceAccess: false,
            });
      if (
        path === '/.well-known/station/v1/pairing/access-request' &&
        pairingMode !== 'none'
      )
        return Response.json(
          {
            environmentId: 'environment-account',
            offerId: 'account-offer',
            proof: 'account-proof',
            requestId: 'account-request',
            expiresAt: Date.now() + 60_000,
            ...(pairingMode === 'personal'
              ? {}
              : { requireAccountBinding: true }),
            accountCandidate: {
              issuer: descriptor.issuer,
              subject: 'invitee',
              displayName: 'Invited person',
            },
          },
          { status: 202 },
        );
      if (
        path === '/.well-known/station/v1/pairing/exchange' &&
        pairingMode !== 'none'
      ) {
        if (pairingMode === 'deny')
          return Response.json({ error: 'request_denied' }, { status: 403 });
        deviceReady = pairingMode === 'approve';
        return Response.json({
          environmentId: 'environment-account',
          delivery: 'browser-cookie',
          device: {
            id: 'fresh-account-device',
            name: 'This browser',
            kind: 'device',
            scope: 'orchestration:read',
            createdAt: Date.now(),
            revokedAt: null,
            ...(pairingMode === 'approve'
              ? {
                  principalBinding: {
                    kind: 'account',
                    issuer: descriptor.issuer,
                    subject: 'invitee',
                    displayName: 'Invited person',
                    approvedAt: Date.now(),
                    approvalId: 'approval-1',
                    approvedBy: 'human:deployment:operator',
                  },
                }
              : {}),
          },
        });
      }
      if (path === '/api/projects')
        return projectFailureStatus
          ? Response.json(
              { error: { code: 'unavailable' } },
              { status: projectFailureStatus },
            )
          : deviceReady
            ? Response.json({
                success: true,
                data: [
                  {
                    version: 'station.member-project/v1',
                    kind: 'member-project',
                    id: 'project-1',
                    slug: 'example',
                    name: 'Example Project',
                    description: 'Shared project details',
                    actions: ['view'],
                  },
                ],
              })
            : new Response(null, { status: 401 });
      if (path === '/api/projects/example')
        return Response.json({
          success: true,
          data: {
            version: 'station.member-project/v1',
            kind: 'member-project',
            id: 'project-1',
            slug: 'example',
            name: 'Example Project',
            description: 'Shared project details',
            actions: ['view'],
          },
        });
      if (path.includes('/passkey/')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path.endsWith('/passkey/list')) return reply({ passkeys });
        if (path.endsWith('/passkey/remove'))
          return Response.json(
            { error: { code: 'last_sign_in_method' } },
            { status: 409 },
          );
        if (body.step === 'options')
          return reply({ options: { challenge: `challenge:${path}` } });
        if (!path.endsWith('/passkey/add')) signedIn = true;
        return reply({ success: true });
      }
      if (path.endsWith('/oidc/test/begin'))
        return reply({ url: 'javascript:alert(1)' });
      if (path.endsWith('/sign-out')) signedIn = false;
      return reply({});
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
function mount(
  initialFlow: {
    invitation?: string;
    resetToken?: string;
    authenticationError?: boolean;
  } = { invitation },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <AccountEntryView apiBase={apiBase} initialFlow={initialFlow} />
    </QueryClientProvider>,
  );
}
async function enterCredentials() {
  fireEvent.change(await screen.findByLabelText('Email address'), {
    target: { value: 'invitee@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'example-test-password' },
  });
}

describe('invitation entry through real account SDK requests', () => {
  test('a new same-document invitation replaces the preview and clears private form state', async () => {
    render(
      <StrictMode>
        <AccountEntryPage apiBase={apiBase} />
      </StrictMode>,
    );
    await screen.findByLabelText('Email address');
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'draft-that-must-not-move' },
    });
    window.history.replaceState(
      null,
      '',
      `/account/join#invitation=${invitation}`,
    );
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: 'Join Example Project' });
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
      '',
    );
    window.history.replaceState(
      null,
      '',
      '/account/join#invitation=invalid-new-link',
    );
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByText('Invitation unavailable');
    expect(
      screen.queryByRole('heading', { name: 'Join Example Project' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Accept invitation' }),
    ).toBeNull();
    window.history.replaceState(null, '', '/');
  });
  test('shows the offered Project and role before sign-in and never places invitation proof in a URL', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Join Example Project' });
    expect(screen.getByText(/Project owner invited you/)).toBeTruthy();
    expect(screen.getByLabelText('Email address')).toBeTruthy();
    expect(
      calls.find((call) => call.path.endsWith('/invitation-preview'))?.body,
    ).toEqual({ token: invitation });
    expect(calls.every((call) => !call.path.includes(invitation))).toBe(true);
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
  });
  test('an invalid invitation shows a recovery state before account registration or acceptance', async () => {
    previewFails = true;
    mount();
    await screen.findByText('Invitation unavailable');
    expect(
      screen.queryByRole('button', { name: 'Create an account' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Accept invitation' }),
    ).toBeNull();
  });
  test('the production page boots under StrictMode with its own query provider', async () => {
    render(
      <StrictMode>
        <AccountEntryPage apiBase={apiBase} />
      </StrictMode>,
    );
    await screen.findByLabelText('Email address');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(
      calls.every(
        (call) =>
          call.path.startsWith('/api/account-auth') &&
          !call.headers.has('authorization'),
      ),
    ).toBe(true);
  });
  test('offers configured identity choices without operator credentials and refuses unsafe redirects', async () => {
    provider = {
      ...descriptor,
      externalLogins: [
        {
          id: 'test',
          displayName: 'Example identity',
          startPath: '/oidc/test/begin',
        },
      ],
      endpoints: [
        ...descriptor.endpoints,
        {
          path: '/oidc/test/begin',
          methods: ['POST'],
          operation: 'begin-login',
        },
      ],
    };
    mount();
    await screen.findByLabelText('Email address');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Continue with Example identity',
      }),
    );
    await screen.findByText(
      'The sign-in provider returned an unsupported destination.',
    );
    const request = calls.find((call) =>
      call.path.endsWith('/oidc/test/begin'),
    );
    expect(request?.body).toEqual({});
    expect(request?.headers.get('x-station-invitation')).toBe(invitation);
    expect(request?.headers.has('authorization')).toBe(false);
    expect(screen.getByLabelText('Email address')).toBeTruthy();
  });

  test('a failed provider return explains recovery while keeping the invitation', async () => {
    mount({ invitation, authenticationError: true });
    await screen.findByLabelText('Email address');
    expect(screen.getByRole('alert').textContent).toContain(
      'Sign-in could not be completed',
    );
    expect(
      screen.getByRole('button', { name: 'Create an account' }),
    ).toBeTruthy();
  });

  test('username registration needs no email and keeps sign-in and acceptance explicit', async () => {
    provider = {
      ...descriptor,
      login: {
        kind: 'username-password',
        signInPath: '/sign-in/username',
        signUpPath: '/sign-up/username',
      },
      endpoints: [
        {
          path: '/sign-in/username',
          methods: ['POST'],
          operation: 'begin-login',
        },
        { path: '/sign-up/username', methods: ['POST'], operation: 'register' },
        { path: '/sign-out', methods: ['POST'], operation: 'logout' },
      ],
    };
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }),
    );
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'collaborator' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a local test password' },
    });
    expect(screen.queryByLabelText('Email address')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText(
      'Account created. Sign in to accept your invitation.',
    );
    expect(
      calls.find((call) => call.path.endsWith('/sign-up/username'))?.body,
    ).toEqual({
      username: 'collaborator',
      password: 'a local test password',
    });
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
    expect(screen.queryByText('Forgot password?')).toBeNull();
  });

  test('sign-in leaves acceptance explicit and never uses ambient operator credentials', async () => {
    mount();
    await enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const accept = await screen.findByRole('button', {
      name: 'Accept invitation',
    });
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
    fireEvent.click(accept);
    await screen.findByRole('heading', { name: 'You joined the Project' });
    expect(
      calls.find((call) => call.path.endsWith('/accept-invitation'))?.body,
    ).toEqual({ token: invitation });
    expect(
      await screen.findByText(/Request access for this browser/),
    ).toBeTruthy();
    expect(calls.every((call) => !call.headers.has('authorization'))).toBe(
      true,
    );
  });

  test('requests and consumes a fresh account-bound Device after explicit invitation acceptance', async () => {
    pairingMode = 'approve';
    mount();
    await enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Request access for this browser',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request access' }),
    );
    expect((await screen.findByRole('status')).textContent).toMatch(
      /approval|waiting/i,
    );
    expect(
      await screen.findByText(/Available Projects/, undefined, {
        timeout: 5_000,
      }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Read Project details' }),
    );
    expect(
      (
        await screen.findByRole('region', {
          name: 'Example Project details',
        })
      ).textContent,
    ).toContain('Shared work is view-only here');
    deviceReady = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('button', {
        name: 'Request access for this browser',
      }),
    ).toBeTruthy();
    const request = calls.find((call) =>
      call.path.endsWith('/pairing/access-request'),
    );
    const exchange = calls.find((call) =>
      call.path.endsWith('/pairing/exchange'),
    );
    expect(request).toBeDefined();
    expect(exchange).toBeDefined();
    expect(request?.body).toMatchObject({ requireAccountBinding: true });
    expect(exchange?.body).toMatchObject({
      clientInstanceId: (request!.body as { clientInstanceId: string })
        .clientInstanceId,
    });
    expect(calls.every((call) => !call.headers.has('authorization'))).toBe(
      true,
    );
  });

  test('an existing account can request an independent browser Device without a new invitation', async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(
      globalThis.crypto,
    );
    vi.stubGlobal('crypto', { getRandomValues });
    pairingMode = 'approve';
    signedIn = true;
    mount({});
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Request access for this browser',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request access' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Available Projects' }),
    ).toBeTruthy();
    expect(
      calls.find((call) => call.path.endsWith('/pairing/access-request'))?.body,
    ).toMatchObject({ requireAccountBinding: true });
  });

  test('provider uncertainty offers retry instead of Device approval', async () => {
    signedIn = true;
    projectFailureStatus = 503;
    mount({});
    expect(
      await screen.findByRole('button', { name: 'Try again' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Request access for this browser' }),
    ).toBeNull();
  });

  test('keeps denied guest Device approval separate from accepted membership', async () => {
    pairingMode = 'deny';
    signedIn = true;
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Request access for this browser',
      }),
    );
    const direct = screen.queryByRole('button', { name: 'Request access' });
    if (direct) fireEvent.click(direct);
    expect(
      await screen.findByText(/declined this access request/, undefined, {
        timeout: 5_000,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'You joined the Project' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        level: 2,
        name: 'Available Projects',
      }),
    ).toBeNull();
  });

  test('refuses a personal Device receipt instead of falling back to host access', async () => {
    pairingMode = 'personal';
    signedIn = true;
    mount({});
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Request access for this browser',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request access' }),
    );
    expect(
      await screen.findByText(
        'This Station did not confirm the signed-in account for Device approval.',
        undefined,
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', {
        level: 2,
        name: 'Available Projects',
      }),
    ).toBeNull();
    expect(deviceReady).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/pairing/exchange'))).toBe(
      false,
    );
  });

  test('failed sign-in clears the password and does not accept the invitation', async () => {
    signInFails = true;
    mount();
    await enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Password') as HTMLInputElement).value,
      ).toBe(''),
    );
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
    expect(screen.queryByText('You joined the Project')).toBeNull();
  });

  // #2708 A-3b: the account fetcher's validation refusal names each field in
  // its message; the page shows the server's reason, not the schema key.
  test('a sign-in refused by validation reads as its reason, not its field key', async () => {
    signInInvalid = true;
    mount();
    await enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Enter a valid email address.');
    expect(alert.textContent).not.toContain('Validation failed');
    expect(alert.textContent).not.toMatch(/\bemail Enter\b/);
  });

  test('registration sends invitation eligibility separately and waits for email verification', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }),
    );
    fireEvent.change(screen.getByLabelText('Your name'), {
      target: { value: 'Invited person' },
    });
    await enterCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText(/Check your email to verify your account/);
    const registration = calls.find((call) =>
      call.path.endsWith('/sign-up/email'),
    );
    expect(registration?.headers.get('x-station-invitation')).toBe(invitation);
    expect(registration?.body).toEqual({
      name: 'Invited person',
      email: 'invitee@example.test',
      password: 'example-test-password',
    });
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
  });

  test('refused acceptance retains the invitation for a deliberate retry', async () => {
    signedIn = true;
    joinFails = true;
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('You joined the Project')).toBeNull();
    joinFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await screen.findByRole('heading', { name: 'You joined the Project' });
  });

  test('an adapter without standard login UI does not invent a password form', async () => {
    const { login: _login, ...withoutLogin } = descriptor;
    provider = withoutLogin;
    mount({});
    await screen.findByText(/provider uses its own sign-in interface/);
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test('password reset consumes its exact email token and returns to sign-in', async () => {
    mount({ resetToken: 'reset-proof-token-1234567890' });
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'new-example-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    await screen.findByText(
      'Password updated. Sign in with your new password.',
    );
    expect(
      calls.find((call) => call.path.endsWith('/reset-password'))?.body,
    ).toEqual({
      token: 'reset-proof-token-1234567890',
      newPassword: 'new-example-password',
    });
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
      '',
    );
  });
});

describe('account sign-out and appearance', () => {
  test('signing out releases the cached account appearance', async () => {
    // The account path has no account boundary; the startup path painted the
    // previous account's appearance from the cache.
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 1, values: { theme: 'dark' } }),
    );
    localStorage.setItem(
      'station-appearance-v1',
      JSON.stringify({
        version: 1,
        source: 'account',
        theme: 'light',
        colorTheme: 'nord',
        colorThemeFlavor: null,
        colorThemeAccent: null,
      }),
    );
    deviceSettingsStore.reloadFromStorage();
    try {
      expect(deviceSettingsStore.getAppearanceSource()).toBe('cache');
      signedIn = true;
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
      await waitFor(() =>
        expect(calls.some((call) => call.path.endsWith('/sign-out'))).toBe(
          true,
        ),
      );
      await waitFor(() =>
        expect(deviceSettingsStore.getAppearanceSource()).toBe('device'),
      );
      const { theme, colorTheme } = deviceSettingsStore.getSnapshot();
      expect({ theme, colorTheme }).toEqual({
        theme: 'dark',
        colorTheme: 'station',
      });
    } finally {
      localStorage.clear();
      deviceSettingsStore.reloadFromStorage();
    }
  });
});

describe('member passkeys (#4303)', () => {
  const passkeyProvider = {
    ...descriptor,
    login: {
      kind: 'username-password',
      signInPath: '/sign-in/username',
      signUpPath: '/sign-up/username',
    },
    endpoints: [
      {
        path: '/sign-in/username',
        methods: ['POST'],
        operation: 'begin-login',
      },
      { path: '/sign-up/username', methods: ['POST'], operation: 'register' },
      {
        path: '/reset-password',
        methods: ['POST'],
        operation: 'complete-recovery',
      },
      { path: '/sign-out', methods: ['POST'], operation: 'logout' },
      {
        path: '/passkey/sign-in',
        methods: ['POST'],
        operation: 'passkey-sign-in',
      },
      {
        path: '/passkey/sign-up',
        methods: ['POST'],
        operation: 'passkey-register',
      },
      { path: '/passkey/add', methods: ['POST'], operation: 'passkey-add' },
      {
        path: '/passkey/recover',
        methods: ['POST'],
        operation: 'passkey-recover',
      },
      { path: '/passkey/list', methods: ['POST'], operation: 'passkey-list' },
      {
        path: '/passkey/remove',
        methods: ['POST'],
        operation: 'passkey-remove',
      },
    ],
  };
  const credential = { id: 'credential-1', type: 'public-key' };
  beforeEach(() => {
    provider = passkeyProvider;
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {},
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'credentials');
  });
  const passkeyCalls = (endpoint: string) =>
    calls.filter((call) => call.path.endsWith(endpoint));

  test('signs in with a passkey through the declared two-step ceremony', async () => {
    webauthn.startAuthentication.mockResolvedValue(credential);
    mount({});
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with a passkey' }),
    );
    await screen.findByText('Signed in as');
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'challenge:/api/account-auth/passkey/sign-in' },
    });
    expect(passkeyCalls('/passkey/sign-in').map((call) => call.body)).toEqual([
      { step: 'options' },
      { step: 'verify', response: credential },
    ]);
    expect(
      passkeyCalls('/passkey/sign-in').some((call) =>
        call.headers.has('authorization'),
      ),
    ).toBe(false);
  });

  test('an invited person creates an account with a passkey: no password, invitation sent at both steps', async () => {
    webauthn.startRegistration.mockResolvedValue(credential);
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }),
    );
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'passkey.person' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create account with a passkey' }),
    );
    await screen.findByRole('button', { name: 'Accept invitation' });
    const sent = passkeyCalls('/passkey/sign-up');
    expect(sent.map((call) => call.body)).toEqual([
      { step: 'options', username: 'passkey.person' },
      { step: 'verify', response: credential },
    ]);
    expect(
      sent.map((call) => call.headers.get('x-station-invitation')),
    ).toEqual([invitation, invitation]);
    expect(calls.some((call) => call.path.endsWith('/sign-up/username'))).toBe(
      false,
    );
    expect(calls.some((call) => call.path.endsWith('/accept-invitation'))).toBe(
      false,
    );
    // Signing out returns to passkey sign-in, not to an orphaned sign-up form.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('button', { name: 'Sign in with a passkey' }),
    ).toBeTruthy();
  });

  test('a passkey registration needs a valid username before any request', async () => {
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create an account' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create account with a passkey' }),
    );
    await screen.findByText(
      'Choose a username: 3 to 32 letters, digits, dots, dashes or underscores.',
    );
    expect(passkeyCalls('/passkey/sign-up')).toEqual([]);
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });

  test('an operator recovery link enrols a passkey with its token and signs in', async () => {
    webauthn.startRegistration.mockResolvedValue(credential);
    mount({ resetToken: 'recovery-proof-token-1234567890' });
    expect(
      await screen.findByRole('heading', { name: 'Recover your account' }),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add a passkey instead' }),
    );
    await screen.findByText('Passkey added. You are signed in.');
    expect(passkeyCalls('/passkey/recover').map((call) => call.body)).toEqual([
      { step: 'options', token: 'recovery-proof-token-1234567890' },
      {
        step: 'verify',
        token: 'recovery-proof-token-1234567890',
        response: credential,
      },
    ]);
    expect(calls.some((call) => call.path.endsWith('/reset-password'))).toBe(
      false,
    );
  });

  test('a cancelled passkey prompt explains itself and creates no session', async () => {
    webauthn.startAuthentication.mockRejectedValue(
      Object.assign(
        new Error('The operation either timed out or was not allowed.'),
        {
          name: 'NotAllowedError',
        },
      ),
    );
    mount({});
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in with a passkey' }),
    );
    await screen.findByText('The passkey request was cancelled or timed out.');
    expect(passkeyCalls('/passkey/sign-in').map((call) => call.body)).toEqual([
      { step: 'options' },
    ]);
    expect(screen.queryByText('Signed in as')).toBeNull();
  });

  test('a browser without WebAuthn is not offered passkeys', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    mount({});
    await screen.findByRole('button', { name: 'Sign in' });
    expect(
      screen.queryByRole('button', { name: 'Sign in with a passkey' }),
    ).toBeNull();
  });

  test('a signed-in member lists, adds and is told why the last passkey stays', async () => {
    signedIn = true;
    passkeys = [
      {
        id: 'passkey-1',
        name: 'Work laptop',
        createdAt: '2026-10-01T00:00:00.000Z',
        synced: true,
      },
    ];
    webauthn.startRegistration.mockResolvedValue(credential);
    mount({});
    await screen.findByText('Work laptop');
    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));
    await screen.findByText('Passkey added.');
    expect(passkeyCalls('/passkey/add').map((call) => call.body)).toEqual([
      { step: 'options' },
      { step: 'verify', response: credential },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove passkey' }),
    );
    await screen.findByText('Keep at least one way to sign in.');
    expect(passkeyCalls('/passkey/remove').map((call) => call.body)).toEqual([
      { id: 'passkey-1' },
    ]);
  });
});
