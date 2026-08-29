// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationContextResetDialog } from '../components/chat-dock/ConversationContextResetDialog';
import {
  type ConversationContextBoundaryEligibility,
  conversationContextBoundaryEligibility,
} from '../components/chat-dock/conversationContextBoundaryEligibility';

const reserve = vi.fn();
const cancel = vi.fn();
const dispatchWithReceipt = vi.fn();
const status = vi.fn(
  (..._args: [string, string, string, unknown]): { data?: unknown } => ({
    data: undefined,
  }),
);
vi.mock('@kontourai/station-sdk/client', () => ({
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
  reason: 'The current Session is ready but still open.',
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
    expect(screen.getByText(/engine-native history/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Replace engine context' }),
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
      screen.getByRole('button', { name: 'Stop current Session' }),
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
      expect(
        screen.getByText(/Stop receipt stop-1 received/).textContent,
      ).toContain('stop-1'),
    );
  });

  test('does not reserve after a failed or indeterminate stop', async () => {
    dispatchWithReceipt.mockRejectedValueOnce(new Error('timeout'));
    renderDialog(stopEligibility);
    fireEvent.click(
      screen.getByRole('button', { name: 'Stop current Session' }),
    );
    await vi.waitFor(() =>
      expect(
        screen.getByText(/No context boundary was reserved/).textContent,
      ).toContain('No context boundary was reserved'),
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
      screen.getByRole('button', { name: 'Stop current Session' }),
    );
    await vi.waitFor(() =>
      expect(props.onStoppedSessionRefreshed).toHaveBeenCalledOnce(),
    );
    expect(
      screen.getByText(/No context boundary was reserved/).textContent,
    ).toContain('No context boundary was reserved');
    expect(reserve).not.toHaveBeenCalled();
  });

  test('refuses an active turn or approval without exposing a reserve action', () => {
    renderDialog({
      kind: 'blocked',
      reason:
        'The current turn or approval is still active. Stop or finish it before replacing the engine context.',
    });
    expect(screen.getByRole('alert').textContent).toContain('approval');
    expect(
      screen.queryByRole('button', { name: 'Replace engine context' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Stop current Session' }),
    ).toBeNull();
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
    hasUnread: false,
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
      reason: expect.stringMatching(/turn or approval/i),
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
      reason: expect.stringMatching(/turn or approval/i),
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
      reason: expect.stringMatching(/queued or offline/i),
    });
  });
});
