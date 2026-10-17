// @vitest-environment jsdom
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { _setApiBase } from '../../../packages/sdk/src/api-core';
import {
  openConversationForDock,
  retryActiveConversationForDock,
} from '../components/chat-dock/conversationOpenController';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  ConversationsProvider,
  conversationsStore,
} from '../contexts/ConversationsContext';
import { workObservation } from '../contexts/work-observation';
import { useChatDockActions } from '../hooks/useChatDockActions';

// Only the active-chat/navigation action boundary is instrumented. Resolution,
// dock actions, hydration, message store and SDK response readers are real.
const actions = vi.hoisted(() => ({
  initChat: vi.fn(),
  updateChat: vi.fn(),
  removeChat: vi.fn(),
  setActiveChat: vi.fn(),
  setDockState: vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    lastDockMaximized: false,
    setDockState: actions.setDockState,
    setActiveChat: actions.setActiveChat,
  }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => actions,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => vi.fn(),
}));

function resolution(
  id: string,
  sequence = 2,
): Extract<ConversationOpenResolution, { status: 'resolved' }> {
  return {
    status: 'resolved',
    conversation: {
      id,
      source: 'runtime',
      agentSlug: agentId('demo-agent'),
      title: 'Open transcript',
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
      messageCount: 1,
      mutable: false,
      answerability: { answerable: true },
    },
    currentSessionId: id,
    activity: {
      conversationId: id,
      asOfSequence: sequence,
    },
    transcript: { available: true, owner: 'runtime', messageCount: 1 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}

function mountOpen(id: string) {
  actions.initChat.mockImplementation((id, metadata) =>
    activeChatsStore.initChat(id, metadata),
  );
  actions.updateChat.mockImplementation((id, patch) =>
    activeChatsStore.updateChat(id, patch),
  );
  actions.removeChat.mockImplementation((id) =>
    activeChatsStore.removeChat(id),
  );
  _setApiBase('http://test.local');
  const client = new QueryClient();
  const observation = workObservation(client);
  const focus = vi.fn();
  const patch = vi.fn();
  const recovery = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ConversationsProvider>{children}</ConversationsProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const chats = useSyncExternalStore(
        activeChatsStore.subscribe,
        activeChatsStore.getSnapshot,
      );
      return useChatDockActions({
        sessions: Object.entries(chats).map(([id, chat]) => ({
          id,
          conversationId: chat.conversationId,
          agentSlug: chat.agentSlug!,
        })),
        agents: [{ slug: agentId('demo-agent'), name: 'Demo agent' }],
        activeSessionId: null,
        setActiveSessionId: focus,
      });
    },
    { wrapper },
  );
  const effects: Parameters<typeof openConversationForDock>[1] = {
    apiBase: 'http://test.local',
    observation,
    open: (
      conversationId,
      agent,
      _project,
      _name,
      _model,
      _updated,
      _accepted,
      execution,
    ) => hook.result.current.openConversation(conversationId, agent, execution),
    projectName: () => undefined,
    findTab: () => actions.initChat.mock.calls[0]?.[0],
    updateChat: patch,
    setRecovery: recovery,
  };
  return {
    client,
    observation,
    focus,
    patch,
    recovery,
    effects,
    id,
    dock: hook.result,
    close: () => {
      hook.unmount();
      client.clear();
    },
  };
}

afterEach(() => {
  for (const id of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(id);
  activeChatsStore.flushPendingSave();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  _setApiBase('');
});

it.each(['picker', 'retry'] as const)(
  '%s works without AbortSignal.any',
  async (command) => {
    const h = mountOpen(`no-any-${command}`);
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
    Reflect.deleteProperty(AbortSignal, 'any');
    const fetch = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/open'))
        return Response.json({ success: true, data: resolution(h.id) });
      if (String(url).endsWith('/messages'))
        return Response.json({ success: true, data: [] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await act(async () => {
        if (command === 'picker')
          expect(
            await openConversationForDock(
              resolution(h.id).conversation,
              h.effects,
            ),
          ).toBe(true);
        else
          await retryActiveConversationForDock(
            'tab',
            h.id,
            h.effects.apiBase,
            h.patch,
            h.recovery,
            undefined,
            h.observation,
          );
      });
      expect(fetch).toHaveBeenCalled();
      expect(h.patch).toHaveBeenCalledOnce();
      if (command === 'picker') expect(h.focus).toHaveBeenCalledOnce();
      expect(h.recovery).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error' }),
      );
      expect(h.observation.unavailable(h.id)).toBe(false);
    } finally {
      Object.defineProperty(AbortSignal, 'any', descriptor);
      h.close();
    }
  },
);

it.each(['picker', 'retry'] as const)(
  'old-epoch %s resolution cannot open, patch or publish activity',
  async (command) => {
    const h = mountOpen(`old-${command}`);
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/open'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (String(url).endsWith('/messages'))
        return Response.json({ success: true, data: [] });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const opening =
        command === 'picker'
          ? openConversationForDock(resolution(h.id).conversation, h.effects)
          : retryActiveConversationForDock(
              'tab',
              h.id,
              h.effects.apiBase,
              h.patch,
              h.recovery,
              undefined,
              h.observation,
            );
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      h.observation.resetStreamEpoch();
      h.observation.observed(h.id, 1);
      await act(async () => {
        finish(Response.json({ success: true, data: resolution(h.id, 100) }));
        await opening;
      });
      expect(actions.initChat).not.toHaveBeenCalled();
      expect(h.focus).not.toHaveBeenCalled();
      expect(h.patch).not.toHaveBeenCalled();
      expect(h.recovery).not.toHaveBeenCalled();
      h.observation.read(h.id, 'history')!.failed();
      h.observation.streamObserved(resolution(h.id, 2).activity!);
      expect(h.observation.unavailable(h.id)).toBe(false);
    } finally {
      h.close();
    }
  },
);

it('a pruned observation stays retired while its picker open hydrates and focuses', async () => {
  const h = mountOpen('pruned-picker');
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/open'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (String(url).endsWith('/messages'))
        return Response.json({
          success: true,
          data: [
            {
              id: 'm1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Retained transcript' }],
            },
          ],
        });
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  try {
    const opening = openConversationForDock(
      resolution(h.id).conversation,
      h.effects,
    );
    await waitFor(() => expect(finish).toBeDefined());
    const token = h.observation.read(h.id, 'history')!;
    await h.client.fetchQuery({
      queryKey: ['conversation-inventory'],
      queryFn: async () => ({
        pages: [{ items: [], hasMore: true }],
        pageParams: [undefined],
      }),
    });
    expect(token.current()).toBe(false);
    await act(async () => {
      finish(Response.json({ success: true, data: resolution(h.id, 100) }));
      expect(await opening).toBe(true);
    });
    expect(h.focus).toHaveBeenCalledOnce();
    expect(h.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ currentSessionId: h.id }),
    );
    expect(h.observation.unavailable(h.id)).toBeUndefined();
    token.failed();
    token.observed(100);
    expect(h.observation.unavailable(h.id)).toBeUndefined();
    // Reopened consumers can admit evidence without the retired read's high fence.
    const release = h.observation.subscribe(h.id, () => {});
    h.observation.read(h.id, 'history')!.failed();
    h.observation.streamObserved(resolution(h.id, 2).activity!);
    expect(h.observation.unavailable(h.id)).toBe(false);
    release();
  } finally {
    h.close();
  }
});

it('a healthy progressive 1 MiB hydration completes after 36 seconds without recovery', async () => {
  const h = mountOpen('slow-picker');
  vi.useFakeTimers();
  let sent = 0;
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      success: true,
      data: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }],
        },
      ],
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/open'))
        return Response.json({ success: true, data: resolution(h.id) });
      if (String(url).endsWith('/messages'))
        return new Response(
          new ReadableStream({
            start(controller) {
              const tick = () => {
                const end = Math.min(sent + 32768, bytes.length);
                controller.enqueue(bytes.slice(sent, end));
                sent = end;
                if (sent === bytes.length) controller.close();
                else setTimeout(tick, 1100);
              };
              setTimeout(tick, 1100);
            },
          }),
        );
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  try {
    let settled = false;
    const opening = openConversationForDock(
      resolution(h.id).conversation,
      h.effects,
    ).then((value) => {
      settled = true;
      return value;
    });
    await act(async () => {
      await vi.waitFor(() => expect(actions.initChat).toHaveBeenCalledOnce());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(sent).toBeGreaterThan(800000);
    expect(sent).toBeLessThan(bytes.length);
    expect(settled).toBe(false);
    expect(h.recovery).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
      expect(await opening).toBe(true);
    });
    expect(h.focus).toHaveBeenCalledOnce();
    expect(h.patch).toHaveBeenCalledOnce();
    expect(h.recovery).toHaveBeenCalledExactlyOnceWith(null);
    expect(actions.removeChat).not.toHaveBeenCalled();
    expect(
      conversationsStore.getSnapshot().messages[`messages:demo-agent:${h.id}`],
    ).toHaveLength(1);
    console.log('progressive hydration', {
      wireBytes: bytes.length,
      chunkBytes: 32768,
      intervalMs: 1100,
      transferMs: Math.ceil(bytes.length / 32768) * 1100,
    });
  } finally {
    h.close();
  }
});

function messageResponse() {
  return Response.json({
    success: true,
    data: [
      {
        id: 'current-message',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Current transcript' }],
      },
    ],
  });
}
function transport(id: string) {
  let finish!: (r: Response) => void;
  const fetch = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/open'))
      return Response.json({ success: true, data: resolution(id) });
    if (String(url).endsWith('/messages'))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    finish: () => finish(messageResponse()),
    ready: () => waitFor(() => expect(finish).toBeDefined()),
  };
}
it.each(['second-open', 'focus-shortcut', 'switch-away-and-back'] as const)(
  'same epoch %s preserves healthy hydration',
  async (mode) => {
    const h = mountOpen(`ordinary-${mode}`);
    const t = transport(h.id);
    try {
      const opening = openConversationForDock(
        resolution(h.id).conversation,
        h.effects,
      );
      await t.ready();
      const tab = actions.initChat.mock.calls[0]![0];
      expect(activeChatsStore.getSnapshot()[tab]).toBeDefined();
      await act(async () => {
        if (mode === 'second-open')
          expect(
            await openConversationForDock(
              resolution(h.id).conversation,
              h.effects,
            ),
          ).toBe(true);
        else {
          if (mode === 'switch-away-and-back') {
            activeChatsStore.initChat('other', {
              agentSlug: 'demo-agent',
              agentName: 'Demo agent',
              title: 'Other chat',
            });
            h.dock.current.focusSession('other');
          }
          h.dock.current.focusSession(tab);
        }
      });
      expect(h.focus).toHaveBeenLastCalledWith(tab);
      await act(async () => {
        t.finish();
        await opening;
      });
      expect(actions.removeChat).not.toHaveBeenCalled();
      expect(
        Object.values(activeChatsStore.getSnapshot()).filter(
          (c) => c.conversationId === h.id,
        ),
      ).toHaveLength(1);
      expect(activeChatsStore.getSnapshot()[tab]?.messages).toHaveLength(1);
      expect(
        conversationsStore.getSnapshot().messages[
          `messages:demo-agent:${h.id}`
        ],
      ).toHaveLength(1);
    } finally {
      h.close();
    }
  },
);

it('epoch replacement discards old hydration without removing a reopened tab', async () => {
  const h = mountOpen('epoch-adopted-hydration');
  const t = transport(h.id);
  try {
    const opening = openConversationForDock(
      resolution(h.id).conversation,
      h.effects,
    );
    await t.ready();
    const tab = actions.initChat.mock.calls[0]![0];
    h.observation.resetStreamEpoch();
    await act(async () =>
      expect(
        await openConversationForDock(resolution(h.id).conversation, h.effects),
      ).toBe(true),
    );
    await act(async () => {
      t.finish();
      expect(await opening).toBe(false);
    });
    expect(activeChatsStore.getSnapshot()[tab]).toBeDefined();
    expect(activeChatsStore.getSnapshot()[tab]?.messages ?? []).toEqual([]);
    expect(
      conversationsStore.getSnapshot().messages[`messages:demo-agent:${h.id}`],
    ).toBeUndefined();
    expect(actions.removeChat).not.toHaveBeenCalled();
    expect(h.recovery).toHaveBeenCalledExactlyOnceWith(null);
  } finally {
    h.close();
  }
});
