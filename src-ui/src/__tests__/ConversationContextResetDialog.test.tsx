// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationContextResetDialog } from '../components/chat-dock/ConversationContextResetDialog';
import {
  type ConversationContextBoundaryEligibility,
  conversationContextBoundaryEligibility,
} from '../components/chat-dock/conversationContextBoundaryEligibility';
import { writeConversationContextBoundaryUiState } from '../components/chat-dock/conversationContextBoundaryUiState';

const reserve = vi.fn();
const cancel = vi.fn();
const dispatchWithReceipt = vi.fn();
const status = vi.fn(
  (..._args: [string, string, string, unknown]): { data?: unknown } => ({
    data: undefined,
  }),
);
// The real module stays underneath: `userFacingErrorMessage` reads
// `StationHttpError` from it.
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  reserveConversationContextBoundary: (...args: unknown[]) => reserve(...args),
  cancelConversationContextBoundary: (...args: unknown[]) => cancel(...args),
}));
vi.mock('@kontourai/station-sdk', () => ({
  STOP_REQUEST_BUDGET_MS: 100,
  dispatchOrchestrationCommandWithReceipt: (...args: unknown[]) =>
    dispatchWithReceipt(...args),
  isProvablyNotSent: (error: unknown) =>
    error instanceof Error && error.message === 'not sent',
  useConversationContextBoundaryStatusQuery: (
    ...args: [string, string, string, unknown]
  ) => status(...args),
}));

const reserveEligibility: ConversationContextBoundaryEligibility = {
  kind: 'reserve',
};
const stopEligibility: ConversationContextBoundaryEligibility = {
  kind: 'stop-session',
  reason: 'Stop the agent first.',
};

function renderDialog(
  eligibility = reserveEligibility,
  overrides: Partial<
    Omit<
      React.ComponentProps<typeof ConversationContextResetDialog>,
      'apiBase' | 'conversationId' | 'sessionId' | 'eligibility'
    >
  > = {},
) {
  const props = {
    apiBase: 'http://station.test',
    conversationId: 'c',
    sessionId: 's',
    eligibility,
    onStoppedSessionRefreshed: vi.fn().mockResolvedValue({
      lifecycleState: 'canceled',
      hasActiveTurn: false,
    }),
    onClose: vi.fn(),
    onReserved: vi.fn(),
    ...overrides,
  };
  render(<ConversationContextResetDialog {...props} />);
  return props;
}

describe('ConversationContextResetDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    reserve.mockReset();
    cancel.mockReset();
    dispatchWithReceipt.mockReset();
    status.mockReset();
    status.mockReturnValue({ data: undefined });
  });
  afterEach(() => vi.restoreAllMocks());

  test('reserves directly only after the dock has observed a stopped Session', async () => {
    reserve.mockResolvedValueOnce({
      boundaryId: 'b',
      conversationId: 'c',
      policy: 'empty-next-cold-start',
      status: 'reserved',
    });
    renderDialog();
    expect(screen.getByText(/loses its tool state and approvals/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset agent context' }),
    );
    await vi.waitFor(() =>
      expect(reserve).toHaveBeenCalledWith(
        'http://station.test',
        'c',
        expect.objectContaining({
          policy: 'empty-next-cold-start',
          expectedCurrentSessionId: 's',
        }),
      ),
    );
    expect(dispatchWithReceipt).not.toHaveBeenCalled();
  });

  // #2708 A-3a: the boundary route validates its body; a refusal as the REAL
  // execution fetcher throws it reads as the server's reason.
  test('a validation refusal from the real fetcher shows its reason', async () => {
    const actual = await vi.importActual<
      typeof import('@kontourai/station-sdk/client')
    >('@kontourai/station-sdk/client');
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: 'Validation failed',
          details: {
            formErrors: [],
            fieldErrors: { policy: ['Choose how the context is replaced.'] },
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    let refusal: unknown;
    try {
      refusal = await actual
        .reserveConversationContextBoundary('http://station.test', 'c', {
          idempotencyKey: 'k',
        } as never)
        .catch((caught: unknown) => caught);
    } finally {
      globalThis.fetch = previous;
    }
    reserve.mockRejectedValueOnce(refusal);
    renderDialog();
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset agent context' }),
    );

    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Choose how the context is replaced.',
      ),
    );
  });

  test('stops a ready Session, confirms its lifecycle, then reserves the boundary', async () => {
    dispatchWithReceipt.mockResolvedValueOnce({
      receipt: { commandId: 'stop-1', status: 'accepted' },
      result: undefined,
    });
    reserve.mockResolvedValueOnce({
      boundaryId: 'b',
      conversationId: 'c',
      policy: 'empty-next-cold-start',
      status: 'reserved',
    });
    const props = renderDialog(stopEligibility);
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop agent and reset' }),
    );
    await vi.waitFor(() =>
      expect(dispatchWithReceipt).toHaveBeenCalledWith(
        { type: 'stopSession', threadId: 's' },
        'http://station.test',
        100,
      ),
    );
    await vi.waitFor(() =>
      expect(props.onStoppedSessionRefreshed).toHaveBeenCalled(),
    );
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(screen.getByText('Agent stopped.').getAttribute('role')).toBe(
        'status',
      ),
    );
  });

  test('does not reserve after a failed or indeterminate stop', async () => {
    dispatchWithReceipt.mockRejectedValueOnce(new Error('timeout'));
    renderDialog(stopEligibility);
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop agent and reset' }),
    );
    await vi.waitFor(() =>
      expect(screen.getByText(/Nothing was reset/).textContent).toContain(
        "Station couldn't confirm the agent stopped",
      ),
    );
    expect(reserve).not.toHaveBeenCalled();
  });

  test('does not reserve when a stop receipt arrives but Station cannot confirm stopped lifecycle', async () => {
    dispatchWithReceipt.mockResolvedValueOnce({
      receipt: { commandId: 'stop-1', status: 'accepted' },
      result: undefined,
    });
    const props = renderDialog(stopEligibility, {
      onStoppedSessionRefreshed: vi.fn().mockResolvedValue(null),
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop agent and reset' }),
    );
    await vi.waitFor(() =>
      expect(props.onStoppedSessionRefreshed).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText(/Nothing was reset/).textContent).toContain(
      "Station couldn't confirm the agent stopped",
    );
    expect(screen.queryByText('Agent stopped.')).toBeNull();
    expect(reserve).not.toHaveBeenCalled();
  });

  test('refuses an active turn or approval without exposing a reserve action', () => {
    renderDialog({
      kind: 'blocked',
      reason: 'Stop or finish the current turn first.',
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Stop or finish the current turn first.',
    );
    expect(
      screen.queryByRole('button', { name: 'Reset agent context' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Stop agent and reset' }),
    ).toBeNull();
  });

  test('reopened after reserving a history reset, it says the agent continues rather than the default fresh start', () => {
    writeConversationContextBoundaryUiState('k', {
      boundaryId: 'b',
      conversationId: 'c',
      policy: 'continue-from-history',
      status: 'reserved',
      priorTranscriptInjected: true,
    } as never);
    renderDialog();
    expect(screen.getByRole('status').textContent).toBe(
      'Ready. On your next message the agent continues from chat history.',
    );
    expect(
      (
        screen.getByRole('radio', {
          name: 'Continue with chat history',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  test.each(['reserved', 'claimed', 'indeterminate', 'failed'] as const)(
    'a held %s reservation locks the reset choice to the reserved policy',
    (status) => {
      writeConversationContextBoundaryUiState('k', {
        boundaryId: 'b',
        conversationId: 'c',
        policy: 'continue-from-history',
        status,
        priorTranscriptInjected: true,
      } as never);
      renderDialog();
      const history = screen.getByRole('radio', {
        name: 'Continue with chat history',
      }) as HTMLInputElement;
      const fresh = screen.getByRole('radio', {
        name: 'Start fresh (agent forgets this chat)',
      }) as HTMLInputElement;
      expect(history.checked).toBe(true);
      expect(history.disabled).toBe(true);
      expect(fresh.disabled).toBe(true);
      if (status === 'reserved') {
        expect(screen.getByRole('status').textContent).toBe(
          'Ready. On your next message the agent continues from chat history.',
        );
      }
      if (status === 'failed') {
        // The retry resends the policy the held key was reserved with.
        reserve.mockResolvedValueOnce({
          boundaryId: 'b',
          conversationId: 'c',
          policy: 'continue-from-history',
          status: 'reserved',
        });
        fireEvent.click(screen.getByRole('button', { name: 'Retry reset' }));
        expect(reserve).toHaveBeenCalledWith(
          'http://station.test',
          'c',
          expect.objectContaining({
            policy: 'continue-from-history',
            idempotencyKey: 'k',
          }),
        );
      }
    },
  );

  test('the status line reports the server-observed reserved policy', () => {
    status.mockReturnValue({
      data: {
        boundaryId: 'b',
        conversationId: 'c',
        policy: 'continue-from-history',
        status: 'reserved',
        priorTranscriptInjected: true,
      },
    });
    writeConversationContextBoundaryUiState('k', {
      boundaryId: 'b',
      conversationId: 'c',
      policy: 'continue-from-history',
      status: 'reserved',
      priorTranscriptInjected: true,
    } as never);
    renderDialog();
    expect(screen.getByRole('status').textContent).toBe(
      'Ready. On your next message the agent continues from chat history.',
    );
  });

  test('keeps a keyboard-reachable close control for mobile dialog surfaces', () => {
    const onClose = vi.fn();
    renderDialog(reserveEligibility, { onClose });
    const close = screen.getByRole('button', { name: 'Close context reset' });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('conversationContextBoundaryEligibility', () => {
  const session = {
    id: 's',
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Chat',
    source: 'manual',
    messages: [],
    input: '',
    attachments: [],
    queuedMessages: [],
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
  } as any;
  const orchestrationSession = {
    lifecycleState: 'running',
    hasActiveTurn: false,
  } as any;

  test('requires explicit session stop for an idle-ready Session', () => {
    expect(
      conversationContextBoundaryEligibility({
        session,
        sessionRead: 'present',
        orchestrationSession,
        hasLocalDeferredMessages: false,
      }),
    ).toMatchObject({ kind: 'stop-session' });
  });

  test('requires no second stop after a stopped terminal lifecycle', () => {
    expect(
      conversationContextBoundaryEligibility({
        session,
        sessionRead: 'present',
        orchestrationSession: {
          ...orchestrationSession,
          lifecycleState: 'canceled',
        },
        hasLocalDeferredMessages: false,
      }),
    ).toEqual({ kind: 'reserve' });
  });

  test('refuses active turns, approvals, and locally queued work before Stop or reserve', () => {
    expect(
      conversationContextBoundaryEligibility({
        session,
        sessionRead: 'present',
        orchestrationSession: { ...orchestrationSession, hasActiveTurn: true },
        hasLocalDeferredMessages: false,
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'Stop or finish the current turn first.',
    });
    expect(
      conversationContextBoundaryEligibility({
        session: { ...session, orchestrationStatus: 'awaiting-approval' },
        sessionRead: 'present',
        orchestrationSession,
        hasLocalDeferredMessages: false,
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'Stop or finish the current turn first.',
    });
    expect(
      conversationContextBoundaryEligibility({
        session,
        sessionRead: 'present',
        orchestrationSession,
        hasLocalDeferredMessages: true,
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'Send or discard queued messages first.',
    });
  });
});
