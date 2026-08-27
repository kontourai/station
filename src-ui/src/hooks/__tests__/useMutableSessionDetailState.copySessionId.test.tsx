/**
 * @vitest-environment jsdom
 *
 * station#3347 — `copySessionId` used `navigator.clipboard.writeText(id).then(ok, err)`.
 * That handles a *refusal*, but on an insecure origin (`navigator.clipboard`
 * undefined) the member access throws SYNCHRONOUSLY, past the rejection
 * handler: neither toast fired and the click died as an unhandled error.
 *
 * The hook's own docblock warns that reaching it needs "the whole
 * react-query/toast provider stack". It does not: the four SDK queries stub
 * flat, the three mutation fns are never invoked on this path, and the only
 * real provider needed is a QueryClient. Nothing here drives the session
 * detail's render tree — this file covers the copy path and nothing else.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from '../../__tests__/clipboard-stubs';

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));

const emptyQuery = { data: undefined, isLoading: false, isError: false };
vi.mock('@kontourai/station-sdk', () => ({
  useAttentionQuery: () => ({ ...emptyQuery, error: null, refetch: vi.fn() }),
  useWorkflowTasksQuery: () => emptyQuery,
  useSessionFlowRunQuery: () => emptyQuery,
  useSessionBuilderRunQuery: () => emptyQuery,
  sendOrchestrationTurn: vi.fn(),
  resolveOrchestrationRequest: vi.fn(),
  interruptOrchestrationTurn: vi.fn(),
}));

import { useMutableSessionDetailState } from '../useMutableSessionDetailState';

const THREAD_ID = 'conversation:copy-me-123';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderCopy() {
  return renderHook(
    () =>
      useMutableSessionDetailState({
        apiBase: 'http://localhost:3242',
        session: {
          threadId: THREAD_ID,
          provider: 'claude',
          status: 'ready',
          controlMode: 'station-owned',
          createdAt: '2026-08-19T00:00:00Z',
          updatedAt: '2026-08-19T00:00:00Z',
          isLoaded: true,
          isPersisted: true,
          eventCount: 0,
          // Required wire member — the summary's own answer, not a re-fold.
          answerability: { answerable: true },
          // Minimal summary: this file exercises only the copy path.
          //
          // station#3565: this fixture was `as unknown as
          // OrchestrationSessionSummary`, which absorbed four type violations
          // — an `agentSlug` member the shape does not have, and `'idle'` for
          // both `status` and `lifecycleState`, which neither union admits.
          // `satisfies` is deliberate: it keeps the compiler looking, so the
          // next member added to the summary is a compile error here rather
          // than a hook proven against a session that cannot arrive.
          //
          // Every replacement was chosen to leave runtime behaviour identical,
          // so this file still proves what it proved before:
          //  - `agentSlug` was never read (the hook reads `assignedAgentSlug`,
          //    which was absent then and is absent now — the metadata row it
          //    feeds resolved to null either way). Adding `assignedAgentSlug`
          //    to "preserve the intent" would have populated that row and
          //    changed the subject.
          //  - `status` is read nowhere in this hook; `'ready'` is simply the
          //    valid spelling of the live-but-not-working session `'idle'` was
          //    reaching for.
          //  - `lifecycleState` is omitted rather than guessed. It is optional,
          //    and `foldedSessionLifecycleState` is `state ?? 'running'`, so
          //    absent folds to `'running'` — non-terminal and non-stopped,
          //    exactly what the invalid `'idle'` folded to. The one direct
          //    read (`=== 'needs_input'`) is false for both.
        } satisfies OrchestrationSessionSummary,
        onTaskChanged: vi.fn(),
        events: [],
        visualViewport: { height: 900 },
      }),
    { wrapper },
  );
}

afterEach(() => {
  showToast.mockReset();
  clipboardAbsent();
});

describe('useMutableSessionDetailState copySessionId (station#3347)', () => {
  test('a resolved write reports the copy', async () => {
    const writeText = clipboardWrites();
    const { result } = renderCopy();

    result.current.copySessionId();

    expect(writeText).toHaveBeenCalledWith(THREAD_ID);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Session ID copied'),
    );
  });

  test('a refused write reports the failure', async () => {
    clipboardRefuses();
    const { result } = renderCopy();

    result.current.copySessionId();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not copy the session ID'),
    );
    expect(showToast).not.toHaveBeenCalledWith('Session ID copied');
  });

  // The arm the old `.then(ok, err)` shape could not reach at all.
  test('an insecure origin with no clipboard API reports the failure instead of throwing', async () => {
    clipboardAbsent();
    const { result } = renderCopy();

    expect(() => result.current.copySessionId()).not.toThrow();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not copy the session ID'),
    );
    expect(showToast).not.toHaveBeenCalledWith('Session ID copied');
  });
});
