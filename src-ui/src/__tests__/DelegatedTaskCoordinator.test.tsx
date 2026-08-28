/**
 * @vitest-environment jsdom
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  sendOrchestrationTurn: vi.fn(),
  interruptOrchestrationTurn: vi.fn(),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DelegatedTaskCoordinator } from '../components/session-detail/DelegatedTaskCoordinator';

/**
 * archive#1781. `DelegatedTaskCoordinator` renders `tasks[0]` only, and
 * since archive#1791 a dead session's `pendingReview` never clears — so this
 * card offered "Review request" on a session nothing could answer, forever,
 * and hid the composer behind the same stale flag.
 */

const observation = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-7f3a',
  observedAt: '2026-08-03T12:04:03.000Z',
} as const;

function task(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'acme',
    threadId: 'thread-dead',
    status: 'ready',
    controlMode: 'station-owned',
    lifecycleState: 'review_pending',
    pendingReview: true,
    answerability: { answerable: true },
    delegation: { taskId: 'task-42' },
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    ...overrides,
  };
}

function renderCard(summary: OrchestrationSessionSummary) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DelegatedTaskCoordinator
        apiBase="http://station.test"
        tasks={[summary]}
        onOpen={vi.fn()}
        onDelegate={vi.fn()}
        onTaskChanged={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('DelegatedTaskCoordinator answerability', () => {
  test('AC2: an unanswerable task renders the observation instead of "Review request"', () => {
    renderCard(task({ answerability: observation }));

    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
    const notice = screen.getByTestId('coordinator-answerability').textContent;
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('AC2: "View task" stays — the annotation replaces the action, not the route', () => {
    renderCard(task({ answerability: observation }));
    expect(screen.getByRole('button', { name: 'View task' })).toBeTruthy();
  });

  test('the card is still rendered at all (anti-filter)', () => {
    renderCard(task({ answerability: observation }));
    expect(screen.getByTestId('delegated-task-coordinator')).toBeTruthy();
    // archive#3227: was `'42'` — the bare `humanizeId(taskId)` output.
    // The heading now renders `sessionTitle`, the one name this session is
    // listed under, so the coordinator and the row beside it cannot disagree.
    // Kept as an assertion on the exact string rather than relaxed: a raw id
    // reaching this heading is the defect, and only an exact pin sees it.
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(
      'Worker task · 42',
    );
  });

  test('the composer is offered again, because the dead card owns nothing', () => {
    // Suppressing the composer rested entirely on "the Review request button
    // below owns the response affordance". When that button is gone, keeping
    // the composer hidden leaves the card with no way to act at all. The
    // send still round-trips and fails loudly server-side — enforcement
    // stays there, never here.
    renderCard(task({ answerability: observation }));
    expect(screen.getByLabelText('Direct worker follow-up')).toBeTruthy();
  });

  test('AC5 (control): a live review_pending task is completely unchanged', () => {
    renderCard(task());
    expect(screen.getByRole('button', { name: 'Review request' })).toBeTruthy();
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
    expect(
      screen.getByText('This worker is waiting for your response.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Direct worker follow-up')).toBeNull();
  });

  test('AC5 (control): a retriable `failed` task is NOT treated as unanswerable', () => {
    renderCard(task({ lifecycleState: 'failed', pendingReview: false }));
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
  });

  /**
   *A detached `completed` task takes the `past_resume`
   * arm, and recovery skips already-closed sessions at boot — so after any
   * restart EVERY cleanly-finished delegated task reads `answerable: false`.
   * The notice was not gated on `isTerminal`, so every one of them was
   * annotated "the session cannot resume": true, and about nothing the user
   * asked for. The `failed` control above could not catch it, because `failed`
   * is the one terminal state that stays answerable.
   */
  test('a cleanly COMPLETED task is not annotated', () => {
    renderCard(
      task({
        lifecycleState: 'completed',
        pendingReview: false,
        answerability: {
          answerable: false,
          qualification: 'past_resume',
          observedBy: 'station-7f3a',
          observedAt: '2026-08-03T12:04:03.000Z',
        },
      }),
    );
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
  });

  /**
   * The steady state this file's header describes, which the control above
   * does NOT reproduce: `pendingReview` stays true forever on a dead session,
   * so `needsReview` is true and the terminal scoping actually has to hold.
   * With `pendingReview: false` the control passes whether or not the gate
   * exists, because `needsReview` short-circuits everything downstream.
   *
   * Deriving `liveReview` from `unanswerableNotice === null` failed here: the
   * notice was forced null by `!isTerminal`, `liveReview` read that as "not
   * unanswerable", and the card claimed a live request on a finished task.
   */
  test('a COMPLETED task with a stale pendingReview claims nothing live', () => {
    renderCard(
      task({
        lifecycleState: 'completed',
        pendingReview: true,
        answerability: {
          answerable: false,
          qualification: 'past_resume',
          observedBy: 'station-7f3a',
          observedAt: '2026-08-03T12:04:03.000Z',
        },
      }),
    );
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
    expect(
      screen.queryByText('This worker is waiting for your response.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
    // the route to the task survives; only the false claim goes.
    expect(screen.getByRole('button', { name: 'View task' })).toBeTruthy();
  });

  /**
   * The one row where `!isTerminal` must be on `liveReview` in its OWN right.
   * Terminal, review still open, and ANSWERABLE — a `failed` session, which
   * `canSessionLifecycleStateResume` keeps resumable, so
   * `session-lifecycle-service` deliberately holds `pendingReview` true and
   * `delegatedTaskPriority` ranks it 0, the highest. This is the row most
   * likely to reach `tasks[0]`.
   *
   * The stale-pendingReview test above cannot guard it: that fixture is
   * unanswerable, so `!isUnanswerable` is already false and masks a missing
   * `!isTerminal`. Drop `!isTerminal` from `liveReview` alone and every other
   * test in this file stays green.
   */
  test('a terminal but ANSWERABLE task with an open review offers no live CTA', () => {
    renderCard(task({ lifecycleState: 'failed', pendingReview: true }));
    expect(screen.queryByRole('button', { name: 'Review request' })).toBeNull();
    expect(
      screen.queryByText('This worker is waiting for your response.'),
    ).toBeNull();
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
    expect(screen.getByRole('button', { name: 'View task' })).toBeTruthy();
  });

  test('nor is a task with nothing awaiting a response', () => {
    // No open request → nothing for the field to be about.
    renderCard(
      task({
        lifecycleState: 'queued',
        pendingReview: false,
        answerability: observation,
      }),
    );
    expect(screen.queryByTestId('coordinator-answerability')).toBeNull();
  });
});

/**
 * archive#3139. This card printed `task.lifecycleState` verbatim, so the meta
 * row read `needs_input` / `review_pending` — the exact regression
 * `sessionLifecycleLabel`'s docblock exists to prevent, three files away and
 * already used by `SessionsView` and `SessionDetailHeader`.
 */
describe('DelegatedTaskCoordinator lifecycle copy', () => {
  test('renders the lifecycle state in words, never the wire token', () => {
    renderCard(task({ lifecycleState: 'needs_input', pendingReview: false }));

    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(document.body.textContent).not.toContain('needs_input');
  });

  test('covers the other tokenised states this card can reach', () => {
    for (const [state, label] of [
      ['review_pending', 'Review pending'],
      ['queued', 'Queued'],
    ] as const) {
      const { unmount } = renderCard(
        task({ lifecycleState: state, pendingReview: false }),
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(document.body.textContent).not.toContain(state);
      unmount();
    }
  });
});
