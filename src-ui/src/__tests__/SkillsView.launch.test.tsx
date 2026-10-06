// @vitest-environment jsdom

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { Skill } from '@kontourai/station-contracts/catalog';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import {
  NavigationProvider,
  navigationStore,
} from '../contexts/NavigationContext';
import { ToastProvider } from '../contexts/ToastContext';
import { SkillsView } from '../views/SkillsView';

const API_BASE = 'http://skill-launch.test';
const skill: Skill = {
  id: 'release-check',
  name: 'release-check',
  installed: true,
  writable: true,
  origin: 'user',
  body: 'Review {{topic}} in {{env}}',
  variables: [{ name: 'topic' }, { name: 'env', default: 'staging' }],
};
const agents = [{ slug: agentId('codex'), name: 'Codex' }];
let availableAgents = agents;
let refuseSend = false;
let queryClient: QueryClient;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    ).pathname;
    if (path === '/api/system/skills')
      return json({ success: true, data: [skill] });
    if (path === '/api/skills/release-check')
      return json({ success: true, data: skill });
    if (path === '/api/agents')
      return json({ success: true, data: availableAgents });
    if (path === '/api/connections/agents')
      return json({ success: true, data: [] });
    if (path === '/api/orchestration/chat') {
      if (refuseSend)
        return json({ success: false, error: 'Engine sign-in required' }, 403);
      const body: { conversationId: string } = JSON.parse(String(init?.body));
      return json({
        success: true,
        data: {
          conversationId: body.conversationId,
          sessionId: 'execution-session',
          providerTurnId: 'provider-turn',
        },
      });
    }
    if (path === '/api/skills/release-check/run')
      return json({
        success: true,
        data: {
          stats: { runs: 1, successes: 0, failures: 0, qualityScore: null },
        },
      });
    throw new Error(`Unexpected network request: ${path}`);
  },
);

function requests(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));
}

function mountLibrary() {
  const values = new Map<string, string>();
  const connections = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  connections.add('Test Station', API_BASE);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionsProvider store={connections} defaultUrl={API_BASE}>
        <NavigationProvider>
          <KeyboardShortcutsProvider>
            <ToastProvider>
              <ActiveChatsProvider>
                <SkillsView basePath="/guidance" />
              </ActiveChatsProvider>
            </ToastProvider>
          </KeyboardShortcutsProvider>
        </NavigationProvider>
      </ConnectionsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  availableAgents = agents;
  refuseSend = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  _setApiBase(API_BASE);
  navigationStore.setActiveChat(null);
  navigationStore.setDockState(false);
  navigationStore.navigate('/guidance/release-check', { tab: 'skills' });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  for (const id of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(id);
  navigationStore.setActiveChat(null);
  navigationStore.setDockState(false);
  navigationStore.navigate('/');
  vi.unstubAllGlobals();
});

async function startSkill() {
  mountLibrary();
  const useSkill = await screen.findByRole('button', {
    name: 'Use in a new chat',
  });
  await waitFor(() =>
    expect((useSkill as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(useSkill);
  expect(
    (screen.getByRole('button', { name: 'Start chat' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('topic'), {
    target: { value: 'garden' },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Start chat' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  await waitFor(() =>
    expect(requests('/api/skills/release-check/run')).toHaveLength(1),
  );
  const selected = navigationStore.getSnapshot().activeChat;
  expect(selected).not.toBeNull();
  if (!selected) throw new Error('The new chat was not selected');
  return { selected, chat: activeChatsStore.getSnapshot()[selected] };
}

test('Start selects the created chat and dispatches substituted content through the real send owner', async () => {
  const { selected, chat } = await startSkill();
  expect(navigationStore.getSnapshot().isDockOpen).toBe(true);
  expect(chat.title).toBe('release-check');
  expect(chat.agentSlug).toBe('codex');
  expect(chat.currentSessionId).toBe('execution-session');
  if (!chat.messages)
    throw new Error('The selected chat has no transcript messages');
  expect(
    chat.messages.find((message) => message.role === 'user')?.content,
  ).toBe('Review garden in staging');
  const sends = requests('/api/orchestration/chat');
  expect(sends).toHaveLength(1);
  expect(JSON.parse(String(sends[0][1]?.body))).toMatchObject({
    target: { agent: 'codex' },
    conversationId: selected,
    message: 'Review garden in staging',
  });
  expect(requests('/api/skills/release-check/outcome')).toHaveLength(0);
});

test('a refused dispatch leaves the created chat selected with its retry draft and error', async () => {
  refuseSend = true;
  const { chat } = await startSkill();
  expect(requests('/api/orchestration/chat')).toHaveLength(1);
  expect(chat.status).toBe('error');
  expect(chat.error).toContain('Engine sign-in required');
  expect(chat.input).toBe('Review garden in staging');
  expect(chat.currentSessionId).toBeUndefined();
  expect(requests('/api/skills/release-check/outcome')).toHaveLength(0);
});

test('an empty agent catalog cannot create a chat, dispatch, or record a skill use', async () => {
  availableAgents = [];
  mountLibrary();
  const useSkill = await screen.findByRole('button', {
    name: 'Use in a new chat',
  });
  await waitFor(() =>
    expect((useSkill as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(useSkill);
  await screen.findByText(/No agents are available/);
  fireEvent.change(screen.getByLabelText('topic'), {
    target: { value: 'garden' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  expect(navigationStore.getSnapshot().activeChat).toBeNull();
  expect(Object.keys(activeChatsStore.getSnapshot())).toHaveLength(0);
  expect(requests('/api/orchestration/chat')).toHaveLength(0);
  expect(requests('/api/skills/release-check/run')).toHaveLength(0);
});
