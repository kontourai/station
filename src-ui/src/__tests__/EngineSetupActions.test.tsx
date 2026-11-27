// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { EngineStationTools } from '../components/acp-connections/EngineStationTools';
import { EngineInstallTerminal } from '../components/engine-install/EngineInstallTerminal';

const owner = {
  apiBase: 'https://engine-setup.test',
  authorityKey: 'owner',
  isCurrent: () => true,
};
let scope: typeof owner | undefined = owner;
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate: vi.fn() }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));
vi.mock('../components/coding-layout/TerminalPanel', () => ({
  TerminalPanel: (props: Record<string, unknown>) => (
    <div data-testid="terminal" data-props={JSON.stringify(props)} />
  ),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  setClientCredentialResolver(undefined);
  scope = owner;
  vi.unstubAllGlobals();
});
function mount(component: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{component}</QueryClientProvider>,
  );
}
function serve({
  repairNeeded = false,
  loseInstallResponse = false,
  previewEnabled = true,
  existingTerminal = false,
  completedTerminal = false,
}: {
  repairNeeded?: boolean;
  loseInstallResponse?: boolean;
  previewEnabled?: boolean;
  existingTerminal?: boolean;
  completedTerminal?: boolean;
} = {}) {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let terminal: Record<string, unknown> | null =
    existingTerminal || completedTerminal
      ? {
          projectSlug: '.engine-install',
          projectId: '.engine-install',
          bindingKey: 'install:antigravity',
          terminalId: '51d5b28e-d89a-4aba-99f9-063f854a2958',
          operationId: '00000000-0000-4000-8000-000000000001',
          status: completedTerminal ? 'exited' : 'running',
          exitCode: completedTerminal ? 0 : null,
        }
      : null;
  let selected = false;
  setClientCredentialResolver(() => ({
    origin: owner.apiBase,
    requestAuthority: scope,
    transport: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({
        path,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      let data: unknown;
      if (path === '/api/feature-previews')
        data = [{ id: 'guided-engine-setup', enabled: previewEnabled }];
      else if (path.endsWith('/install-terminal')) {
        if (method === 'POST')
          terminal = {
            projectSlug: '.engine-install',
            projectId: '.engine-install',
            bindingKey: 'install:antigravity',
            terminalId: '51d5b28e-d89a-4aba-99f9-063f854a2958',
            operationId: JSON.parse(String(init?.body)).operationId,
            status: 'running',
            exitCode: null,
          };
        if (method === 'POST' && loseInstallResponse)
          throw new Error('Install response was lost');
        if (method === 'DELETE' && terminal)
          terminal = { ...terminal, status: 'exited', exitCode: 143 };
        data =
          method === 'GET'
            ? {
                name: 'Google Antigravity',
                command: 'reviewed-installer',
                allowed: previewEnabled,
                canStop: true,
                terminal,
              }
            : { terminal };
      } else if (path.endsWith('/station-tools')) {
        if (method === 'POST') selected = true;
        data = {
          agentSlug: 'antigravity',
          supported: !repairNeeded,
          selected,
          ...(repairNeeded
            ? {
                recommended: {
                  id: 'antigravity',
                  name: 'Antigravity',
                  command: 'agy',
                  args: ['acp', '--process-per-session'],
                },
              }
            : {}),
        };
      } else if (path.endsWith('/recommended-setup')) {
        repairNeeded = false;
        data = { connected: true };
      } else throw new Error(`Unmodeled request ${method} ${path}`);
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  }));
  return calls;
}
test('installation requires review of the exact command and attaches only to the server-created terminal', async () => {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
  const calls = serve();
  mount(<EngineInstallTerminal id="antigravity" onFinished={vi.fn()} />);
  const install = await screen.findByRole('button', {
    name: 'Install Google Antigravity on Station',
  });
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  fireEvent.click(install);
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/reviewed-installer/)).toBeTruthy();
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  fireEvent.click(install);
  fireEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: /^Install$/,
    }),
  );
  const terminal = await screen.findByTestId('terminal');
  expect(JSON.parse(terminal.getAttribute('data-props') ?? '{}')).toMatchObject(
    {
      attachOnly: true,
      terminalId: '51d5b28e-d89a-4aba-99f9-063f854a2958',
      target: {
        projectId: '.engine-install',
        bindingKey: 'install:antigravity',
      },
    },
  );
  expect(
    JSON.parse(calls.find((call) => call.method === 'POST')?.body ?? '{}'),
  ).toMatchObject({
    command: 'reviewed-installer',
    operationId: expect.any(String),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Stop installation' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true),
  );
  const stopped = JSON.parse(
    calls.find((call) => call.method === 'DELETE')?.body ?? '{}',
  );
  expect(stopped).toEqual({
    terminalId: '51d5b28e-d89a-4aba-99f9-063f854a2958',
    operationId: expect.any(String),
  });
});

test('Station tools are an explicit choice and remain separate from engine readiness', async () => {
  const calls = serve();
  mount(<EngineStationTools connectionId="antigravity" />);
  const add = await screen.findByRole('button', { name: 'Add Station tools' });
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  fireEvent.click(add);
  expect(
    await screen.findByText('Station tools selected for new chats.'),
  ).toBeTruthy();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

test('recommended setup is reviewed and fixes the existing connection before Station tools are offered', async () => {
  const calls = serve({ repairNeeded: true });
  mount(<EngineStationTools connectionId="legacy-agy" />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Use recommended setup' }),
  );
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/--process-per-session/)).toBeTruthy();
  expect(calls.some((call) => call.method === 'POST')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply setup' }));
  expect(
    await screen.findByRole('button', { name: 'Add Station tools' }),
  ).toBeTruthy();
  const repair = calls.find((call) => call.path.endsWith('/recommended-setup'));
  expect(repair?.path).toBe('/acp/connections/legacy-agy/recommended-setup');
  expect(JSON.parse(repair?.body ?? '{}')).toEqual({
    id: 'antigravity',
    command: 'agy',
    args: ['acp', '--process-per-session'],
  });
});

test('a lost installer response is reconciled by reading status without sending another install', async () => {
  const calls = serve({ loseInstallResponse: true });
  mount(<EngineInstallTerminal id="antigravity" onFinished={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Install Google Antigravity on Station',
    }),
  );
  fireEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: /^Install$/,
    }),
  );
  expect(await screen.findByTestId('terminal')).toBeTruthy();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(
    await screen.findByRole('button', { name: 'Stop installation' }),
  ).toBeTruthy();
});

test('a fresh pane with the preview off still discovers an existing installer and offers Stop', async () => {
  const calls = serve({ previewEnabled: false, existingTerminal: true });
  mount(<EngineInstallTerminal id="antigravity" onFinished={vi.fn()} />);
  expect(
    await screen.findByRole('button', { name: 'Stop installation' }),
  ).toBeTruthy();
  expect(
    calls.some(
      (call) =>
        call.path.endsWith('/install-terminal') && call.method === 'GET',
    ),
  ).toBe(true);
  expect(
    screen.queryByRole('button', {
      name: 'Install Google Antigravity on Station',
    }),
  ).toBeNull();
});

test('returning to a completed installer does not restart engine checks', async () => {
  serve({ completedTerminal: true });
  const finished = vi.fn();
  mount(
    <EngineInstallTerminal
      id="antigravity"
      installNeeded={false}
      onFinished={finished}
    />,
  );
  await waitFor(() => expect(clients[0].isFetching()).toBe(0));
  expect(finished).not.toHaveBeenCalled();
});
