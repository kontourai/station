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

const scope = {
  apiBase: 'https://sign-in.example.test',
  authorityKey: 'operator-test',
  isCurrent: () => true,
};
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
    origin: scope.apiBase,
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
        | { view?: Record<string, unknown>; attempt?: unknown }
        | undefined;
      if (custom?.view) view = custom.view;
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
            terminal: { projectSlug: '.engine-sign-in', terminalId: 'pi-1' },
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
      terminalId: 'pi-1',
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
