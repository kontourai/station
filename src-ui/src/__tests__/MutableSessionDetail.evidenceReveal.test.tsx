// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#4052 slice 3: the session detail honors the `focus=evidence` route
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

vi.mock('@kontourai/station-sdk', () => ({
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
  sendTurn: { isPending: false, error: null, mutate: vi.fn() },
  respond: { isPending: false, error: null, mutate: vi.fn() },
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
  linkedFlowRun: null,
  builderRun: null,
  workflowEntries: [],
  workflowMoreCount: 0,
};

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
      <MutableSessionDetail
        apiBase="http://station.test"
        session={session}
        onTaskChanged={vi.fn()}
        events={[]}
        connected
        visualViewport={{ style: {} } as any}
        evidenceReveal={reveal}
      />
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
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as any).scrollIntoView;
  });

  test('honors the reveal once: scrolls and focuses the evidence region', () => {
    renderDetail({ threadId: 'station:thread-1', token: 1 });

    const region = screen.getByTestId('session-evidence-region');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(region);
  });

  test('does not re-fire on later renders with the same token', () => {
    const view = renderDetail({ threadId: 'station:thread-1', token: 1 });
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

  test('a fresh activation token fires again', () => {
    const view = renderDetail({ threadId: 'station:thread-1', token: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerenderReveal({ threadId: 'station:thread-1', token: 2 });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });

  test('ignores a reveal addressed to a different session', () => {
    renderDetail({ threadId: 'station:someone-else', token: 1 });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });

  test('mounting with no reveal does nothing', () => {
    renderDetail(undefined);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(
      screen.getByTestId('session-evidence-region'),
    );
  });
});
