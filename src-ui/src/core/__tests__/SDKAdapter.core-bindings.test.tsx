/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const approval = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  submitToolApproval: approval,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
  useLaunchChat: () => vi.fn(),
}));

import {
  useActiveChatState,
  useAvailableModels,
  useConfig,
  useConversations,
  useModels,
  useToolApproval,
} from '@kontourai/station-sdk';
import { type ReactNode, useState } from 'react';
import {
  ActiveChatsProvider,
  activeChatsStore,
} from '../../contexts/ActiveChatsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { PluginWorkspacePaneSDKBoundary } from '../../workspace-panes/PluginWorkspacePaneSDKBoundary';

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  activeChatsStore.removeChat('sdk-core-test');
  vi.unstubAllGlobals();
  approval.mockReset();
});

function mountPlugin(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  clients.push(client);
  client.setQueryData(['agents'], { agents: [], catalogState: 'stable' });
  client.setQueryData(['projects', 'research', 'layouts'], []);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const responses: Record<string, unknown> = {
      '/config/app': { defaultModel: 'writer-v1' },
      '/api/models': [],
      '/agents/research-agent/conversations': [
        { id: 'research-conversation', resourceId: 'research-agent' },
      ],
    };
    if (!(path in responses))
      throw new Error(`Unexpected network request: ${path}`);
    return Response.json({ success: true, data: responses[path] });
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <ActiveChatsProvider>
          <ToastProvider>
            <PluginWorkspacePaneSDKBoundary
              layout={{ name: 'Research', slug: 'research-layout', tabs: [] }}
              pluginName="research-plugin"
              projectSlug="research"
            >
              {children}
            </PluginWorkspacePaneSDKBoundary>
          </ToastProvider>
        </ActiveChatsProvider>
      </NavigationProvider>
    </QueryClientProvider>,
  );
  return { client, fetch, ...view };
}

function CoreReads() {
  const config = useConfig();
  const models = useModels();
  const available = useAvailableModels();
  const chat = useActiveChatState('sdk-core-test');
  const conversations = useConversations('research-agent');
  return (
    <>
      <output data-testid="config">{config?.defaultModel ?? 'pending'}</output>
      <output data-testid="models">
        {models.map((model) => model.name).join(',')}
      </output>
      <output data-testid="available">
        {available.map((model) => model.id).join(',')}
      </output>
      <output data-testid="chat">{chat?.input ?? 'absent'}</output>
      <output data-testid="conversations">
        {conversations.map((item: { id: string }) => item.id).join(',')}
      </output>
    </>
  );
}

test('plugin reads the core config, normalized model catalog, exact Dock entry and requested Agent list reactively', async () => {
  function Deferred() {
    const [show, setShow] = useState(false);
    return show ? (
      <CoreReads />
    ) : (
      <button type="button" onClick={() => setShow(true)}>
        Read core
      </button>
    );
  }
  const host = mountPlugin(<Deferred />);
  expect(host.fetch).not.toHaveBeenCalled();
  host.client.setQueryData(
    ['conversations', 'research-agent'],
    [{ id: 'research-conversation', resourceId: 'research-agent' }],
  );
  host.client.setQueryData(
    ['conversations', 'research-layout'],
    [{ id: 'wrong-layout-list' }],
  );
  fireEvent.click(screen.getByRole('button', { name: 'Read core' }));
  expect(screen.getByTestId('config').textContent).toBe('pending');
  expect(screen.getByTestId('chat').textContent).toBe('absent');
  expect(screen.getByTestId('conversations').textContent).toBe(
    'research-conversation',
  );
  await waitFor(() =>
    expect(screen.getByTestId('config').textContent).toBe('writer-v1'),
  );
  act(() => {
    host.client.setQueryData(['config'], { defaultModel: 'writer-v2' });
    host.client.setQueryData(
      ['model-catalog'],
      [
        {
          modelId: 'writer-v2',
          modelName: 'Writer',
          outputModalities: ['TEXT'],
        },
        {
          modelId: 'image-only',
          modelName: 'Image',
          outputModalities: ['IMAGE'],
        },
      ],
    );
    activeChatsStore.initChat('sdk-core-test');
    activeChatsStore.updateChat('sdk-core-test', { input: 'Review sources' });
  });
  await waitFor(() =>
    expect(screen.getByTestId('config').textContent).toBe('writer-v2'),
  );
  expect(screen.getByTestId('models').textContent).toBe('Writer');
  expect(screen.getByTestId('available').textContent).toBe('writer-v2');
  expect(screen.getByTestId('chat').textContent).toBe('Review sources');
  act(() => activeChatsStore.removeChat('sdk-core-test'));
  expect(screen.getByTestId('chat').textContent).toBe('absent');
  expect(
    host.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname).sort(),
  ).toEqual([
    '/agents/research-agent/conversations',
    '/api/models',
    '/config/app',
  ]);
});

function ApprovalAction() {
  const respond = useToolApproval();
  const [result, setResult] = useState('pending');
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          setResult(
            await respond(
              'sdk-core-test',
              'research-agent',
              'approval-1',
              'search',
              'once',
            ),
          );
        } catch (error) {
          setResult(error instanceof Error ? error.message : 'failed');
        }
      }}
    >
      {result}
    </button>
  );
}

test('plugin approval reaches the core handler and keeps server refusal observable', async () => {
  approval
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false, error: 'Approval expired' });
  const host = mountPlugin(<ApprovalAction />);
  fireEvent.click(screen.getByRole('button', { name: 'pending' }));
  await screen.findByRole('button', { name: 'answered' });
  expect(approval).toHaveBeenCalledWith('approval-1', true);
  fireEvent.click(screen.getByRole('button', { name: 'answered' }));
  await screen.findByRole('button', { name: 'Approval expired' });
  expect(host.fetch).not.toHaveBeenCalled();
});
