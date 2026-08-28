// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ToastProvider } from '../contexts/ToastContext';

const receiptData = vi.hoisted(() => ({
  value: undefined as unknown[] | undefined,
}));

/**
 * archive#3305 structural guard: the session detail pane clips instead of
 * scrolling when content lands outside the one flexible row a fixed grid
 * template happened to assign. The contract now: everything between the
 * pinned header and the pinned request/compose controls lives inside a
 * single scrollable region (`.sessions-detail__scroll`).
 *
 * Structural, not pixel: jsdom does no layout, so these assert ancestry —
 * which element is inside (and outside) the scroll region — not scroll
 * geometry.
 */

vi.mock('@kontourai/station-sdk', () => ({
  adoptOrchestrationSession: vi.fn(),
  createAdoptOrchestrationSessionIntent: () => ({
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
  }),
  useOrchestrationCommandReceiptsQuery: () => ({
    data: receiptData.value,
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

import { AttachedSessionDetail } from '../components/session-detail/AttachedSessionDetail';
import { MutableSessionDetail } from '../components/session-detail/MutableSessionDetail';

const session = {
  threadId: 'external:claude:thread',
  provider: 'claude',
  controlMode: 'read-only-attached',
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
} as any;

let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({
    eventId: `e${n++}`,
    provider: 'claude',
    threadId: 'external:claude:thread',
    createdAt: '2026-08-18T00:00:00.000Z',
    ...e,
  }) as unknown as CanonicalRuntimeEvent;

function withClient(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The real ToastProvider, not a stub: AttachedSessionDetail calls `useToast`
  // at its top and throws outside a provider, so a render without one fails
  // before this file's structural assertions ever run.
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

/**
 * The pinned chrome, by class. Everything else the pane renders as a direct
 * child of `.sessions-detail` must be inside `.sessions-detail__scroll`.
 *
 * Enumerating the SCROLLED children instead would pin only the sections that
 * happen to exist today: the defect this guards is a section that grows or is
 * added landing outside the scroll region, and an enumeration of named
 * children says nothing about an unnamed one (`.sessions-detail__details`
 * grows with `technicalErrors`; the anticipated multiple attention cards are
 * not named at all). So the assertion runs the other way — anything that is
 * not pinned chrome is a scroll-region failure by default.
 */
const PINNED_CHILD_CLASSES = [
  'sessions-detail__header',
  'sessions-detail__scroll',
  'sessions-detail__request',
  'sessions-detail__compose',
  'sessions-detail__note',
];

function unpinnedChildrenOutsideScroll(detail: Element): string[] {
  return [...detail.children]
    .filter(
      (child) =>
        !PINNED_CHILD_CLASSES.some((className) =>
          child.classList.contains(className),
        ),
    )
    .map((child) => child.outerHTML.slice(0, 120));
}

describe('session detail scroll structure (station#3305)', () => {
  test('renders the latest receipt origin and keeps absent provenance unknown', () => {
    receiptData.value = [
      { createdAt: '2026-08-23T00:00:00.000Z' },
      {
        createdAt: '2026-08-23T00:01:00.000Z',
        clientOrigin: {
          actor: { kind: 'device', deviceId: 'device-7' },
          reported: { surface: 'mobile', build: '1.2.3' },
        },
      },
    ];
    const rendered = withClient(
      <MutableSessionDetail
        apiBase="http://station.test"
        session={session}
        onTaskChanged={vi.fn()}
        events={[]}
        connected
        visualViewport={{ style: {} } as any}
      />,
    );
    expect(screen.getByText('device device-7 · mobile · 1.2.3')).toBeTruthy();
    rendered.unmount();
    receiptData.value = undefined;
    withClient(
      <MutableSessionDetail
        apiBase="http://station.test"
        session={session}
        onTaskChanged={vi.fn()}
        events={[]}
        connected
        visualViewport={{ style: {} } as any}
      />,
    );
    expect(screen.getByText('unknown')).toBeTruthy();
  });
  test('read-only detail: the transcript is inside the scroll region, the header pinned outside it', () => {
    withClient(
      <AttachedSessionDetail
        apiBase="http://station.test"
        session={session}
        onAdopted={vi.fn()}
        getSelectionIntent={() => 0}
        events={[
          ev({ method: 'turn.started', turnId: 'r1', prompt: 'hi' }),
          ev({ method: 'content.text-delta', itemId: 'i1', delta: 'Hello.' }),
          ev({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
        ]}
        connected
        visualViewport={{ style: {} } as any}
      />,
    );

    const detail = screen.getByTestId('session-detail');
    const scroll = detail.querySelector('.sessions-detail__scroll');
    expect(scroll).not.toBeNull();

    const transcript = screen.getByTestId('attached-session-transcript');
    expect(transcript.closest('.sessions-detail__scroll')).toBe(scroll);
    // The adoption controls scroll with the transcript rather than being
    // positionally clipped (the concrete "details don't show" defect).
    expect(
      screen
        .getByRole('button', { name: 'Continue in Station' })
        .closest('.sessions-detail__scroll'),
    ).toBe(scroll);
    // The identity header stays pinned outside the scroll region.
    expect(
      detail
        .querySelector('.sessions-detail__header')
        ?.closest('.sessions-detail__scroll'),
    ).toBeNull();

    // …and it is the ONLY thing outside it here: the read-only pane has no
    // pinned composer, so every other child must scroll.
    expect(
      unpinnedChildrenOutsideScroll(detail),
      'unpinned direct child of .sessions-detail rendered outside .sessions-detail__scroll',
    ).toEqual([]);
    expect(
      detail.querySelector('.sessions-detail__details')?.parentElement,
    ).toBe(scroll);
  });

  test('mutable detail: context and diagnostics scroll; the composer is pinned outside the scroll region', () => {
    withClient(
      <MutableSessionDetail
        apiBase="http://station.test"
        session={session}
        onTaskChanged={vi.fn()}
        events={[]}
        connected
        visualViewport={{ style: {} } as any}
      />,
    );

    const detail = screen.getByTestId('session-detail');
    const scroll = detail.querySelector('.sessions-detail__scroll');
    expect(scroll).not.toBeNull();

    // Growable content lives in the scroll region…
    expect(
      detail
        .querySelector('.sessions-detail__context')
        ?.closest('.sessions-detail__scroll'),
    ).toBe(scroll);
    expect(
      screen
        .getByTestId('session-diagnostics')
        .closest('.sessions-detail__scroll'),
    ).toBe(scroll);
    // …while the composer stays reachable without scrolling.
    expect(
      screen
        .getByRole('textbox', { name: 'Send input to session' })
        .closest('.sessions-detail__scroll'),
    ).toBeNull();

    // Nothing else escapes: only the pinned header/request/compose/note may
    // sit outside the scroll region, whether or not it has a name here.
    expect(
      unpinnedChildrenOutsideScroll(detail),
      'unpinned direct child of .sessions-detail rendered outside .sessions-detail__scroll',
    ).toEqual([]);
  });

  test('the scroll region does not let its children compress instead of scrolling', () => {
    // jsdom does no layout, so this is the stylesheet assertion: every child
    // of the scroll region keeps its content height. Without it a child that
    // scrolls on either axis (`__context` at mobile widths, the transcript)
    // has an automatic minimum size of 0 and squashes toward nothing while
    // the region never scrolls — the same "details don't show" outcome the
    // grid template produced.
    const css = readFileSync(
      join(__dirname, '..', 'views', 'SessionsView.css'),
      'utf8',
    );
    const rule = /\.sessions-detail__scroll\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.sessions-detail__scroll > * rule not found').not.toBeNull();
    expect(rule![1]).toMatch(/flex-shrink:\s*0/);
  });
});
