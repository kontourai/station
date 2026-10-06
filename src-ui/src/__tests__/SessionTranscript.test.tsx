// @vitest-environment jsdom

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The session detail's conversation reads the chat dock's source: a durable
 * window (stubbed here as the server's answer) plus the document-wide
 * sequenced live store (REAL here, fed the way the app-wide stream feeds it).
 * The per-session live feed it used to read kept only 200 frames, so a long
 * answer lost its opening words and an early tool call vanished.
 */

const windowState = vi.hoisted(() => ({
  events: [] as Array<{ sequence: number; event: unknown }>,
  watermark: 0,
  settled: true,
  hasMore: false,
  loadOlder: vi.fn(),
  reload: vi.fn(),
  revisions: [] as number[],
  error: undefined as Error | undefined,
  upgradeRequired: false,
}));

vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: (
    _apiBase: string,
    _threadId: string | null,
    revision = 0,
  ) => {
    windowState.revisions.push(revision);
    return {
      events: windowState.events,
      watermark: windowState.watermark,
      handoffs: [],
      contextBoundaries: [],
      hasMore: windowState.hasMore,
      loadOlder: windowState.loadOlder,
      reload: windowState.reload,
      upgradeRequired: windowState.upgradeRequired,
      error: windowState.error,
      loading: false,
      settled: windowState.settled,
      catchingUp: false,
    };
  },
}));

const ensureStream = vi.hoisted(() => vi.fn(() => () => {}));
vi.mock('../hooks/orchestration/ensureOrchestrationEventStream', () => ({
  ensureOrchestrationEventStream: ensureStream,
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionTranscript } from '../components/session-detail/SessionTranscript';
import { PreviewProvider } from '../contexts/PreviewContext';
import {
  recordSequencedLiveEvent,
  resetSequencedLiveEventsForTests,
} from '../hooks/orchestration/sequencedLiveEvents';

const API = 'http://station.test';
const THREAD = 'station:thread-transcript';
let n = 0;
let sequence = 0;
const ev = (
  event: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({
    eventId: `t${n++}`,
    provider: 'station',
    threadId: THREAD,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...event,
  }) as unknown as CanonicalRuntimeEvent;

function live(events: CanonicalRuntimeEvent[]) {
  act(() => {
    for (const event of events)
      recordSequencedLiveEvent(API, event, (sequence += 1));
  });
}

function renderTranscript(
  isStreaming = true,
  failureShownAbove = false,
  scrollContainerRef?: { current: HTMLDivElement | null },
) {
  const session = { threadId: THREAD, conversationId: THREAD };
  // The app mounts PreviewProvider above every surface (main.tsx); a file
  // part's chip opens through it.
  const queryClient = new QueryClient();
  const tree = (streaming: boolean) => (
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <SessionTranscript
          apiBase={API}
          session={session}
          agentLabel="Code Reviewer"
          isStreaming={streaming}
          failureShownAbove={failureShownAbove}
          scrollContainerRef={scrollContainerRef}
        />
      </PreviewProvider>
    </QueryClientProvider>
  );
  const view = render(tree(isStreaming), {
    container: scrollContainerRef?.current ?? undefined,
  });
  return {
    ...view,
    setStreaming: (next: boolean) => view.rerender(tree(next)),
  };
}

beforeEach(() => {
  resetSequencedLiveEventsForTests();
  windowState.events = [];
  windowState.watermark = 0;
  windowState.settled = true;
  windowState.error = undefined;
  windowState.upgradeRequired = false;
  windowState.hasMore = false;
  windowState.revisions = [];
  sequence = 0;
});

describe('SessionTranscript source', () => {
  test.each([
    { upgrade: false, title: 'Conversation could not be loaded' },
    { upgrade: true, title: 'Update Station to read this conversation' },
  ])(
    'shows $title and retries instead of calling a failed read empty',
    ({ upgrade, title }) => {
      windowState.error = new Error('Conversation history request failed');
      windowState.upgradeRequired = upgrade;
      windowState.reload.mockClear();
      renderTranscript(false);
      expect(screen.getByText(title)).toBeTruthy();
      expect(screen.queryByText('No messages in this session yet.')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(windowState.reload).toHaveBeenCalledOnce();
    },
  );

  test('follows the latest transcript until the reader scrolls back, then resumes on request', () => {
    const scroll = document.createElement('div');
    document.body.append(scroll);
    let height = 1200;
    let position = 0;
    Object.defineProperties(scroll, {
      clientHeight: { get: () => 300 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => position,
        set: (next: number) => {
          position = Math.max(0, Math.min(next, height - 300));
        },
      },
    });
    const view = renderTranscript(true, false, { current: scroll });
    live([
      ev({ method: 'turn.started', turnId: 'follow', prompt: 'Show progress' }),
      ev({
        method: 'content.text-delta',
        turnId: 'follow',
        itemId: 'follow-answer',
        delta: 'First update',
      }),
    ]);
    expect(position).toBe(900);

    scroll.scrollTop = 150;
    fireEvent.scroll(scroll);
    height = 1800;
    live([
      ev({
        method: 'content.text-delta',
        turnId: 'follow',
        itemId: 'follow-answer',
        delta: ' Next update',
      }),
    ]);
    expect(position).toBe(150);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(position).toBe(1500);
    height = 2100;
    live([
      ev({
        method: 'content.text-delta',
        turnId: 'follow',
        itemId: 'follow-answer',
        delta: ' Final update',
      }),
    ]);
    expect(position).toBe(1800);
    view.unmount();
    scroll.remove();
  });

  test('a successful retry of an initially failed history read opens at the latest content', () => {
    const scroll = document.createElement('div');
    document.body.append(scroll);
    let position = 0;
    Object.defineProperties(scroll, {
      clientHeight: { get: () => 300 },
      scrollHeight: { get: () => 1200 },
      scrollTop: {
        get: () => position,
        set: (next: number) => {
          position = Math.max(0, Math.min(next, 900));
        },
      },
    });
    windowState.error = new Error('History temporarily unavailable');
    const view = renderTranscript(true, false, { current: scroll });
    expect(screen.getByText('Conversation could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    windowState.error = undefined;
    live([
      ev({
        method: 'turn.started',
        turnId: 'retry-tail',
        prompt: 'Latest request',
      }),
      ev({
        method: 'content.text-delta',
        turnId: 'retry-tail',
        itemId: 'retry-answer',
        delta: 'Latest answer',
      }),
    ]);
    expect(screen.getByText('Latest answer')).toBeTruthy();
    expect(position).toBe(900);
    view.unmount();
    scroll.remove();
  });

  test('starts the app-wide live stream itself, so the detail streams with no chat dock mounted', () => {
    ensureStream.mockClear();
    const view = renderTranscript();
    expect(ensureStream).toHaveBeenCalledWith(API, expect.anything());
    live([
      ev({ method: 'turn.started', turnId: 'solo', prompt: 'Alone' }),
      ev({
        method: 'content.text-delta',
        turnId: 'solo',
        itemId: 's',
        delta: 'streamed',
      }),
    ]);
    expect(screen.getByTestId('session-transcript').textContent).toContain(
      'streamed',
    );
    view.unmount();
  });

  test('a streamed answer longer than the per-session feed cap keeps its first words and its early tool call', async () => {
    renderTranscript();
    const words = Array.from({ length: 400 }, (_, i) => `w${i + 1}`);
    live([
      ev({ method: 'turn.started', turnId: 't1', prompt: 'Write a long one' }),
      ev({
        method: 'content.text-delta',
        turnId: 't1',
        itemId: 'a',
        delta: `${words[0]} `,
      }),
      ev({
        method: 'tool.started',
        turnId: 't1',
        toolCallId: 'call-1',
        toolName: 'read_release_notes',
        input: {},
      } as never),
      ev({
        method: 'tool.completed',
        turnId: 't1',
        toolCallId: 'call-1',
        toolName: 'read_release_notes',
        status: 'success',
        output: 'ok',
      } as never),
      ...words.slice(1).map((word) =>
        ev({
          method: 'content.text-delta',
          turnId: 't1',
          itemId: 'b',
          delta: `${word} `,
        }),
      ),
    ]);

    const transcript = screen.getByTestId('session-transcript');
    const rows = within(transcript).getAllByTestId(
      'session-transcript-message',
    );
    expect(rows.map((row) => row.getAttribute('data-role'))).toEqual([
      'user',
      'assistant',
    ]);
    expect(rows[0].textContent).toContain('Write a long one');
    // The very first word and the very last one are both there.
    expect(rows[1].textContent).toMatch(/w1(?!\d)/);
    expect(rows[1].textContent).toContain('w400');
    expect(rows[1].textContent).toContain('w200');
    // The tool call before the 200-frame boundary is still rendered.
    await waitFor(() =>
      expect(rows[1].textContent).toMatch(/read_release_notes|release notes/i),
    );
  });

  test('completed turns come from the durable window, re-read when the turn ends', () => {
    windowState.events = [
      {
        sequence: 1,
        event: ev({
          method: 'turn.started',
          turnId: 'old',
          prompt: 'Earlier question',
        }),
      },
      {
        sequence: 2,
        event: ev({
          method: 'content.text-delta',
          turnId: 'old',
          itemId: 'o',
          delta: 'Earlier answer',
        }),
      },
      {
        sequence: 3,
        event: ev({
          method: 'turn.completed',
          turnId: 'old',
          finishReason: 'stop',
        }),
      },
    ];
    windowState.watermark = 3;
    sequence = 3;
    const view = renderTranscript(true);
    expect(screen.getByTestId('session-transcript').textContent).toContain(
      'Earlier answer',
    );
    const before = windowState.revisions.at(-1);
    view.setStreaming(false);
    expect(windowState.revisions.at(-1)).toBe((before ?? 0) + 1);
  });

  test('a re-read after a long turn ends (newest-first tail + anchor, max sequence = watermark) shows the whole answer', () => {
    // The shape the conversation route returns for a long finished turn
    // (listNewestEventWindow): the turn's `turn.started` anchor, then only the
    // TAIL of its deltas up to the head, then `turn.completed` carrying the
    // full output; its highest sequence equals the reported watermark.
    const words = Array.from({ length: 300 }, (_, i) => `v${i + 1}`);
    windowState.events = [
      {
        sequence: 100,
        event: ev({ method: 'turn.started', turnId: 'L', prompt: 'Long' }),
      },
      ...words.slice(250).map((word, index) => ({
        sequence: 351 + index,
        event: ev({
          method: 'content.text-delta',
          turnId: 'L',
          itemId: 'L',
          delta: `${word} `,
        }),
      })),
      {
        sequence: 401,
        event: ev({
          method: 'turn.completed',
          turnId: 'L',
          finishReason: 'stop',
          outputText: `${words.join(' ')} `,
        }),
      },
    ];
    windowState.watermark = 401;
    renderTranscript(false);
    const [, answer] = screen.getAllByTestId('session-transcript-message');
    expect(answer.textContent).toMatch(/v1(?!\d)/);
    expect(answer.textContent).toContain('v150');
    expect(answer.textContent).toContain('v300');
  });

  test('live frames already in the window are not rendered twice, and frames at or below its watermark are ignored', () => {
    const started = ev({ method: 'turn.started', turnId: 'w', prompt: 'Once' });
    windowState.events = [{ sequence: 5, event: started }];
    windowState.watermark = 5;
    renderTranscript();
    live([started]);
    const rows = screen.getAllByTestId('session-transcript-message');
    expect(rows).toHaveLength(1);
  });

  test('renders chat’s part mapping: a coded runtime error is translated, not quoted raw', async () => {
    renderTranscript(false);
    live([
      ev({
        method: 'turn.started',
        turnId: 'e1',
        prompt: 'Retry the build',
      } as never),
      ev({
        method: 'runtime.error',
        turnId: 'e1',
        severity: 'error',
        code: 'engine-session-binding-dead',
        message: 'No conversation found with session ID: 1234',
      } as never),
      ev({ method: 'turn.aborted', turnId: 'e1', reason: 'error' } as never),
    ]);
    const transcript = screen.getByTestId('session-transcript');
    await waitFor(() => expect(transcript.textContent).toMatch(/engine/i));
    expect(transcript.textContent).not.toMatch(
      /^.*⚠️ No conversation found with session ID: 1234\s*$/m,
    );
    expect(transcript.textContent).toMatch(
      /could not reopen|session was lost/i,
    );
  });

  test('leaves the last turn’s failure to the card above it, and keeps earlier failures in the record', async () => {
    const failedTurn = (turnId: string, prompt: string, message: string) => [
      ev({ method: 'turn.started', turnId, prompt } as never),
      ev({
        method: 'runtime.error',
        turnId,
        severity: 'error',
        code: 'station_agent_turn_failed',
        message,
      } as never),
      // The shape a Station-agent failure records: the error, then the
      // session's state change. No `turn.aborted` follows.
      ev({
        method: 'session.state-changed',
        sessionId: THREAD,
        from: 'running',
        to: 'errored',
        sessionState: 'failed',
      } as never),
    ];
    const first = 'The model provider rate-limited the request (HTTP 429).';
    const last = 'The model provider returned an error (HTTP 500).';
    const messages = () =>
      screen
        .getAllByTestId('session-transcript-message')
        .map((node) => node.getAttribute('data-role'));

    const transcript = () => screen.getByTestId('session-transcript');
    const shownHere = renderTranscript(false);
    live([
      ...failedTurn('f1', 'First try', first),
      ...failedTurn('f2', 'Second try', last),
    ]);
    await waitFor(() =>
      expect(messages()).toEqual(['user', 'assistant', 'user', 'assistant']),
    );
    shownHere.unmount();

    renderTranscript(false, true);
    // Both prompts and the earlier turn's failure row stay; only the
    // terminal failure, which the detail's card states, is not repeated.
    await waitFor(() =>
      expect(messages()).toEqual(['user', 'assistant', 'user']),
    );
    expect(transcript().textContent).toContain('First try');
    expect(transcript().textContent).toContain('Second try');
  });

  test('pages older turns from the durable window', () => {
    windowState.hasMore = true;
    renderTranscript(false);
    act(() => {
      screen.getByRole('button', { name: 'Show older messages' }).click();
    });
    expect(windowState.loadOlder).toHaveBeenCalledOnce();
  });
});

describe('conversationPartToContentParts (shared with chat)', () => {
  test('keeps what the renderers need from a file part and a runtime error part', async () => {
    const { conversationPartToContentParts } = await import(
      '../hooks/orchestration/conversationTranscriptParts'
    );
    expect(
      conversationPartToContentParts({
        type: 'file',
        blobRef: 'blob-1',
        mediaType: 'text/plain',
        name: 'notes.txt',
      } as never),
    ).toEqual([
      expect.objectContaining({
        type: 'file',
        blobRef: 'blob-1',
        mediaType: 'text/plain',
        name: 'notes.txt',
      }),
    ]);
    expect(
      conversationPartToContentParts({
        type: 'text',
        text: '⚠️ gone',
        runtimeError: true,
        runtimeErrorCode: 'engine-session-binding-dead',
      } as never),
    ).toEqual([
      expect.objectContaining({
        content: '⚠️ gone',
        runtimeError: true,
        runtimeErrorCode: 'engine-session-binding-dead',
      }),
    ]);
  });
});

describe('SessionTranscript transcript markers (station#3415)', () => {
  test('a live compaction renders a marker line, not an empty speaker row', () => {
    renderTranscript(true);
    live([
      ev({ method: 'turn.started', turnId: 'm1', prompt: 'Long task' }),
      ev({ method: 'content.text-delta', turnId: 'm1', delta: 'Working.' }),
      ev({
        method: 'extension.notification',
        turnId: 'm1',
        namespace: 'codex-rollout',
        type: 'context-compacted',
        payload: { source: 'provider-event' },
      } as Partial<CanonicalRuntimeEvent> & { method: string }),
      ev({ method: 'content.text-delta', turnId: 'm1', delta: 'Still going.' }),
    ]);
    const marker = screen
      .getByText('Context compacted')
      .closest('.transcript-marker')!;
    expect(marker).toBeTruthy();
    expect(marker.closest('[data-testid="session-transcript-message"]')).toBe(
      null,
    );
    // Prompt, two halves of the answer; the marker is not one of the rows.
    expect(screen.getAllByTestId('session-transcript-message')).toHaveLength(3);
  });
});
