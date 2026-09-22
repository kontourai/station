/**
 * @vitest-environment jsdom
 */

import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useStreamingContent = vi.fn();
const mobile = vi.hoisted(() => ({ current: false }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current }));

vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: (sessionId: string) => useStreamingContent(sessionId),
}));

import {
  SMOOTH_REVEAL_CONSTANTS,
  SmoothRevealCursor,
  type SmoothRevealFrameSource,
  useSmoothRevealText,
} from '../components/chat/SmoothStreamingMessage';
import { StreamingMessage } from '../components/chat/StreamingMessage';
import { activeChatsStore } from '../contexts/active-chats-store';
import { handleTurnStartedEvent } from '../hooks/orchestration/turnHandlers';

describe('StreamingMessage', () => {
  beforeEach(() => {
    useStreamingContent.mockReset();
    mobile.current = false;
  });

  test('mobile streaming uses the same compact message layout and omits elapsed wording', () => {
    mobile.current = true;
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: false,
      contentRevision: 0,
      contentParts: [],
    });
    const view = render(
      <StreamingMessage
        sessionId="mobile"
        agentIcon={<div>Avatar</div>}
        agentIconStyle={{}}
        fontSize={14}
        attributionAgent={{ name: 'Codex' }}
      />,
    );
    expect(
      view.container.querySelector('.streaming-message.message-row--compact'),
    ).not.toBeNull();
    expect(screen.queryByText('Avatar')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
    expect(view.container.textContent).not.toContain('Elapsed');
    expect(view.container.textContent).toContain('0:00');
  });

  test('the ordinary renderer is a true pass-through with no frame callback', () => {
    const requestFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    useStreamingContent.mockReturnValue({
      streamingText: 'arrived text',
      hasContent: true,
      contentRevision: 1,
      contentParts: [],
    });

    render(
      <StreamingMessage
        sessionId="session-pass-through"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByText('arrived text')).toBeTruthy();
    expect(requestFrame).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('renders tool progress status for a running tool with progress text', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentRevision: 1,
      contentParts: [
        {
          type: 'tool-invocation',
          toolCallId: 'tool-1',
          toolName: 'search_files',
          state: 'running',
          progressMessage: 'Scanning project files',
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-1"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Scanning project files',
    );
    expect(screen.getByTitle('search files')).toBeTruthy();
  });

  test('renders fallback progress text for a running tool without progress text', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentRevision: 1,
      contentParts: [
        {
          type: 'tool-invocation',
          toolCallId: 'tool-2',
          toolName: 'run_tests',
          state: 'running',
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-2"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Running run tests',
    );
  });

  test('renders ui blocks emitted from tool output parts', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentRevision: 1,
      contentParts: [
        {
          type: 'ui-block',
          uiBlock: {
            type: 'card',
            title: 'Build Summary',
            body: 'All checks passed',
            fields: [{ label: 'Coverage', value: '98%' }],
          },
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-3"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByText('Build Summary')).toBeTruthy();
    expect(screen.getByText('All checks passed')).toBeTruthy();
    expect(screen.getByText('98%')).toBeTruthy();
  });

  test('notifies scroll ownership from the cheap content revision without concatenating transcript text', () => {
    const onContentChange = vi.fn();
    useStreamingContent.mockReturnValue({
      streamingText: 'same length',
      hasContent: true,
      contentRevision: 1,
      contentParts: [],
    });
    const view = render(
      <StreamingMessage
        sessionId="session-growth"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
        onContentChange={onContentChange}
      />,
    );
    expect(onContentChange).toHaveBeenCalledTimes(1);

    useStreamingContent.mockReturnValue({
      streamingText: 'same length',
      hasContent: true,
      contentRevision: 2,
      contentParts: [],
    });
    view.rerender(
      <StreamingMessage
        sessionId="session-growth"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
        onContentChange={onContentChange}
      />,
    );
    expect(onContentChange).toHaveBeenCalledTimes(2);
  });

  describe('station#1424 review fix (S3, then round 3 NEW-1): attribution renders from the first streaming frame, with the SAME fields a persisted row shows', () => {
    beforeEach(() => {
      useStreamingContent.mockReturnValue({
        streamingText: 'Working on it…',
        hasContent: true,
        contentRevision: 1,
        contentParts: [],
      });
    });

    test('renders the live agent identity and owner chip while still streaming — not only once the turn settles into a persisted row', () => {
      render(
        <StreamingMessage
          sessionId="session-4"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
          attributionAgent={{ name: 'Release Reviewer' }}
          owner={{ id: 'brian', label: 'Brian Anderson' }}
        />,
      );
      expect(screen.getByText('Release Reviewer')).toBeTruthy();
      expect(screen.getByText(/via Brian Anderson/)).toBeTruthy();
    });

    test('station#1424 review round 3 (NEW-1): never renders an engine chip while streaming — no `engine` prop exists on this component any more, so there is nothing that could assert an engine identity here only to retract it once the row persists', () => {
      const { container } = render(
        <StreamingMessage
          sessionId="session-4b"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
          attributionAgent={{ name: 'Release Reviewer' }}
          owner={{ id: 'brian', label: 'Brian Anderson' }}
        />,
      );
      expect(container.querySelector('.engine-chip')).toBeNull();
    });

    test('renders no attribution strip at all when none of the props are supplied (default call sites unaffected)', () => {
      const { container } = render(
        <StreamingMessage
          sessionId="session-5"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
        />,
      );
      expect(container.querySelector('.message-attribution')).toBeNull();
    });
  });

  test('a whitespace-only delta is not an answer, so reasoning stays expanded (station#55)', () => {
    // The streaming consumer derives `hasAnswerText` itself and hands it to
    // the reasoning disclosure. Models routinely emit "\n\n" as the first
    // delta after a reasoning block: treating that as an answer collapses the
    // reasoning while the answer area is still visually empty. Asserted on
    // the value StreamingMessage actually passes down, since MessageContent
    // (the settled consumer) has its own already-trimmed derivation and
    // cannot witness this defect.
    const seen: boolean[] = [];
    const renderReasoning = (
      _content: string,
      index: number,
      hasAnswerText: boolean,
    ) => {
      seen.push(hasAnswerText);
      return <span key={index}>reasoning</span>;
    };

    useStreamingContent.mockReturnValue({
      streamingText: '\n\n',
      hasContent: true,
      contentRevision: 1,
      contentParts: [{ type: 'reasoning', content: 'weighing the options' }],
    });

    render(
      <StreamingMessage
        sessionId="session-ws"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
        showReasoning
        renderReasoning={renderReasoning}
      />,
    );

    expect(seen).toContain(false);
    expect(seen).not.toContain(true);
  });

  test('a real first token IS an answer (station#55)', () => {
    const seen: boolean[] = [];
    useStreamingContent.mockReturnValue({
      streamingText: 'pong',
      hasContent: true,
      contentRevision: 2,
      contentParts: [{ type: 'reasoning', content: 'weighing the options' }],
    });

    render(
      <StreamingMessage
        sessionId="session-answer"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
        showReasoning
        renderReasoning={(_c, index, hasAnswerText) => {
          seen.push(hasAnswerText);
          return <span key={index}>reasoning</span>;
        }}
      />,
    );

    expect(seen).toContain(true);
  });
});

describe('station#585 smooth reveal cursor', () => {
  test('derives target rate from backlog and slews toward it with tau 0.15', () => {
    const cursor = new SmoothRevealCursor();
    cursor.updateAvailable(100, 0);

    const snapshot = cursor.advance(150);
    const targetRate = 100 / SMOOTH_REVEAL_CONSTANTS.backlogWindowSeconds;
    const expectedRate =
      SMOOTH_REVEAL_CONSTANTS.minCharsPerSecond +
      (targetRate - SMOOTH_REVEAL_CONSTANTS.minCharsPerSecond) *
        (1 - Math.exp(-0.15 / SMOOTH_REVEAL_CONSTANTS.slewTauSeconds));

    expect(snapshot.rateCharsPerSecond).toBeCloseTo(expectedRate, 6);
    expect(snapshot.visibleLength).toBe(Math.floor(expectedRate * 0.15));
  });

  test('clamps a small backlog to the 50 cps floor', () => {
    const cursor = new SmoothRevealCursor();
    cursor.updateAvailable(10, 0);

    const snapshot = cursor.advance(100);

    expect(snapshot.rateCharsPerSecond).toBe(50);
    expect(snapshot.visibleLength).toBe(5);
  });

  test('clamps a large backlog to the 600 cps ceiling', () => {
    const cursor = new SmoothRevealCursor();
    cursor.updateAvailable(10_000, 0);

    const snapshot = cursor.advance(2_000);

    expect(snapshot.rateCharsPerSecond).toBeCloseTo(600, 2);
    expect(snapshot.rateCharsPerSecond).toBeLessThanOrEqual(600);
  });

  test('drains every remaining character at the 2.5 second escape hatch', () => {
    const cursor = new SmoothRevealCursor();
    cursor.updateAvailable(10_000, 0);

    const beforeEscape = cursor.advance(2_499);
    expect(beforeEscape.visibleLength).toBeLessThan(10_000);
    expect(beforeEscape.needsFrame).toBe(true);

    const escaped = cursor.advance(2_500);
    expect(escaped.visibleLength).toBe(10_000);
    expect(escaped.needsFrame).toBe(false);
  });

  test('publishes React state only when the floored cursor advances', () => {
    let now = 0;
    const callbacks: ((time: number) => void)[] = [];
    const frames: SmoothRevealFrameSource = {
      now: () => now,
      request: vi.fn((callback: (time: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
      cancel: vi.fn(),
    };
    const hook = renderHook(() => useSmoothRevealText('x'.repeat(100), frames));

    expect(hook.result.current).toEqual({ text: '', revision: 0 });
    expect(frames.request).toHaveBeenCalledTimes(1);

    act(() => {
      now = 1;
      callbacks.shift()?.(now);
    });
    expect(hook.result.current).toEqual({ text: '', revision: 0 });

    act(() => {
      now = 20;
      callbacks.shift()?.(now);
    });
    expect(hook.result.current.revision).toBe(1);
    expect(hook.result.current.text.length).toBe(1);
  });
});

/**
 * #2304: "Working for MM:SS" used to count from the streaming row's MOUNT, so
 * any remount (navigating away and back, dock teardown, a virtualizer drop)
 * restarted a 12-minute turn at 0:00. The count now derives from the
 * server's `turn.started.createdAt`, stamped by the real turn handler. The
 * server start is deliberately 12 minutes BEFORE the fake clock's "now" (the
 * mount time): a test seeding the start from the component's own clock could
 * not tell the two derivations apart.
 */
describe('working clock reads the turn start, not the mount (#2304)', () => {
  const chatId = 'working-clock-2304';
  const now = Date.parse('2026-09-22T12:12:00.000Z');
  const serverStart = '2026-09-22T12:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers({ now });
    useStreamingContent.mockReset();
    mobile.current = false;
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: false,
      contentRevision: 0,
      contentParts: [],
    });
    activeChatsStore.initChat(chatId, {
      agentSlug: 'codex',
      agentName: 'Codex',
      title: 'Working clock',
    });
  });

  afterEach(() => {
    activeChatsStore.removeChat(chatId);
    vi.useRealTimers();
  });

  function renderRow(turnStartedAt: number | undefined, statusLabel?: string) {
    return render(
      <StreamingMessage
        sessionId={chatId}
        agentIcon={<div />}
        agentIconStyle={{}}
        fontSize={14}
        turnStartedAt={turnStartedAt}
        statusLabel={statusLabel}
      />,
    );
  }

  function stampTurn() {
    handleTurnStartedEvent({
      eventId: 'turn-started-2304',
      method: 'turn.started',
      provider: 'codex',
      threadId: chatId,
      turnId: 'turn-2304',
      createdAt: serverStart,
      prompt: 'why did you stop?',
    });
    return activeChatsStore.getSnapshot()[chatId]?.openTurnStartedAt;
  }

  test('a row mounted 12 minutes into the turn reads 12:00, and a remount keeps counting', () => {
    const turnStartedAt = stampTurn();
    expect(turnStartedAt).toBe(Date.parse(serverStart));

    const first = renderRow(turnStartedAt);
    expect(first.container.textContent).toContain('Working for 12:00');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(first.container.textContent).toContain('Working for 12:03');
    first.unmount();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const remounted = renderRow(
      activeChatsStore.getSnapshot()[chatId]?.openTurnStartedAt,
    );
    expect(remounted.container.textContent).toContain('Working for 12:05');
    expect(remounted.container.textContent).not.toContain('0:00');
    remounted.unmount();
  });

  test('closing the turn fold clears the start, so the next turn cannot inherit it', () => {
    expect(stampTurn()).toBe(Date.parse(serverStart));
    activeChatsStore.updateChat(chatId, { orchestrationTurnOpen: false });
    expect(
      activeChatsStore.getSnapshot()[chatId]?.openTurnStartedAt,
    ).toBeUndefined();
  });

  test('a server start ahead of this clock reads 0:00, never negative time', () => {
    const view = renderRow(now + 30_000);
    expect(view.container.textContent).toContain('Working for 0:00');
    expect(view.container.textContent).not.toContain('-');
    view.unmount();
  });

  test("a status-labelled wait reads the row's mount clock, not the turn duration (pre-existing limitation)", () => {
    const view = renderRow(Date.parse(serverStart), 'Waiting for approval');
    expect(view.container.textContent).toContain('Waiting for approval · 0:00');
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    // Mount-relative: four seconds since this row mounted, not 12:04 since
    // the turn started, and not since any approval request.
    expect(view.container.textContent).toContain('Waiting for approval · 0:04');
    view.unmount();
  });

  test("the sender's row keeps counting when a later server start lands, rather than jumping back", () => {
    // Mounted at send (the fake clock's now), before the turn has started.
    const view = renderRow(undefined);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(view.container.textContent).toContain('Working for 0:30');
    // turn.started lands; the server's start is 30s after this row mounted.
    const laterServerStart = now + 30_000;
    view.rerender(
      <StreamingMessage
        sessionId={chatId}
        agentIcon={<div />}
        agentIconStyle={{}}
        fontSize={14}
        turnStartedAt={laterServerStart}
      />,
    );
    expect(view.container.textContent).toContain('Working for 0:30');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(view.container.textContent).toContain('Working for 0:32');
    view.unmount();

    // A row remounted after that reads the server start: its own mount is
    // later still.
    const remounted = renderRow(laterServerStart);
    expect(remounted.container.textContent).toContain('Working for 0:02');
    remounted.unmount();
  });
});
