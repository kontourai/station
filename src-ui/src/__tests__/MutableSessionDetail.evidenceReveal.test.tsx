import type { RecordConversationBodyProps } from '../components/conversation/RecordConversationBody';
import { PreviewProvider } from '../contexts/PreviewContext';
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * archive#4052: the session detail honors the `focus=evidence` route
 * intent EXACTLY ONCE per activation token. A reveal is a navigation outcome,
 * not a standing rule — later renders (events streaming in, queries settling)
 * must never scroll the reader back to a region they have since left, and a
 * reveal addressed to a different session, or to a render where the region is
 * absent, is a completed no-op rather than a scroll deferred to a surprising
 * later render.
 *
 * Mock shape follows `SessionDetail.scrollStructure.test.tsx`: the state hook
 * is stubbed so this file exercises only the render tree plus the reveal
 * effect under test.
 */

// The body port controls read settlement; the shared reader suite owns its event source.
vi.mock('../components/conversation/ConversationBody', async () => {
  const { useState, useEffect } = await import('react');
  return {
    ConversationBody: (props: RecordConversationBodyProps) => {
      const [settled, setSettled] = useState(transcript.settled);
      transcript.set = setSettled;
      useEffect(
        () => props.reader.onSettledChange?.(settled),
        [props.reader.onSettledChange, settled],
      );
      return (
        <div className="conversation-body conversation-body--record">
          <div
            className="sessions-detail__scroll"
            ref={props.scrollContainerRef}
          >
            {props.beforeTranscript}
            <section
              className="conversation-reader"
              data-testid="session-transcript"
            />
            {props.afterTranscript}
          </div>
        </div>
      );
    },
  };
});
vi.mock('../components/LazyBoundary', () => ({ LazyBoundary: () => null }));
vi.mock('../components/pull-requests/ConversationPullRequestLinks', () => ({
  ConversationPullRequestLinks: () => null,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useAgentsQuery: () => ({ data: [], error: null }),
  useOrchestrationCommandReceiptsQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));

const detailState = {
  input: '',
  setInput: vi.fn(),
  isDelegated: false,
  sendTurn: { isPending: false, error: null as Error | null, mutate: vi.fn() },
  respond: { isPending: false, error: null as Error | null, mutate: vi.fn() },
  stopTask: { isPending: false, error: null, mutate: vi.fn() },
  pendingRequest: null,
  pendingRequestPresentation: null,
  isStreaming: false,
  isStopped: false,
  isFailed: false,
  sessionUnanswerable: false,
  sessionUnanswerableNotice: null,
  rows: [{ label: 'Model', value: 'claude' }],
  viewportIsCompact: false,
  title: 'A session',
  diagnosticsLog: [],
  attentionCheckFailed: false,
  attentionErrorMessage: undefined,
  attentionRefetch: vi.fn(),
  visibleAttentionItems: [],
  hideGenericCompose: false,
  failureText: null,
  copySessionId: vi.fn(),
  canSend: false,
  failureNote: null,
  acknowledgeFailure: undefined,
  acknowledgeFailurePending: false,
  acknowledgeFailureError: null,
  linkedFlowRun: null,
  builderRun: null,
  workflowEntries: [],
  workflowMoreCount: 0,
};

const transcript = vi.hoisted(() => ({
  settled: true,
  set: (_settled: boolean) => {},
}));
// The read settles inside the transcript (its own state), exactly as the real
// window read does — not through a prop the parent re-renders with.
vi.mock('../hooks/orchestration/useSessionTranscriptEvents', async () => {
  const { useState } = await import('react');
  return {
    useSessionTranscriptEvents: () => {
      const [settled, setSettled] = useState(transcript.settled);
      transcript.set = setSettled;
      return { events: [], hasMore: false, loadOlder: vi.fn(), settled };
    },
  };
});

vi.mock('../hooks/useMutableSessionDetailState', () => ({
  useMutableSessionDetailState: () => detailState,
}));

import { MutableSessionDetail } from '../components/session-detail/MutableSessionDetail';

const session = {
  threadId: 'station:thread-1',
  provider: 'claude',
  controlMode: 'station-owned',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
} as any;

function renderDetail(
  evidenceReveal?: { threadId: string; token: number } | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const detail = (reveal?: { threadId: string; token: number } | null) => (
    <QueryClientProvider client={queryClient}>
      <PreviewProvider>
        <MutableSessionDetail
          apiBase="http://station.test"
          session={session}
          onTaskChanged={vi.fn()}
          events={[]}
          connected
          visualViewport={{ style: {} } as any}
          evidenceReveal={reveal}
        />
      </PreviewProvider>
    </QueryClientProvider>
  );
  const rendered = render(detail(evidenceReveal));
  return {
    ...rendered,
    rerenderReveal: (reveal?: { threadId: string; token: number } | null) =>
      rendered.rerender(detail(reveal)),
  };
}

describe('MutableSessionDetail evidence reveal (station#4052 slice 3)', () => {
  // jsdom implements no scrolling; the component guards the call, so a
  // prototype spy is what makes the scroll half of the reveal observable.
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    detailState.sendTurn.error = null;
    detailState.respond.error = null;
    transcript.settled = true;
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });
  test('attention failures reveal the retained record without taking evidence focus', async () => {
    detailState.attentionCheckFailed = true;
    const view = await renderDetail();
    expect(
      screen.getByText("Couldn't check whether this session needs attention"),
    ).toBeTruthy();
    const scroll = screen
      .getByTestId('session-detail')
      .querySelector('.sessions-detail__scroll') as HTMLDivElement;
    expect(scroll.scrollTop).toBe(0);
    detailState.attentionCheckFailed = false;
    view.rerenderReveal(undefined);
  });

  afterEach(() => {
    delete (HTMLElement.prototype as any).scrollIntoView;
  });

  test('honors the reveal once: opens Details, then scrolls and focuses the evidence region', async () => {
    await renderDetail({ threadId: 'station:thread-1', token: 1 });

    // The evidence lives in the collapsed Details disclosure; a reveal that
    // scrolled to a closed <details> would land on nothing.
    const details = screen.getByTestId(
      'session-details-disclosure',
    ) as HTMLDetailsElement;
    expect(details.open).toBe(true);
    const region = screen.getByTestId('session-evidence-region');
    expect(details.contains(region)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(region);
  });

  test('re-asserts the scroll once when the conversation read settles after the reveal, without taking focus back', async () => {
    transcript.settled = false;
    const view = await renderDetail({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const region = screen.getByTestId('session-evidence-region');
    region.blur();

    act(() => transcript.set(true));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(region);

    // Once only: later renders leave the reader where they are.
    view.rerenderReveal({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  test('follows lazy growth of the conversation for at most a second after settling, and stops once the reader scrolls', async () => {
    const callbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {
          disconnect();
        }
      },
    );
    vi.useFakeTimers();
    try {
      transcript.settled = false;
      const view = await renderDetail({
        threadId: 'station:thread-1',
        token: 1,
      });
      act(() => transcript.set(true));
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      // Markdown lands and the conversation grows: follow it.
      act(() => callbacks.at(-1)!());
      expect(scrollIntoView).toHaveBeenCalledTimes(3);
      // The reader scrolls: the follow ends.
      const scroller = view.container.querySelector(
        '.sessions-detail__scroll',
      ) as HTMLElement;
      fireEvent.wheel(scroller);
      expect(disconnect).toHaveBeenCalled();
      view.unmount();

      // A scrollbar drag (pointerdown on the region) and a key pressed
      // anywhere in the document end it too.
      for (const takeOver of [
        (scroll: HTMLElement) => fireEvent.pointerDown(scroll),
        () => fireEvent.keyDown(document.body, { key: 'ArrowDown' }),
      ]) {
        disconnect.mockClear();
        transcript.settled = false;
        const next = await renderDetail({
          threadId: 'station:thread-1',
          token: 3,
        });
        act(() => transcript.set(true));
        takeOver(
          next.container.querySelector(
            '.sessions-detail__scroll',
          ) as HTMLElement,
        );
        expect(disconnect).toHaveBeenCalled();
        next.unmount();
      }

      // Bounded in time too.
      disconnect.mockClear();
      transcript.settled = false;
      await renderDetail({ threadId: 'station:thread-1', token: 2 });
      act(() => transcript.set(true));
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test('a reveal after the conversation already settled scrolls once only', async () => {
    transcript.settled = true;
    const view = await renderDetail({ threadId: 'station:thread-1', token: 1 });
    view.rerenderReveal({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  test('does not re-fire on later renders with the same token', async () => {
    const view = await renderDetail({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // The reader moves on; a re-render with the same standing prop (new
    // events, a settled query) must not drag them back.
    const region = screen.getByTestId('session-evidence-region');
    region.blur();
    view.rerenderReveal({ threadId: 'station:thread-1', token: 1 });
    view.rerenderReveal({ threadId: 'station:thread-1', token: 1 });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(region);
  });

  test('a fresh activation token fires again', async () => {
    const view = await renderDetail({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerenderReveal({ threadId: 'station:thread-1', token: 2 });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });

  test('ignores a reveal addressed to a different session', async () => {
    await renderDetail({ threadId: 'station:someone-else', token: 1 });

    expect(
      (screen.getByTestId('session-details-disclosure') as HTMLDetailsElement)
        .open,
    ).toBe(false);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });

  test('mounting with no reveal does nothing: Details stays collapsed', async () => {
    await renderDetail(undefined);

    expect(
      (screen.getByTestId('session-details-disclosure') as HTMLDetailsElement)
        .open,
    ).toBe(false);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });
});
