// @vitest-environment jsdom

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const adoptOrchestrationSession = vi.hoisted(() => vi.fn());
/**
 * `importOriginal`, not a bare factory. A factory mock makes every unlisted
 * export a hard throw, so this file went red the moment the component reached
 * for one more of them (`getStarterWork`, `launchContinueSessionStarter`,
 * `AdoptSessionError`) — and `AdoptSessionError` in particular has to be the
 * REAL class here, because the component's classifier branches on
 * `error instanceof AdoptSessionError` to decide whether a failure keeps its
 * declared class or gets re-derived from the transport.
 *
 * Only what this file actually drives is overridden.
 */
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  adoptOrchestrationSession,
  createAdoptOrchestrationSessionIntent: () => ({
    idempotencyKey: '55555555-5555-4555-8555-555555555555',
  }),
  // An already-bound starter is the branch that continues through
  // `adoptOrchestrationSession`, which is the call every test below drives.
  // Answered here rather than stood up: no server exists in this file, and a
  // real read would only decide which continuation path runs.
  getStarterWork: async () => ({
    state: 'bound' as const,
    binding: {
      schemaVersion: 1 as const,
      starterId: 'continue-session',
      targetRef: {
        kind: 'session' as const,
        id: 'external:claude:raw-thread-id',
      },
      operationId: 'starter-session:test',
      boundAt: '2026-06-27T00:00:00.000Z',
    },
  }),
}));

import { AttachedSessionDetail } from '../components/session-detail/AttachedSessionDetail';
import { ToastProvider } from '../contexts/ToastContext';

function classifiedAdoptionError(
  failureClass:
    | 'certain-response'
    | 'certain-not-sent'
    | 'uncertain-no-response',
  message: string,
  retryable: boolean,
) {
  return Object.assign(new Error(message), { failureClass, retryable });
}

const base = {
  provider: 'claude',
  threadId: 't1',
  createdAt: '2026-06-27T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

function renderAttached({
  connected = true,
  upgradeRequired,
  streamError,
  liveStreamStoppedTerminal,
  historyStoppedTerminal,
  capabilityRecoveryExhausted,
  onRetryCapabilityRecovery,
  session: sessionOverrides,
}: {
  connected?: boolean;
  upgradeRequired?: boolean;
  streamError?: Error;
  liveStreamStoppedTerminal?: boolean;
  historyStoppedTerminal?: boolean;
  capabilityRecoveryExhausted?: boolean;
  onRetryCapabilityRecovery?: () => void;
  session?: Record<string, unknown>;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The real provider, not a stub: the component calls `useToast` at its top
  // (AttachedSessionDetail.tsx), which throws outside a provider — so a render
  // without one fails before any assertion in this file runs.
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AttachedSessionDetail
          apiBase="http://station.test"
          session={
            {
              threadId: 'external:claude:raw-thread-id',
              provider: 'claude',
              controlMode: 'read-only-attached',
              createdAt: '2026-06-27T00:00:00.000Z',
              updatedAt: '2026-06-27T00:00:00.000Z',
              ...sessionOverrides,
            } as any
          }
          onAdopted={vi.fn()}
          getSelectionIntent={() => 0}
          events={[
            ev({ method: 'turn.started', turnId: 'r1', prompt: 'list files' }),
            ev({ method: 'content.text-delta', itemId: 'i1', delta: 'Sure.' }),
            ev({
              method: 'turn.completed',
              turnId: 'r1',
              finishReason: 'stop',
            }),
          ]}
          connected={connected}
          upgradeRequired={upgradeRequired}
          streamError={streamError}
          liveStreamStoppedTerminal={liveStreamStoppedTerminal}
          historyStoppedTerminal={historyStoppedTerminal}
          capabilityRecoveryExhausted={capabilityRecoveryExhausted}
          onRetryCapabilityRecovery={onRetryCapabilityRecovery}
          visualViewport={{ style: {} } as any}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AttachedSessionDetail permission-posture row badge (station#1424)', () => {
  test.each(['codex', 'future-engine'])(
    'keeps unsupported or unknown %s continuation visible and disabled',
    (provider) => {
      adoptOrchestrationSession.mockClear();
      renderAttached({ session: { provider } });
      const button = screen.getByRole('button', {
        name: 'Continue in Station',
      });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(
        screen.getByText(
          provider === 'codex'
            ? 'Station can read this Codex transcript, but independent continuation is not available yet.'
            : 'Station has not established independent continuation support for this engine.',
        ),
      ).toBeTruthy();
      fireEvent.click(button);
      expect(adoptOrchestrationSession).not.toHaveBeenCalled();
    },
  );

  test('every assistant row is annotated "Read only" — this view only ever shows a read-only-attached session', () => {
    renderAttached();
    // The user turn (from the prompt) never gets the badge.
    const userRole = screen.getByText('You');
    expect(userRole.textContent).toBe('You');
    // The assistant turn does.
    const assistantRole = screen.getByText('Assistant', { exact: false });
    expect(assistantRole.textContent).toContain('Assistant');
    expect(assistantRole.textContent).toContain('Read only');
  });

  test('uses an engine session fallback and keeps the raw id in Details', () => {
    renderAttached();

    expect(
      screen.getByRole('heading', { name: 'Claude Code session' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: /raw thread id/i }),
    ).toBeNull();
    expect(screen.getByText('external:claude:raw-thread-id')).toBeTruthy();
  });

  /**
   * archive#3227. This heading was an INLINE copy of `sessionTitle`'s
   * first and last branches — `displayTitle?.trim || `${displayProvider}
   * session`` — with the middle one missing. The case above could never
   * notice, because a session with no delegation takes the same branch in
   * both versions. An attached session that DOES carry a delegated task id
   * was the whole divergence: this pane said "Claude Code session" while the
   * list it was opened from said "Worker task · adopt review", for one
   * session, one click apart.
   */
  test('a delegated attached session is named by its task, as the list names it', () => {
    renderAttached({
      session: { delegation: { taskId: 'task:adopt-review' } },
    });

    expect(
      screen.getByRole('heading', { name: 'Worker task · adopt review' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Claude Code session' }),
    ).toBeNull();
  });

  test("the server's own title still outranks both branches", () => {
    renderAttached({ session: { displayTitle: 'Ship the Home history fix' } });

    expect(
      screen.getByRole('heading', { name: 'Ship the Home history fix' }),
    ).toBeTruthy();
  });

  test('collapses a disconnected stream into one plain-language state and keeps continuation available', () => {
    renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
    });

    expect(
      screen.getByText(
        "Station isn't responding right now — retrying automatically.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('This transcript is read-only and safe.'),
    ).toBeTruthy();
    // The stream's SSE state says nothing about the REST adoption channel
    // (archive#2630) — the recovery action stays enabled.
    expect(
      screen
        .getByRole('button', { name: 'Continue in Station' })
        .getAttribute('disabled'),
    ).toBeNull();
    expect(screen.queryByText('○ reconnecting')).toBeNull();
    expect(screen.getByText('Session history transport failed.')).toBeTruthy();
  });

  /**
   * archive#3426. The generic "retrying automatically" copy was false for a
   * credential rejection (nothing is retrying) and for an exhausted
   * capability re-probe (nothing is retrying, but it isn't a rejection
   * either). These pin the three honest states the fold now derives.
   */
  test('names the cause when the live stream stopped for good on a credential rejection', () => {
    renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      liveStreamStoppedTerminal: true,
    });

    expect(
      screen.getByText(
        "Station stopped reconnecting — it rejected this session's credentials.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Station isn't responding right now — retrying automatically.",
      ),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  });

  test('names the cause when the history-window ladder stopped for good on a credential rejection', () => {
    renderAttached({
      connected: true,
      streamError: new Error('Unauthorized'),
      historyStoppedTerminal: true,
    });

    expect(
      screen.getByText(
        "Station stopped reconnecting — it rejected this session's credentials.",
      ),
    ).toBeTruthy();
  });

  test('offers a manual retry when the capability re-probe is exhausted — not a credential story', () => {
    const onRetryCapabilityRecovery = vi.fn();
    renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      capabilityRecoveryExhausted: true,
      onRetryCapabilityRecovery,
    });

    expect(
      screen.getByText(
        "Station stopped checking for this session's history and live updates automatically.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Station isn't responding right now — retrying automatically.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(/rejected this session's credentials/),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetryCapabilityRecovery).toHaveBeenCalledTimes(1);
  });

  test('a terminal credential rejection takes precedence over an also-exhausted capability budget', () => {
    renderAttached({
      connected: false,
      streamError: new Error('Session history transport failed.'),
      liveStreamStoppedTerminal: true,
      capabilityRecoveryExhausted: true,
    });

    expect(
      screen.getByText(
        "Station stopped reconnecting — it rejected this session's credentials.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
  });

  test('an upgrade-required stream names the update, never the retrying story', () => {
    renderAttached({
      connected: false,
      upgradeRequired: true,
      streamError: new Error('capability negotiation failed'),
    });

    expect(
      screen.getByText(
        "This Station needs an update before it can show this session's history.",
      ),
    ).toBeTruthy();
    // Retrying cannot cure an incompatible host (sol).
    expect(
      screen.queryByText(
        "Station isn't responding right now — retrying automatically.",
      ),
    ).toBeNull();
  });

  test('a non-transport continuation failure is not narrated as unreachability', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockRejectedValueOnce(
      new Error('source session is already being continued'),
    );
    renderAttached();

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't start the continuation. Technical detail is under Details below.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/isn't responding right now/)).toBeNull();
    expect(
      screen.getByText('source session is already being continued'),
    ).toBeTruthy();
  });

  test('a certainly unsent continuation keeps the sibling recovery copy and retry enabled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockRejectedValueOnce(
      classifiedAdoptionError(
        'certain-not-sent',
        'Native Station request failed: Station request timed out before response headers arrived.',
        true,
      ),
    );
    renderAttached();

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't start the continuation — Station isn't responding right now.",
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(
        'Native Station request failed: Station request timed out before response headers arrived.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Continue in Station' })
        .getAttribute('disabled'),
    ).toBeNull();
    vi.restoreAllMocks();
  });

  test('an uncertain continuation preserves the recovery copy and offers safe retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adoptOrchestrationSession.mockRejectedValueOnce(
      classifiedAdoptionError(
        'uncertain-no-response',
        'Station did not answer before the request ended.',
        true,
      ),
    );
    renderAttached();

    fireEvent.click(
      screen.getByRole('button', { name: 'Continue in Station' }),
    );
    await screen.findByText(
      "Couldn't start the continuation — Station isn't responding right now.",
    );
    expect(
      screen.getByText(
        'Retry safely — Station will not duplicate the continuation.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Continue in Station' })
        .getAttribute('disabled'),
    ).toBeNull();
    vi.restoreAllMocks();
  });
});
