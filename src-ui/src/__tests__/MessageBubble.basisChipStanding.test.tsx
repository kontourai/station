/**
 * @vitest-environment jsdom
 *
 * The answer Basis chip's standing, through the REAL MessageBubble, the REAL
 * chip, the REAL SDK read and Surface's REAL view model. Only `fetch`, the
 * authority hook and IntersectionObserver (jsdom has none) are replaced: the
 * observer stub is the viewport, and `scrollTo` decides which answers it
 * reports on screen.
 */

import { refreshAnswerAssessmentQueries } from '@kontourai/station-sdk/answer-assessment-events';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AnswerBasisStandingFixture,
  answerBasisProjection,
} from '../../../packages/basis-pane/src/__tests__/fixtures/answer-basis-standing';
import type { ChatMessage } from '../types';

const authority = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  authorityKey: 'authority-a',
  isCurrent: () => true,
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => authority,
}));
vi.mock('../contexts/ProjectsContext', async (original) => ({
  ...(await original<typeof import('../contexts/ProjectsContext')>()),
  useScopedProjectQuery: () => ({ data: undefined }),
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

const SESSION = 'agent:1792425046978';
const ANSWERS = 50;
const VIEWPORT = 5;

/** IntersectionObserver as a viewport over the observed chips, in order. */
const viewport = {
  observers: new Set<FakeObserver>(),
  visible: new Set<number>(),
};
class FakeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    viewport.observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
    this.report();
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    viewport.observers.delete(this);
  }
  takeRecords() {
    return [];
  }
  report() {
    const entries = [...this.targets].map((target) => ({
      target,
      isIntersecting: viewport.visible.has(indexOf(target)),
    }));
    if (entries.length)
      this.callback(
        entries as unknown as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
  }
}
function indexOf(chip: Element) {
  return Number(
    chip.closest('[data-answer-index]')?.getAttribute('data-answer-index'),
  );
}
async function scrollTo(first: number) {
  viewport.visible = new Set(
    Array.from({ length: VIEWPORT }, (_, offset) => first + offset),
  );
  await act(async () => {
    for (const observer of viewport.observers) observer.report();
  });
}

/** Turn n's standing: every tenth answer was assessed, the rest were not. */
let standingFor = (n: number): AnswerBasisStandingFixture =>
  n % 10 === 3 ? 'policy-met' : 'execution-only';
const reads: number[] = [];

function turnOf(n: number) {
  return `turn-${n}`;
}

beforeEach(() => {
  reads.length = 0;
  viewport.observers.clear();
  viewport.visible = new Set();
  standingFor = (n) => (n % 10 === 3 ? 'policy-met' : 'execution-only');
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const n = Number(/turns\/turn-(\d+)\/basis/.exec(String(input))![1]);
      reads.push(n);
      return new Response(
        JSON.stringify({
          success: true,
          data: answerBasisProjection(standingFor(n), SESSION, `m-${n}`),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
});
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

const envelope = (turnId: string) => ({
  envelopeVersion: 1,
  sessionId: SESSION,
  turnId,
  outcome: 'completed',
  observedAt: '2026-08-01T00:00:00.000Z',
  engine: {
    state: 'observed',
    value: { provider: 'codex' },
    observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
  },
  requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
  usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
  routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
  sources: { state: 'unavailable', reason: 'not-captured-by-station' },
  trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
});

function renderTranscript(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      {Array.from({ length: ANSWERS }, (_, n) => (
        <div key={n} data-answer-index={n}>
          <MessageBubble
            msg={
              {
                role: 'assistant',
                content: `Answer ${n}.`,
                sessionId: SESSION,
                turnId: turnOf(n),
                answerEligible: true,
                provenance: envelope(turnOf(n)),
              } as ChatMessage
            }
            idx={n}
            activeSession={{
              id: SESSION,
              agentSlug: 'agent',
              messageCount: ANSWERS,
            }}
            agents={[]}
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            onCopy={() => {}}
          />
        </div>
      ))}
    </QueryClientProvider>,
  );
  return client;
}

function chip(n: number) {
  return screen.getByRole('button', {
    name: new RegExp(`^Basis.* for the answer “Answer ${n}\\.”`),
  });
}

async function chipsMounted() {
  await waitFor(() =>
    expect(
      document.querySelectorAll('.answer-basis-chip:not([disabled])'),
    ).toHaveLength(ANSWERS),
  );
  await act(async () => {});
}

describe('answer Basis chip standing', () => {
  it('reads only the answers on screen, and re-reads none when scrolling back', async () => {
    renderTranscript();
    await chipsMounted();
    // Nothing on screen yet: fifty answers, no reads.
    expect(reads).toEqual([]);

    await scrollTo(0);
    await waitFor(() => expect(reads).toHaveLength(VIEWPORT));
    expect(new Set(reads)).toEqual(new Set([0, 1, 2, 3, 4]));

    // Scroll halfway, a viewport at a time: one read per answer that came on
    // screen, none for answers still below.
    const seen = new Set(reads);
    for (let first = VIEWPORT; first <= 20; first += VIEWPORT) {
      await scrollTo(first);
      for (let n = first; n < first + VIEWPORT; n += 1) seen.add(n);
      await waitFor(() => expect(new Set(reads)).toEqual(seen));
    }
    expect(reads).toHaveLength(seen.size);
    expect(reads.every((n) => n < 25)).toBe(true);

    // Back to the top a minute later: those standings are cached (and no
    // update arrived), so nothing is re-read however long they sat.
    const before = reads.length;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      await scrollTo(0);
      // Longer than the chip's 150ms dwell, so every chip is enabled again.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(reads).toHaveLength(before);
    } finally {
      clock.mockRestore();
    }
  });

  it('a fling past fifty answers reads only where it settled, and cancels what it left', async () => {
    // Reads that never answer on their own: each settles only when aborted,
    // so whatever is still in flight after the fling was never cancelled.
    const inFlight = new Set<number>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const n = Number(/turns\/turn-(\d+)\/basis/.exec(String(input))![1]);
        reads.push(n);
        inFlight.add(n);
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            inFlight.delete(n);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );
    renderTranscript();
    await chipsMounted();

    // A fling: each viewport is on screen for a moment far shorter than the
    // chip's 150ms dwell, except one pause of 300ms at answers 25-29.
    for (let first = 0; first <= ANSWERS - VIEWPORT; first += VIEWPORT) {
      await scrollTo(first);
      if (first === 25)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    // Reads STARTED only where the fling settled: the pause and the stop.
    expect([...reads].sort((a, b) => a - b)).toEqual([
      25, 26, 27, 28, 29, 45, 46, 47, 48, 49,
    ]);
    // The paused viewport was left before its reads answered: cancelled.
    await waitFor(() =>
      expect([...inFlight].sort((a, b) => a - b)).toEqual([45, 46, 47, 48, 49]),
    );
  });

  it('shows Surface’s label only for a notable standing; an unassessed one stays plain', async () => {
    renderTranscript();
    await chipsMounted();
    await scrollTo(0);

    await waitFor(() => expect(chip(3).textContent).toBe('Basis · Policy met'));
    expect(chip(2).textContent).toBe('Basis');
    expect(chip(2).getAttribute('aria-label')).toBe(
      'Basis for the answer “Answer 2.”: Unassessed',
    );
    // Off screen: never read, so plain and with no standing claimed.
    expect(chip(13).textContent).toBe('Basis');
    expect(chip(13).getAttribute('aria-label')).toBe(
      'Basis for the answer “Answer 13.”',
    );
  });

  it('an assessment update refreshes the answer on screen and defers one off screen', async () => {
    const client = renderTranscript();
    await chipsMounted();
    await scrollTo(0);
    await waitFor(() => expect(reads).toHaveLength(VIEWPORT));
    await waitFor(() => expect(chip(2).textContent).toBe('Basis'));

    // Turns 2 (on screen) and 12 (off screen) are assessed.
    standingFor = (n) =>
      n === 2 || n === 12 || n % 10 === 3 ? 'policy-met' : 'execution-only';
    reads.length = 0;
    await act(async () => {
      for (const n of [2, 12])
        refreshAnswerAssessmentQueries(
          client,
          { sessionId: SESSION, turnId: turnOf(n), revision: 2, active: true },
          authority,
        );
    });

    await waitFor(() => expect(chip(2).textContent).toBe('Basis · Policy met'));
    expect(reads).toEqual([2]);

    // Turn 12 is read, with its new standing, only once it comes on screen.
    await scrollTo(10);
    await waitFor(() =>
      expect(chip(12).textContent).toBe('Basis · Policy met'),
    );
    expect(reads.filter((n) => n === 12)).toHaveLength(1);
  });
});

/**
 * The chip's 150ms dwell timer belongs to one IntersectionObserver
 * subscription; its effect cleanup must cancel it. These render one answer
 * and wait well past the dwell on real timers.
 */
describe('answer Basis chip dwell cleanup', () => {
  function oneAnswer(strict: boolean) {
    const bubble = (
      <QueryClientProvider client={new QueryClient()}>
        <div data-answer-index={0}>
          <MessageBubble
            msg={
              {
                role: 'assistant',
                content: 'Answer 0.',
                sessionId: SESSION,
                turnId: turnOf(0),
                answerEligible: true,
                provenance: envelope(turnOf(0)),
              } as ChatMessage
            }
            idx={0}
            activeSession={{ id: SESSION, agentSlug: 'agent', messageCount: 1 }}
            agents={[]}
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            onCopy={() => {}}
          />
        </div>
      </QueryClientProvider>
    );
    return render(strict ? <StrictMode>{bubble}</StrictMode> : bubble);
  }
  async function pastTheDwell() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  }

  it('a chip unmounted before its dwell ends starts no read and no stray update', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = oneAnswer(false);
      await waitFor(() => expect(chip(0)).toBeTruthy());
      await scrollTo(0);
      unmount();
      await pastTheDwell();
      expect(reads).toEqual([]);
      expect(
        errors.mock.calls.filter((call) =>
          /act\(|unmounted/.test(String(call[0])),
        ),
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('a subscription torn down before its dwell ends cannot mark the chip on screen later', async () => {
    // StrictMode subscribes, cleans up and subscribes again. The first
    // subscription sees the chip on screen and starts its dwell; by the
    // second the chip has left the viewport. Only a cleanup that cancels the
    // first dwell keeps that stale timer from enabling an off-screen read.
    let subscriptions = 0;
    class LeavingObserver {
      readonly onScreen = subscriptions++ === 0;
      constructor(readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            { target, isIntersecting: this.onScreen },
          ] as unknown as IntersectionObserverEntry[],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', LeavingObserver);
    oneAnswer(true);
    await waitFor(() => expect(chip(0)).toBeTruthy());
    await pastTheDwell();
    // The double subscription really happened, so the case was reached.
    expect(subscriptions).toBeGreaterThanOrEqual(2);
    expect(reads).toEqual([]);
    expect(chip(0).getAttribute('aria-label')).toBe(
      'Basis for the answer “Answer 0.”',
    );
  });
});
