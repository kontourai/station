/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  COPY_TOAST_FAILURE,
  COPY_TOAST_SUCCESS,
} from '../hooks/useCopyToClipboardToast';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost:3242',
  }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: showToastMock,
  }),
}));

vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));

vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));

vi.mock('../components/chat/SmoothStreamingMessage', () => ({
  SmoothStreamingMessage: () => (
    <div data-testid="smooth-streaming-message">Smooth streaming</div>
  ),
}));

vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));

vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { deviceSettingsStore } from '../lib/device-settings-store';

describe('ChatMessageList', () => {
  function resizeSession() {
    return {
      id: 'resize-session',
      agentSlug: agentId('dev-agent'),
      agentName: 'Dev Agent',
      title: 'Resize chat',
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      hasUnread: false,
      status: 'idle' as const,
      createdAt: 1,
      updatedAt: 1,
      source: 'manual' as const,
      messages: Array.from({ length: 10 }, (_, index) => ({
        role: 'user' as const,
        content: `message ${index}`,
        timestamp: index,
      })),
    };
  }

  function installScrollGeometry(container: HTMLElement) {
    let clientHeight = 400;
    let layoutShift = 0;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => clientHeight },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: clientHeight }) as DOMRect;
    Array.from(
      container.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
    ).forEach((node, index) => {
      node.getBoundingClientRect = () => {
        const top = index * 100 - container.scrollTop + layoutShift;
        return { top, bottom: top + 100 } as DOMRect;
      };
    });
    return {
      resize(nextClientHeight: number, nextLayoutShift: number) {
        clientHeight = nextClientHeight;
        layoutShift = nextLayoutShift;
      },
    };
  }

  test('layoutHeight preserves pinned-bottom and scrolled-up reader intent before ResizeObserver delivery', () => {
    const session = resizeSession();
    const view = render(
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        layoutHeight={400}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    const scroller =
      view.container.querySelector<HTMLElement>('.chat-messages')!;
    const geometry = installScrollGeometry(scroller);

    scroller.scrollTop = 600;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    geometry.resize(300, 0);
    view.rerender(
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        layoutHeight={300}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    expect(scroller.scrollTop).toBe(1_000);

    scroller.scrollTop = 200;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    geometry.resize(250, 50);
    view.rerender(
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        layoutHeight={250}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    expect(scroller.scrollTop).toBe(250);
  });

  test('materializes collision-safe anchors for fragment overrides and streaming', () => {
    const { container, unmount } = render(
      <ChatMessageList
        activeSession={{
          id: 'anchor-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Anchor chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'sending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [
            { role: 'user', content: 'one', timestamp: 1 },
            { role: 'assistant', content: 'two', timestamp: 1 },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    const anchors = Array.from(
      container.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
    );
    expect(anchors).toHaveLength(3);
    expect(
      new Set(anchors.map((node) => node.dataset.chatMessageKey)).size,
    ).toBe(3);
    unmount();
  });

  test('consumes a routed message anchor and reveals its transcript row', () => {
    const previousHash = window.location.hash;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    window.location.hash = 'station-message=returned-anchor';
    try {
      render(
        <ChatMessageList
          activeSession={{
            ...resizeSession(),
            id: 'routed-session',
            messages: [
              {
                id: 'returned-anchor',
                role: 'assistant',
                content: 'the search destination',
                timestamp: 1,
              },
            ],
          }}
          fontSize={14}
          showReasoning
          showToolDetails
          renderOverride={(message) => <>{message.content}</>}
        />,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    } finally {
      window.location.hash = previousHash;
    }
  });

  test('virtualizes a long transcript while preserving its accessible log surface', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${index}`,
      timestamp: index,
    }));
    const { container } = render(
      <ChatMessageList
        activeSession={{
          ...resizeSession(),
          id: 'long-session',
          messages,
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );

    expect(screen.getByRole('log', { name: 'Conversation transcript' })).toBe(
      container.querySelector('.chat-messages'),
    );
    expect(
      container.querySelectorAll('[data-transcript-row]').length,
    ).toBeLessThan(40);
  });

  test('keeps a short transcript on the direct DOM layout with identical row order and semantics', () => {
    const messages = [
      { role: 'user' as const, content: 'short question', timestamp: 1 },
      { role: 'assistant' as const, content: 'short answer', timestamp: 2 },
    ];
    const { container } = render(
      <ChatMessageList
        activeSession={{ ...resizeSession(), id: 'short-session', messages }}
        fontSize={14}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );

    const transcript = screen.getByRole('log', {
      name: 'Conversation transcript',
    });
    expect(container.querySelector('[data-transcript-row]')).toBeNull();
    expect(
      transcript.querySelector('[style*="position: absolute"]'),
    ).toBeNull();
    expect(
      Array.from(
        transcript.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
      ).map((row) => row.textContent),
    ).toEqual(['short question', 'short answer']);
  });

  test('renders settled work inline, inside the message row, in reading order', () => {
    // archive#2652 redesign: no "Show N work activities" gate — a settled
    // turn's activities interleave with its prose exactly as `contentParts`
    // orders them, as quiet rows inside the one message row.
    const messages = [
      {
        role: 'assistant' as const,
        content: 'Completed',
        timestamp: 1,
        contentParts: [
          {
            type: 'tool-invocation' as const,
            toolCallId: 'c1',
            toolName: 'search_docs',
            args: { query: 'anchor contract' },
            result: 'found',
          },
          { type: 'text' as const, content: 'Interleaved narration.' },
          {
            type: 'tool-invocation' as const,
            toolCallId: 'c2',
            toolName: 'read_file',
            args: { path: '/tmp/app.tsx' },
            result: 'ok',
          },
          { type: 'text' as const, content: 'Completed' },
        ],
      },
    ];
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ChatMessageList
          activeSession={{ ...resizeSession(), messages }}
          fontSize={14}
          showReasoning
          showToolDetails
        />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole('button', { name: /work activities/ }),
    ).toBeNull();
    const messageRow = container.querySelector('.message-row');
    expect(messageRow).toBeTruthy();
    const text = messageRow!.textContent ?? '';
    const order = [
      text.indexOf('Searched anchor contract'),
      text.indexOf('Interleaved narration.'),
      text.indexOf('Read app.tsx'),
      text.indexOf('Completed'),
    ];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('renders the streaming message when a session is active with no persisted messages', () => {
    render(
      <ChatMessageList
        activeSession={{
          id: 'session-1',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Dev Agent Chat',
          messages: [],
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'sending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
        }}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );

    expect(screen.getByTestId('streaming-message')).toBeTruthy();
    expect(screen.queryByText('Start a conversation')).toBeNull();
  });

  test('the device setting selects the smooth streaming consumer', () => {
    deviceSettingsStore.set('featureSettings', {
      ...deviceSettingsStore.get('featureSettings'),
      smoothReveal: true,
    });
    const rendered = render(
      <ChatMessageList
        activeSession={{
          id: 'session-smooth',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Smooth chat',
          messages: [],
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'sending',
          createdAt: 1,
          updatedAt: 1,
          source: 'manual',
        }}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );

    expect(screen.getByTestId('smooth-streaming-message')).toBeTruthy();
    expect(screen.queryByTestId('streaming-message')).toBeNull();
    rendered.unmount();
    deviceSettingsStore.reset('featureSettings');
  });

  test('keeps existing message nodes mounted when derived messages are cloned', () => {
    const message = {
      role: 'user' as const,
      content: 'Stable',
      timestamp: 7,
    };
    const session = {
      id: 'typing-session',
      agentSlug: agentId('dev-agent'),
      agentName: 'Dev Agent',
      title: 'Typing chat',
      input: '',
      attachments: [],
      queuedMessages: [],
      inputHistory: [],
      hasUnread: false,
      status: 'idle' as const,
      createdAt: 1,
      updatedAt: 1,
      source: 'manual' as const,
      messages: [message],
    };
    const { container, rerender } = render(
      <ChatMessageList
        activeSession={session}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );
    const before = container.querySelector('.message-row');

    rerender(
      <ChatMessageList
        activeSession={{
          ...session,
          input: 'a',
          messages: [{ ...message }],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );

    expect(container.querySelector('.message-row')).toBe(before);
  });

  // Both tests below render a REAL (non-overridden) assistant `MessageBubble`
  // row, which mounts `MessageRating` -> `useFeedbackRatingsQuery` -> a real
  // react-query hook that needs a `QueryClientProvider` ancestor (the three
  // tests above never hit this path: two render only user/empty messages,
  // and the third replaces MessageBubble entirely via `renderOverride`).
  function renderWithQueryClient(ui: ReactElement) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    );
  }

  test('station#1424 review fix (M2a): a real assistant row wires the owner prop through to the rendered "Managed by …" chip — removing the owner prop, or the MessageAttribution block that renders it, fails this test', () => {
    renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'owner-wiring-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'Owner wiring chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [
            { role: 'user', content: 'hi', timestamp: 1 },
            { role: 'assistant', content: 'hello there', timestamp: 2 },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
        owner={{ id: 'brian', label: 'Brian Anderson' }}
      />,
    );
    expect(screen.getByText(/via Brian Anderson/)).toBeTruthy();
  });

  test('omitting the owner prop renders no "Managed by …" chip at all (contrast case for the wiring test above)', () => {
    renderWithQueryClient(
      <ChatMessageList
        activeSession={{
          id: 'no-owner-session',
          agentSlug: agentId('dev-agent'),
          agentName: 'Dev Agent',
          title: 'No owner chat',
          input: '',
          attachments: [],
          queuedMessages: [],
          inputHistory: [],
          hasUnread: false,
          status: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'manual',
          messages: [
            { role: 'assistant', content: 'hello there', timestamp: 2 },
          ],
        }}
        fontSize={14}
        showReasoning
        showToolDetails
      />,
    );
    expect(screen.queryByText(/^via /)).toBeNull();
  });

  // archive#3341: the per-message copy called `navigator.clipboard.writeText`
  // with no optional chain, no await and no catch — an insecure origin threw a
  // synchronous TypeError before the toast, and a refused write toasted
  // "Copied to clipboard" from an unhandled rejection.
  describe('copy affordance (station#3341)', () => {
    function renderAssistantRow() {
      return renderWithQueryClient(
        <ChatMessageList
          activeSession={{
            id: 'copy-session',
            agentSlug: agentId('dev-agent'),
            agentName: 'Dev Agent',
            title: 'Copy chat',
            input: '',
            attachments: [],
            queuedMessages: [],
            inputHistory: [],
            hasUnread: false,
            status: 'idle',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            source: 'manual',
            messages: [
              { role: 'assistant', content: 'the answer', timestamp: 2 },
            ],
          }}
          fontSize={14}
          showReasoning
          showToolDetails
        />,
      );
    }

    beforeEach(() => {
      showToastMock.mockReset();
      clipboardAbsent();
    });

    afterEach(() => {
      clipboardAbsent();
    });

    test('reports a copy only once the write resolved', async () => {
      const writeText = clipboardWrites();
      renderAssistantRow();

      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

      expect(writeText).toHaveBeenCalledWith('the answer');
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_SUCCESS),
      );
    });

    test('a refused write toasts the failure, never "Copied to clipboard"', async () => {
      clipboardRefuses();
      renderAssistantRow();

      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_FAILURE),
      );
      expect(showToastMock).not.toHaveBeenCalledWith(COPY_TOAST_SUCCESS);
    });

    test('an insecure origin with no clipboard API toasts the failure and does not throw', async () => {
      clipboardAbsent();
      renderAssistantRow();

      fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(COPY_TOAST_FAILURE),
      );
      expect(showToastMock).not.toHaveBeenCalledWith(COPY_TOAST_SUCCESS);
    });
  });
});
