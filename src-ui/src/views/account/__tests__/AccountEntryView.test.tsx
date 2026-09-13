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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AccountEntryView } from '../AccountEntryView';

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
let joinFails: boolean;
let provider: unknown;

beforeEach(() => {
  calls.length = 0;
  signedIn = false;
  signInFails = false;
  joinFails = false;
  provider = descriptor;
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
      if (path.endsWith('/session'))
        return signedIn ? reply(account) : new Response(null, { status: 401 });
      if (
        path.endsWith('/sign-in/email') ||
        path.endsWith('/sign-in/username')
      ) {
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
  initialFlow: { invitation?: string; resetToken?: string } = { invitation },
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
    expect(screen.getByText(/still requires an approved device/)).toBeTruthy();
    expect(
      calls.every((call) => call.path.startsWith('/api/account-auth')),
    ).toBe(true);
    expect(calls.every((call) => !call.headers.has('authorization'))).toBe(
      true,
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
