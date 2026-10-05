/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
import { CHAT_READER_RESTORE_EVENT } from '../components/chat/chatScrollAnchor';
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

  test('a transcript shrunk to nothing is not a reader scrolling up', () => {
    render(
      <ChatMessageList
        activeSession={resizeSession()}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
      />,
    );
    const log = screen.getByRole('log');
    const geometry = installScrollGeometry(log);
    // A short dock gives the composer priority and the transcript no height;
    // the scroll event that collapse dispatches is layout, not the reader.
    geometry.resize(0, 0);
    log.scrollTop = 200;
    fireEvent.scroll(log);
    expect(
      screen.queryByRole('button', { name: 'Scroll to bottom' }),
    ).toBeNull();
    // With height again, the same position IS the reader having scrolled up.
    geometry.resize(400, 0);
    fireEvent.scroll(log); // the resize's own event is re-anchored, not read
    log.scrollTop = 200;
    fireEvent.scroll(log);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
  });

  test('loads older messages only on reader scroll near the top and coalesces pending requests', async () => {
    let finish!: () => void;
    const loadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <ChatMessageList
        activeSession={resizeSession()}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        hasOlderMessages
        onLoadOlder={loadOlder}
      />,
    );
    const log = screen.getByRole('log');
    installScrollGeometry(log);
    expect(
      log.contains(screen.getByRole('button', { name: 'Earlier messages' })),
    ).toBe(true);
    // Any scroll movement counts, whatever the device: a keyboard or scrollbar
    // scroll near the top loads, with no wheel/touch/pointer precursor needed.
    // (50, not 0: the mount's own pin wrote 0, and its echo must not load.)
    log.scrollTop = 50;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    fireEvent.wheel(log);
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    log.scrollTop = 300;
    fireEvent.wheel(log);
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  // Drives the press -> page commit -> restoration sequence by hand. The
  // transcript's scrollHeight is a getter the test controls, so "the page
  // prepended" and "the layout is still moving" are explicit.
  function pressAndCommit(options: {
    layoutSettles: boolean;
    sessionId?: string;
    onLoadOlder: () => Promise<void>;
  }) {
    const view = render(
      <ChatMessageList
        activeSession={{
          ...resizeSession(),
          ...(options.sessionId ? { id: options.sessionId } : {}),
        }}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        hasOlderMessages
        onLoadOlder={options.onLoadOlder}
      />,
    );
    const log = screen.getByRole('log');
    installScrollGeometry(log);
    let height = 1_000;
    let reads = 0;
    Object.defineProperty(log, 'scrollHeight', {
      configurable: true,
      // A layout that never settles grows on every read.
      get: () => (options.layoutSettles ? height : height + reads++),
    });
    return {
      view,
      log,
      press: screen.getByRole('button', { name: 'Earlier messages' }),
      prependPage() {
        height = 3_000;
      },
    };
  }
  // Waits for `count` animation frames, so the test's clock is the frame loop
  // under test rather than a guessed number of milliseconds.
  const framesElapsed = (count: number) =>
    act(async () => {
      await new Promise<void>((resolve) => {
        let frames = 0;
        const tick = () =>
          ++frames >= count ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      });
    });

  test("one press loads one page: the stretch from the request settling to the reader's row coming back is still in flight", async () => {
    const releaseLoads: Array<() => void> = [];
    const loadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLoads.push(resolve);
        }),
    );
    const { log, press, prependPage } = pressAndCommit({
      layoutSettles: true,
      onLoadOlder: loadOlder,
    });
    log.scrollTop = 300;
    fireEvent.click(press);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // The request settles, but React has not committed the page it carries
    // (nothing here flushes it): the DOM still shows the old top and the
    // button enabled. A press landing here is not a second request.
    releaseLoads[0]();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    fireEvent.click(press);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // The page commits, and the browser reports scrollTop inside the band
    // against the grown content before the virtualizer has walked the reader's
    // row back. That unmarked scroll event is the press's own restoration, not
    // the reader.
    prependPage();
    log.scrollTop = 0;
    await act(async () => {});
    fireEvent.scroll(log);
    log.scrollTop = 50;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // Restored and still for real: the suppression ends by itself, and the
    // reader reaching the top again loads the next page by design (#2706).
    log.scrollTop = 300;
    await framesElapsed(12);
    log.scrollTop = 20;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['wheel', (log: HTMLElement) => fireEvent.wheel(log)],
    ['touchstart', (log: HTMLElement) => fireEvent.touchStart(log)],
    ['pointerdown', (log: HTMLElement) => fireEvent.pointerDown(log)],
    ['keydown', (log: HTMLElement) => fireEvent.keyDown(log, { key: 'Home' })],
  ])(
    'reader %s ends the restoration suppression even when the layout never settles',
    async (_name, input) => {
      const loadOlder = vi.fn(async () => {});
      const { log, press, prependPage } = pressAndCommit({
        layoutSettles: false,
        onLoadOlder: loadOlder,
      });
      log.scrollTop = 300;
      fireEvent.click(press);
      await act(async () => {});
      prependPage();
      log.scrollTop = 0;
      fireEvent.scroll(log);
      await act(async () => {});
      // Restoration is still moving the layout, so the band is still ours...
      fireEvent.scroll(log);
      expect(loadOlder).toHaveBeenCalledTimes(1);
      // ...until the reader acts: their scroll to the top loads one page now,
      // not after the suppression's frame cap.
      input(log);
      log.scrollTop = 40;
      fireEvent.scroll(log);
      expect(loadOlder).toHaveBeenCalledTimes(2);
    },
  );

  test('a chat switch mid-restoration does not carry the suppression or the request into the new chat', async () => {
    const releaseLoads: Array<() => void> = [];
    const loadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLoads.push(resolve);
        }),
    );
    const { view, log, press } = pressAndCommit({
      layoutSettles: false,
      onLoadOlder: loadOlder,
    });
    log.scrollTop = 300;
    fireEvent.click(press);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // Switch chats while the first chat's request is still in flight.
    view.rerender(
      <ChatMessageList
        activeSession={{ ...resizeSession(), id: 'other-session' }}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        hasOlderMessages
        onLoadOlder={loadOlder}
      />,
    );
    // The new chat's reader reaching the top loads at once.
    log.scrollTop = 50;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    // The old chat's request settling late must not release or hold the new
    // chat's request.
    releaseLoads[0]();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    releaseLoads[1]();
    await act(async () => {});
  });

  test('a page that grew the content leaves the suppression on while the reader still sits in the band, however still the layout is', async () => {
    const loadOlder = vi.fn(async () => {});
    const { log, press, prependPage } = pressAndCommit({
      layoutSettles: true,
      onLoadOlder: loadOlder,
    });
    log.scrollTop = 300;
    fireEvent.click(press);
    await act(async () => {});
    // The page prepended and the browser left the reader at the top of the
    // grown content: not restored yet. Nothing moves for many frames, which on
    // its own would count as settled.
    prependPage();
    log.scrollTop = 0;
    await framesElapsed(12);
    log.scrollTop = 50;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  test('a layout that has held still for only a couple of frames is not settled yet', async () => {
    const loadOlder = vi.fn(async () => {});
    const { log, press, prependPage } = pressAndCommit({
      layoutSettles: true,
      onLoadOlder: loadOlder,
    });
    log.scrollTop = 300;
    fireEvent.click(press);
    await act(async () => {});
    prependPage();
    // Restored position, held for only a couple of frames: a reader scroll
    // into the band inside that stretch is still the restoration's. This
    // rules out a threshold of 1; it does not tell 3 from 4.
    await framesElapsed(3);
    log.scrollTop = 50;
    fireEvent.scroll(log);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  test('a request still in flight for the previous chat neither loads nor releases anything in the new chat', async () => {
    const releaseLoads: Array<() => void> = [];
    const loadOlder = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseLoads.push(resolve);
        }),
    );
    const { view, log, press } = pressAndCommit({
      layoutSettles: true,
      onLoadOlder: loadOlder,
    });
    log.scrollTop = 300;
    fireEvent.click(press);
    view.rerender(
      <ChatMessageList
        activeSession={{ ...resizeSession(), id: 'other-session' }}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        hasOlderMessages
        onLoadOlder={loadOlder}
      />,
    );
    // The new chat has its own request in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    expect(loadOlder).toHaveBeenCalledTimes(2);
    // The old chat's request settles late. It must not release the new chat's
    // request, so a further press is still coalesced into it.
    releaseLoads[0]();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  test('a load that settles with nothing to commit still releases the in-flight request', async () => {
    const loadOlder = vi.fn(async () => {});
    render(
      <ChatMessageList
        activeSession={resizeSession()}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        hasOlderMessages
        onLoadOlder={loadOlder}
      />,
    );
    installScrollGeometry(screen.getByRole('log'));
    const press = screen.getByRole('button', { name: 'Earlier messages' });
    fireEvent.click(press);
    await waitFor(() => {
      fireEvent.click(press);
      expect(loadOlder).toHaveBeenCalledTimes(2);
    });
  });

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

  test('scrolling to latest releases a restored reader anchor through later layout and message growth', () => {
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
    const scroller = screen.getByRole('log');
    installScrollGeometry(scroller);
    const anchor = scroller.querySelector<HTMLElement>(
      '[data-chat-message-key]',
    )!;
    scroller.scrollTop = 200;
    fireEvent(
      scroller,
      new CustomEvent(CHAT_READER_RESTORE_EVENT, {
        cancelable: true,
        detail: {
          anchor: {
            key: anchor.dataset.chatMessageKey,
            offset: anchor.getBoundingClientRect().top,
          },
          scrollTop: 200,
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(scroller.scrollTop).toBe(1_000);

    view.rerender(
      <ChatMessageList
        activeSession={{
          ...session,
          messages: [
            ...session.messages,
            { role: 'assistant', content: 'new answer', timestamp: 11 },
          ],
        }}
        fontSize={14}
        layoutHeight={350}
        showReasoning
        showToolDetails
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    expect(scroller.scrollTop).toBe(1_000);
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
    expect(screen.queryByText('Start a chat')).toBeNull();
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
        owner={{ id: 'casey', label: 'Casey Example' }}
      />,
    );
    expect(screen.getByText(/via Casey Example/)).toBeTruthy();
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

  test('a projected open turn re-pins the tail as its content streams in', () => {
    // #2594 projects a live turn into the transcript window and suppresses
    // the streaming shell — the only scroll-follow trigger the shell's
    // per-flush `onContentChange` used to provide. Pure-text streaming then
    // grows one row's content without changing `messages.length`, so the
    // row's own growth must re-pin a pinned transcript.
    const base = {
      ...resizeSession(),
      id: 'projected-stream',
      orchestrationSessionStarted: true,
      orchestrationTurnOpen: true,
      openTurnId: 'turn-1',
      messages: [
        { role: 'user' as const, content: 'hi', timestamp: 1 },
        { role: 'assistant' as const, content: 'partial', timestamp: 2 },
      ],
    };
    const view = render(
      <ChatMessageList
        activeSession={base}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    const scroller = screen.getByRole('log');
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    // Pinned: the reader sits at the bottom as deltas arrive.
    scroller.scrollTop = 1_000;
    scrollHeight = 1_500;
    view.rerender(
      <ChatMessageList
        activeSession={{
          ...base,
          messages: [
            { role: 'user' as const, content: 'hi', timestamp: 1 },
            {
              role: 'assistant' as const,
              content: 'partial answer with more streamed tokens',
              timestamp: 2,
            },
          ],
        }}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    expect(scroller.scrollTop).toBe(1_500);
  });

  test('a scrolled-up reader can return through the composer control and resume following', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const base = {
      ...resizeSession(),
      id: 'projected-stream-reader',
      orchestrationSessionStarted: true,
      orchestrationTurnOpen: true,
      openTurnId: 'turn-1',
      messages: [
        { role: 'user' as const, content: 'hi', timestamp: 1 },
        { role: 'assistant' as const, content: 'partial', timestamp: 2 },
      ],
    };
    const view = render(
      <ChatMessageList
        activeSession={base}
        scrollControlsTarget={target}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    const scroller = screen.getByRole('log');
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => 1_000 },
    });
    scroller.scrollTop = 1_000;
    // The reader scrolls up while the projected turn keeps streaming.
    scroller.scrollTop = 200;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    expect(target.contains(button)).toBe(true);
    fireEvent.click(button);
    expect(scroller.scrollTop).toBe(1_000);
    // Follow resumes: the next projected delta re-pins without another click.
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => 1_500,
    });
    view.rerender(
      <ChatMessageList
        activeSession={{
          ...base,
          messages: [
            { role: 'user' as const, content: 'hi', timestamp: 1 },
            {
              role: 'assistant' as const,
              content: 'partial answer with more streamed tokens',
              timestamp: 2,
            },
          ],
        }}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
    expect(scroller.scrollTop).toBe(1_500);
    target.remove();
  });

  function projectedStreamSession(id: string) {
    return {
      ...resizeSession(),
      id,
      orchestrationSessionStarted: true,
      orchestrationTurnOpen: true,
      openTurnId: 'turn-1',
      messages: [
        { role: 'user' as const, content: 'hi', timestamp: 1 },
        { role: 'assistant' as const, content: 'partial', timestamp: 2 },
      ],
    };
  }

  function renderProjectedStream(
    session: ReturnType<typeof projectedStreamSession>,
  ) {
    return render(
      <ChatMessageList
        activeSession={session}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
  }

  function growProjectedTail(
    view: ReturnType<typeof render>,
    session: ReturnType<typeof projectedStreamSession>,
    content: string,
  ) {
    view.rerender(
      <ChatMessageList
        activeSession={{
          ...session,
          messages: [
            { role: 'user' as const, content: 'hi', timestamp: 1 },
            { role: 'assistant' as const, content, timestamp: 2 },
          ],
        }}
        suppressStreamingRow
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        renderOverride={(message) => <>{message.content}</>}
      />,
    );
  }

  test('scroll movement without a wheel precursor still stops the follow', () => {
    // Keyboard scrolling and scrollbar drags dispatch `scroll` with no
    // wheel/touch/pointer event before them. They are still the reader
    // moving — the stream must not yank them back down.
    const base = projectedStreamSession('projected-stream-noprecursor');
    const view = renderProjectedStream(base);
    const scroller = screen.getByRole('log');
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 1_000;
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
    scrollHeight = 1_500;
    growProjectedTail(view, base, 'partial answer with more streamed tokens');
    expect(scroller.scrollTop).toBe(200);
  });

  test('our own pin writes do not read as reader movement', () => {
    const base = projectedStreamSession('projected-stream-echo');
    const view = renderProjectedStream(base);
    const scroller = screen.getByRole('log');
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 1_000;
    scrollHeight = 1_500;
    growProjectedTail(view, base, 'partial answer with more streamed tokens');
    expect(scroller.scrollTop).toBe(1_500);
    // The pin's own scroll echo lands on the write: no affordance appears.
    fireEvent.scroll(scroller);
    expect(
      screen.queryByRole('button', { name: 'Scroll to bottom' }),
    ).toBeNull();
  });

  test('scrolling back to the bottom resumes the follow', () => {
    const base = projectedStreamSession('projected-stream-return');
    const view = renderProjectedStream(base);
    const scroller = screen.getByRole('log');
    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroller.scrollTop = 1_000;
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeTruthy();
    // Back to the tail with no wheel precursor: pinned again, no button.
    scroller.scrollTop = 1_000;
    fireEvent.scroll(scroller);
    expect(
      screen.queryByRole('button', { name: 'Scroll to bottom' }),
    ).toBeNull();
    scrollHeight = 1_500;
    growProjectedTail(view, base, 'partial answer with more streamed tokens');
    expect(scroller.scrollTop).toBe(1_500);
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
