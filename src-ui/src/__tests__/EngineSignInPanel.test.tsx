// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const initialScope = {
  apiBase: 'https://sign-in.example.test',
  authorityKey: 'operator-test',
  isCurrent: () => true,
};
let scope: typeof initialScope | undefined = initialScope;
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));
let presentation:
  | { deviceClass: 'host' | 'paired'; hostName: string }
  | undefined = { deviceClass: 'host', hostName: 'studio' };
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => presentation,
}));
const openLink = vi.fn();
vi.mock('../platform/openExternalLink', () => ({
  openExternalLink: (url: string) => openLink(url),
}));
vi.mock('../components/coding-layout/TerminalPanel', () => ({
  TerminalPanel: (props: Record<string, unknown>) => (
    <div data-testid="terminal" data-props={JSON.stringify(props)} />
  ),
}));

import { EngineSignInPanel } from '../components/engine-sign-in/EngineSignInPanel';

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  openLink.mockClear();
  presentation = { deviceClass: 'host', hostName: 'studio' };
  scope = initialScope;
});

type Call = { path: string; method: string; body?: string };

function serve(
  initialView: Record<string, unknown>,
  respond: (call: Call, view: Record<string, unknown>) => unknown = () =>
    undefined,
) {
  const calls: Call[] = [];
  let view = initialView;
  let attempt: unknown = null;
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: status < 400, data }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  setClientCredentialResolver(() => ({
    origin: scope?.apiBase ?? initialScope.apiBase,
    requestAuthority: scope,
    transport: async (url, init) => {
      const u = new URL(String(url));
      const call = {
        path: u.pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const custom = respond(call, view) as
        | { view?: Record<string, unknown>; attempt?: unknown; data?: unknown }
        | undefined;
      if (custom?.view) view = custom.view;
      if (custom && 'data' in custom) return reply(custom.data);
      if (custom && 'attempt' in custom) attempt = custom.attempt;
      if (u.pathname.endsWith('/sign-in/attempt')) return reply(attempt);
      if (u.pathname.endsWith('/sign-in/start')) return reply(attempt);
      return reply(view);
    },
  }));
  return calls;
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EngineSignInPanel connectionId="pi" />
    </QueryClientProvider>,
  );
}

const baseView = {
  connectionId: 'pi',
  engineName: 'pi',
  status: { state: 'unknown', source: 'none', checkable: false },
  methods: [
    {
      id: 'pi_terminal_login',
      name: 'Launch pi in the terminal',
      kind: 'terminal',
      termsNotice: {
        provider: 'Anthropic',
        termsUrl: 'https://code.claude.com/docs/en/legal-and-compliance',
      },
    },
  ],
  methodsObservedAt: '2026-10-21T10:00:00.000Z',
  credentials: [],
  allowed: { signIn: true, terminal: true },
};

test('shows Not checked, the terms note, and starts a terminal sign-in by method id only', async () => {
  const calls = serve(baseView, (call) =>
    call.path.endsWith('/sign-in/start')
      ? {
          attempt: {
            id: 'a1',
            methodId: 'pi_terminal_login',
            kind: 'terminal',
            state: 'running',
            startedAt: '2026-10-21T10:00:01.000Z',
            terminal: {
              projectSlug: '.engine-sign-in',
              projectId: '.engine-sign-in',
              bindingKey: 'engine-sign-in',
              terminalId: '62b97fa1-b690-4d77-82b1-747dc86d3c11',
            },
          },
        }
      : undefined,
  );
  renderPanel();
  expect(await screen.findByText('Not checked')).toBeTruthy();
  expect(screen.getByText(/has no sign-in check Station can run/)).toBeTruthy();
  expect(
    screen.getByText(
      /can use a subscription from Anthropic\. Anthropic's terms may restrict/,
    ),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: "Read Anthropic's terms" }),
  );
  expect(openLink).toHaveBeenCalledWith(
    'https://code.claude.com/docs/en/legal-and-compliance',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const terminal = await screen.findByTestId('terminal');
  expect(JSON.parse(terminal.getAttribute('data-props') ?? '{}')).toMatchObject(
    {
      projectSlug: '.engine-sign-in',
      // Attached by the server's session id, under the sign-in scope.
      target: { projectId: '.engine-sign-in', bindingKey: 'engine-sign-in' },
      terminalId: '62b97fa1-b690-4d77-82b1-747dc86d3c11',
      attachOnly: true,
    },
  );
  const start = calls.find((call) => call.path.endsWith('/sign-in/start'));
  expect(JSON.parse(start?.body ?? '{}')).toEqual({
    methodId: 'pi_terminal_login',
  });
});

test('a paired device that may not run commands gets the host instruction, not the button', async () => {
  presentation = { deviceClass: 'paired', hostName: 'studio' };
  serve({ ...baseView, allowed: { signIn: true, terminal: false } });
  renderPanel();
  await screen.findByText('Not checked');
  expect(
    (screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Sign in on studio\./)).toBeTruthy();
  expect(screen.getByText(/signs the engine in on studio/)).toBeTruthy();
});

test('an engine sign-in shows the link the engine printed, opened only on request', async () => {
  serve(
    {
      ...baseView,
      engineName: 'Droid',
      status: {
        state: 'unauthenticated',
        source: 'refusal',
        observedAt: '2026-10-21T10:00:00.000Z',
        checkable: false,
      },
      methods: [
        { id: 'device-pairing', name: 'Pair this device', kind: 'agent' },
      ],
    },
    (call) =>
      call.path.endsWith('/sign-in/attempt') && call.method === 'GET'
        ? {
            attempt: {
              id: 'a2',
              methodId: 'device-pairing',
              kind: 'agent',
              state: 'running',
              startedAt: '2026-10-21T10:00:01.000Z',
              links: ['https://app.factory.ai/device?code=ABCD'],
            },
          }
        : undefined,
  );
  renderPanel();
  expect(await screen.findByText('Not signed in')).toBeTruthy();
  expect(screen.getByText(/Droid refused a chat/)).toBeTruthy();
  await screen.findByText('https://app.factory.ai/device?code=ABCD');
  expect(openLink).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
  expect(openLink).toHaveBeenCalledWith(
    'https://app.factory.ai/device?code=ABCD',
  );
});

test('a key is sent once and never shown back', async () => {
  const calls = serve(
    {
      ...baseView,
      methods: [],
      credentials: [{ name: 'FACTORY_API_KEY', configured: false }],
    },
    (call, view) =>
      call.method === 'PUT'
        ? {
            view: {
              ...view,
              credentials: [{ name: 'FACTORY_API_KEY', configured: true }],
            },
          }
        : undefined,
  );
  renderPanel();
  const input = (await screen.findByLabelText(
    'FACTORY_API_KEY',
  )) as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'fk-ui-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
  await screen.findByText(/is saved/);
  const put = calls.find((call) => call.method === 'PUT');
  expect(put?.path).toBe('/acp/connections/pi/credentials/FACTORY_API_KEY');
  expect(JSON.parse(put?.body ?? '{}')).toEqual({ value: 'fk-ui-secret' });
  expect(document.body.innerHTML).not.toContain('fk-ui-secret');
});

test('an unread engine is checked once, and a signed-in status says where it came from', async () => {
  const calls = serve(
    { ...baseView, methods: undefined, methodsObservedAt: undefined },
    (call) =>
      call.path.endsWith('/sign-in/check')
        ? {
            view: {
              ...baseView,
              status: {
                state: 'authenticated',
                source: 'status-command',
                observedAt: '2026-10-21T10:00:00.000Z',
                checkable: true,
              },
            },
          }
        : undefined,
  );
  renderPanel();
  expect(await screen.findByText('Signed in')).toBeTruthy();
  expect(screen.getByText(/pi's own status check said so/)).toBeTruthy();
  await waitFor(() =>
    expect(
      calls.filter((call) => call.path.endsWith('/sign-in/check')),
    ).toHaveLength(1),
  );
});

test('"Setup required" offers the sign-in, and reads nothing until it is opened', async () => {
  const { ACPConnectionSetupStatus } = await import(
    '../components/acp-connections/ACPConnectionSetupStages'
  );
  const calls = serve(baseView);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ACPConnectionSetupStatus
        stage="result"
        label="Setup required"
        error={null}
        reason={{
          message: 'Authentication required: Sign in to pi first',
          phase: 'session creation',
        }}
        pending={false}
        engineName="pi"
        connectionId="pi"
      />
    </QueryClientProvider>,
  );
  const open = screen.getByRole('button', { name: 'Sign in to pi' });
  expect(calls).toEqual([]);
  fireEvent.click(open);
  expect(await screen.findByText('Not checked')).toBeTruthy();
  expect(calls[0]?.path).toBe('/acp/connections/pi/sign-in');
});

test.each(['connection', 'authority', 'host', 'disconnect'] as const)(
  'switching %s resets discovery and unsaved key drafts',
  async (change) => {
    const checks: string[] = [];
    const writes: { identity: string; body: unknown }[] = [];
    const discovered = new Set<string>();
    setClientCredentialResolver(() => ({
      origin: scope?.apiBase ?? initialScope.apiBase,
      requestAuthority: scope,
      transport: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const connectionId = path.split('/')[3];
        const identity = JSON.stringify([
          scope?.apiBase,
          scope?.authorityKey,
          connectionId,
        ]);
        if (path.endsWith('/sign-in/check')) {
          checks.push(identity);
          discovered.add(identity);
        }
        if (init?.method === 'PUT')
          writes.push({ identity, body: JSON.parse(String(init.body)) });
        const view = {
          ...baseView,
          connectionId,
          engineName: connectionId,
          methods: discovered.has(identity) ? [] : undefined,
          credentials: [{ name: 'SHARED_API_KEY', configured: false }],
        };
        return new Response(
          JSON.stringify({
            success: true,
            data: path.endsWith('/sign-in/attempt') ? null : view,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    }));
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const panel = (connectionId: string) => (
      <QueryClientProvider client={client}>
        <EngineSignInPanel connectionId={connectionId} />
      </QueryClientProvider>
    );
    const mounted = render(panel('pi'));
    const input = (await screen.findByLabelText(
      'SHARED_API_KEY',
    )) as HTMLInputElement;
    await waitFor(() => expect(checks).toHaveLength(1));
    fireEvent.change(input, { target: { value: 'unsaved-fixture-draft' } });
    let nextConnection = 'pi';
    if (change === 'connection') nextConnection = 'goose';
    else if (change === 'authority')
      scope = { ...initialScope, authorityKey: 'different-operator' };
    else if (change === 'host')
      scope = {
        ...initialScope,
        apiBase: 'https://other-sign-in.example.test',
      };
    else {
      scope = undefined;
      mounted.rerender(panel('pi'));
      expect(screen.queryByLabelText('SHARED_API_KEY')).toBeNull();
      scope = initialScope;
    }
    if (change !== 'disconnect')
      client.setQueryData(
        [
          'engine-sign-in',
          scope?.apiBase,
          scope?.authorityKey,
          nextConnection,
          'view',
        ],
        {
          ...baseView,
          connectionId: nextConnection,
          engineName: nextConnection,
          methods: undefined,
          credentials: [{ name: 'SHARED_API_KEY', configured: false }],
        },
      );
    mounted.rerender(panel(nextConnection));
    const nextInput = (await screen.findByLabelText(
      'SHARED_API_KEY',
    )) as HTMLInputElement;
    expect(nextInput.value).toBe('');
    if (change !== 'disconnect')
      await waitFor(() => expect(checks).toHaveLength(2));
    expect(writes).toEqual([]);
    fireEvent.change(nextInput, { target: { value: 'new-fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() =>
      expect(writes).toEqual([
        {
          identity: JSON.stringify([
            scope?.apiBase,
            scope?.authorityKey,
            nextConnection,
          ]),
          body: { value: 'new-fixture-key' },
        },
      ]),
    );
  },
);

const bundleView = {
  connectionId: 'kiro-kas-bundle',
  engineName: 'Kiro (KAS, no CLI)',
  status: {
    state: 'unauthenticated',
    source: 'station-vault',
    observedAt: '2026-11-13T10:00:00.000Z',
    checkable: false,
  },
  credentials: [],
  allowed: { signIn: true, terminal: false },
  hostAuth: {
    status: { owner: 'station', state: 'signed-out', issueCount24h: 0 },
    identities: ['builder-id', 'identity-center'],
    policy: 'allowed',
    install: {
      installId: 'kiro-kas',
      version: '0.66.104',
      state: { kind: 'not-installed' },
    },
    allowed: { install: true },
  },
};

test('an engine Station signs in: install with consent, then a Builder ID sign-in shows the code and opens the link only on request', async () => {
  let login: unknown = null;
  const calls = serve(bundleView, (call) => {
    if (call.path.endsWith('/managed-install'))
      return {
        data: {
          kind: 'installing',
          startedAt: '2026-11-13T10:00:01.000Z',
          receivedBytes: 0,
          totalBytes: 54_000_000,
        },
      };
    if (call.path.endsWith('/host-auth/login')) {
      if (call.method === 'POST')
        login = {
          kind: 'kiro.oidc-access-token',
          phase: 'awaiting-approval',
          startedAt: '2026-11-13T10:00:02.000Z',
          expiresAt: '2026-11-13T10:10:02.000Z',
          verificationUri:
            'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
          userCode: 'ABCD-EFGH',
        };
      return { data: login };
    }
    return undefined;
  });
  renderPanel();
  expect(
    await screen.findByText(/Station keeps .*sign-in itself/),
  ).toBeTruthy();
  // No engine handshake for an engine Station signs in.
  expect(calls.some((call) => call.path.endsWith('/sign-in/check'))).toBe(
    false,
  );
  expect(
    screen.getByText(
      /checked against pinned checksums and installed read-only/,
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Install' }));
  await waitFor(() =>
    expect(
      calls.find((call) => call.path.endsWith('/managed-install'))?.body,
    ).toBe(JSON.stringify({ consent: true })),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
  const start = calls.find(
    (call) => call.path.endsWith('/host-auth/login') && call.method === 'POST',
  );
  expect(JSON.parse(start?.body ?? '{}')).toEqual({ identity: 'builder-id' });
  expect(openLink).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
  expect(openLink).toHaveBeenCalledWith(
    'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
  );
});

test('Identity Center needs a start URL and region before it can start', async () => {
  const calls = serve(bundleView, (call) =>
    call.path.endsWith('/host-auth/login') ? { data: null } : undefined,
  );
  renderPanel();
  await screen.findByText(/Station keeps .*sign-in itself/);
  fireEvent.change(screen.getByLabelText('Sign in with'), {
    target: { value: 'identity-center' },
  });
  const submit = screen.getByRole('button', {
    name: 'Sign in',
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Start URL'), {
    target: { value: 'https://acme.awsapps.com/start' },
  });
  fireEvent.change(screen.getByLabelText('Region'), {
    target: { value: 'eu-central-1' },
  });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() =>
    expect(
      JSON.parse(
        calls.find(
          (call) =>
            call.path.endsWith('/host-auth/login') && call.method === 'POST',
        )?.body ?? '{}',
      ),
    ).toEqual({
      identity: 'identity-center',
      startUrl: 'https://acme.awsapps.com/start',
      region: 'eu-central-1',
    }),
  );
});

test('a signed-in engine offers sign-out; an installed one shows its version', async () => {
  const calls = serve(
    {
      ...bundleView,
      status: { ...bundleView.status, state: 'authenticated' },
      hostAuth: {
        ...bundleView.hostAuth,
        status: {
          owner: 'station',
          state: 'signed-in',
          identity: { kind: 'builder-id', region: 'us-east-1' },
          accessExpiresAt: '2026-11-13T11:00:00.000Z',
          issueCount24h: 2,
        },
        install: {
          ...bundleView.hostAuth.install,
          state: { kind: 'installed', version: '0.66.104' },
        },
      },
    },
    (call) =>
      call.path.endsWith('/host-auth/login') ? { data: null } : undefined,
  );
  renderPanel();
  expect(
    await screen.findByText('Kiro (KAS, no CLI) 0.66.104 is installed.'),
  ).toBeTruthy();
  expect(screen.getByText('Signed in with AWS Builder ID.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.path.endsWith('/host-auth/sign-out') && call.method === 'POST',
      ),
    ).toBe(true),
  );
});

test('where the engine keeps its sign-in is said only when the engine keeps it', async () => {
  serve(bundleView);
  const { unmount } = renderPanel();
  await screen.findByText(/Station keeps .*sign-in itself/);
  expect(
    screen.queryByText('The engine keeps its own sign-in on this computer.'),
  ).toBeNull();
  unmount();

  serve(baseView);
  renderPanel();
  expect(
    await screen.findByText(
      'The engine keeps its own sign-in on this computer.',
    ),
  ).toBeTruthy();
});

test('on the Station computer, Google or GitHub starts a social sign-in and opens the Kiro page only on request', async () => {
  let login: unknown = null;
  const portal =
    'https://app.kiro.dev/signin?state=s&code_challenge=c&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3128&redirect_from=kirocli';
  const calls = serve(
    {
      ...bundleView,
      hostAuth: {
        ...bundleView.hostAuth,
        identities: ['builder-id', 'identity-center', 'social'],
      },
    },
    (call) => {
      if (!call.path.endsWith('/host-auth/login')) return undefined;
      if (call.method === 'POST')
        login = {
          kind: 'kiro.oidc-access-token',
          phase: 'awaiting-approval',
          startedAt: '2026-11-13T10:00:02.000Z',
          expiresAt: '2026-11-13T10:05:02.000Z',
          authorizationUrl: portal,
        };
      return { data: login };
    },
  );
  renderPanel();
  await screen.findByText(/Station keeps .*sign-in itself/);
  expect(
    screen.queryByText(/needs a browser on the computer Station runs on/),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText('Sign in with'), {
    target: { value: 'social' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(
    await screen.findByText(
      'Finish signing in to Kiro in the browser on this computer.',
    ),
  ).toBeTruthy();
  expect(
    JSON.parse(
      calls.find(
        (call) =>
          call.path.endsWith('/host-auth/login') && call.method === 'POST',
      )?.body ?? '{}',
    ),
  ).toEqual({ identity: 'social' });
  expect(openLink).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open sign-in page' }));
  expect(openLink).toHaveBeenCalledWith(portal);
});

test('from another device, Google or GitHub is not offered and the panel says why', async () => {
  serve(
    {
      ...bundleView,
      hostAuth: {
        ...bundleView.hostAuth,
        socialSignIn: 'needs-browser-on-host',
      },
    },
    (call) =>
      call.path.endsWith('/host-auth/login') ? { data: null } : undefined,
  );
  renderPanel();
  await screen.findByText(/Station keeps .*sign-in itself/);
  expect(
    screen.getByText(
      'Google and GitHub sign-in needs a browser on the computer Station runs on.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Google or GitHub' })).toBeNull();
  expect(screen.getByRole('option', { name: 'AWS Builder ID' })).toBeTruthy();
});

test('a social sign-in is named by its provider', async () => {
  serve(
    {
      ...bundleView,
      status: { ...bundleView.status, state: 'authenticated' },
      hostAuth: {
        ...bundleView.hostAuth,
        status: {
          owner: 'station',
          state: 'signed-in',
          identity: { kind: 'social', provider: 'github' },
          issueCount24h: 0,
        },
      },
    },
    (call) =>
      call.path.endsWith('/host-auth/login') ? { data: null } : undefined,
  );
  renderPanel();
  expect(await screen.findByText('Signed in with GitHub.')).toBeTruthy();
});

test('a social sign-in that timed out says what to do instead', async () => {
  serve(
    {
      ...bundleView,
      hostAuth: {
        ...bundleView.hostAuth,
        identities: ['builder-id', 'identity-center', 'social'],
      },
    },
    (call) =>
      call.path.endsWith('/host-auth/login')
        ? {
            data: {
              kind: 'kiro.oidc-access-token',
              phase: 'failed',
              startedAt: '2026-11-13T10:00:02.000Z',
              expiresAt: '2026-11-13T10:05:02.000Z',
              failure: 'expired',
              reason:
                'No answer came back from the browser in time. If the browser is not on the computer Station runs on, use AWS Builder ID or IAM Identity Center.',
            },
          }
        : undefined,
  );
  renderPanel();
  expect(
    await screen.findByText(/did not finish\. No answer came back/),
  ).toBeTruthy();
});
