/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { projectOutboundQueueEntries } from '../hooks/outboundQueueProjection';
import type { QueuedOutboundTurn } from '../lib/outboundQueue';

const discardOutboundTurnMock = vi.fn();
const editOutboundTurnMock = vi.fn();
const reorderOutboundTurnMock = vi.fn();
const mergeOutboundTurnsMock = vi.fn();
const unmergeOutboundTurnMock = vi.fn();
const sendHeldMock = vi.fn();
const dismissUnconfirmedMock = vi.fn();

vi.mock('../lib/outboundQueue', () => ({
  isWorkspaceRefusedTurn: (turn: { status: string; lastError?: string }) =>
    turn.status === 'failed' &&
    turn.lastError?.startsWith('Workspace refusal:') === true,
  outboundDispatch: {
    discard: (...args: unknown[]) => discardOutboundTurnMock(...args),
    edit: (...args: unknown[]) => editOutboundTurnMock(...args),
    reorder: (...args: unknown[]) => reorderOutboundTurnMock(...args),
    merge: (...args: unknown[]) => mergeOutboundTurnsMock(...args),
    unmerge: (...args: unknown[]) => unmergeOutboundTurnMock(...args),
    sendHeld: (...args: unknown[]) => sendHeldMock(...args),
    dismissUnconfirmed: (...args: unknown[]) => dismissUnconfirmedMock(...args),
    retiredKeys: async () => ({ discarded: [], accepted: [] }),
  },
}));

import { OutboundQueuedMessages } from '../components/chat/OutboundQueuedMessages';

describe('OutboundQueuedMessages (station#2522)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discardOutboundTurnMock.mockResolvedValue(undefined);
    editOutboundTurnMock.mockResolvedValue(undefined);
    reorderOutboundTurnMock.mockResolvedValue(undefined);
    mergeOutboundTurnsMock.mockResolvedValue(undefined);
    unmergeOutboundTurnMock.mockResolvedValue(undefined);
    for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
      activeChatsStore.removeChat(sessionId);
    }
  });

  it('a copy held by another or a closed window offers Send and Discard only, and Send releases it', async () => {
    sendHeldMock.mockResolvedValue(undefined);
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'held-away',
            content: 'held elsewhere',
            status: 'pending',
            heldElsewhere: true,
          },
          { clientTurnId: 'after', content: 'after it', status: 'pending' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole('button', { name: 'Edit message' }),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Merge/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendHeldMock).toHaveBeenCalledWith('held-away'));
  });

  it('deletes a pending offline message immediately', async () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'turn-1', content: 'withdraw me', status: 'pending' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete message' }));

    await waitFor(() =>
      expect(discardOutboundTurnMock).toHaveBeenCalledWith('turn-1'),
    );
  });

  it('reports how many turns remain once a discard succeeded, and nothing when it fails', async () => {
    const onDiscarded = vi.fn();
    const onError = vi.fn();
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'turn-1', content: 'first', status: 'pending' },
          { clientTurnId: 'turn-2', content: 'second', status: 'pending' },
        ]}
        onError={onError}
        onDiscarded={onDiscarded}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    const [first] = screen.getAllByRole('button', { name: 'Delete message' });
    fireEvent.click(first);
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledWith(1));

    discardOutboundTurnMock.mockRejectedValueOnce(new Error('store gone'));
    onDiscarded.mockClear();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Delete message' })[1],
    );
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('edits a pending offline message in place', async () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'turn-1', content: 'mistkae', status: 'pending' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    const input = screen.getByRole('textbox', { name: 'Edit queued message' });
    fireEvent.change(input, { target: { value: 'corrected message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(editOutboundTurnMock).toHaveBeenCalledWith(
        'turn-1',
        'corrected message',
      ),
    );
  });

  it('reorders a pending message through the durable queue operation', async () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'first', content: 'first', status: 'pending' },
          { clientTurnId: 'second', content: 'second', status: 'pending' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Move message up' })[1]!,
    );

    await waitFor(() =>
      expect(reorderOutboundTurnMock).toHaveBeenCalledWith('second', 'up'),
    );
  });

  it('keeps merging opt-in, previews the text, and offers a pre-send undo', async () => {
    const { rerender } = render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'first', content: 'first', status: 'pending' },
          { clientTurnId: 'second', content: 'second', status: 'pending' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(mergeOutboundTurnsMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview merge' }));
    expect(screen.getByText('Merge preview')).not.toBeNull();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'PRE' &&
          element.textContent === 'first\n\nsecond',
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Merge messages' }));
    await waitFor(() =>
      expect(mergeOutboundTurnsMock).toHaveBeenCalledWith('first', 'second'),
    );

    projectOutboundQueueEntries([
      {
        clientTurnId: 'merged',
        sessionId: 'session-1',
        agentSlug: 'assistant',
        content: 'first\n\nsecond',
        createdAt: 1,
        attempts: 1,
        status: 'pending',
        mergedTurns: [
          {
            clientTurnId: 'first',
            sessionId: 'session-1',
            agentSlug: 'assistant',
            content: 'first',
            createdAt: 1,
            attempts: 1,
            status: 'pending',
          },
          {
            clientTurnId: 'second',
            sessionId: 'session-1',
            agentSlug: 'assistant',
            content: 'second',
            createdAt: 2,
            attempts: 1,
            status: 'pending',
          },
        ],
      } satisfies QueuedOutboundTurn,
    ]);
    const projectedTurns =
      activeChatsStore.getSnapshot()['session-1']!.outboundQueuedTurns!;

    rerender(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={projectedTurns}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo merge' }));
    await waitFor(() =>
      expect(unmergeOutboundTurnMock).toHaveBeenCalledWith('merged'),
    );
  });

  it("lists a running window's claimed send as sending, never as uncertain or withdrawable", () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'already sending',
            status: 'invoking',
            sendUnderWay: true,
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(screen.getByText('1 sending')).not.toBeNull();
    const label = screen.getByText('Sending');
    // Under way elsewhere: a neutral note, not the caution tone.
    expect(label.classList.contains('queued-messages__label--sending')).toBe(
      true,
    );
    expect(
      label.classList.contains('queued-messages__label--unconfirmed'),
    ).toBe(false);
    expect(screen.queryByText(/may have reached/i)).toBeNull();
    expect(screen.queryByText(/no answer yet/i)).toBeNull();
    // Its answer is coming in that window; a Check here would find nothing.
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it("a closed or crashed window's claimed send reads as its bubble does: no answer yet, with Check", () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'its window is gone',
            status: 'invoking',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    expect(screen.queryByText('Sending')).toBeNull();
    expect(screen.queryByText(/sending/)).toBeNull();
    expect(screen.getByText('1 with no answer yet')).toBeTruthy();
    const label = screen.getByText(
      'No answer yet · sends once Station confirms it never arrived',
    );
    expect(
      label.classList.contains('queued-messages__label--unconfirmed'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });

  it('separates waiting, accepted, and may-have-reached counts, in sentence case', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'pending', content: 'later', status: 'pending' },
          { clientTurnId: 'accepted', content: 'sent', status: 'accepted' },
          {
            clientTurnId: 'uncertain',
            content: 'inspect',
            status: 'may-have-started',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    const summary = screen.getByText(
      '1 message waiting to send · 1 accepted, waiting for the agent to finish · 1 may have reached the agent',
    );
    expect(summary.classList.contains('queued-messages__label--summary')).toBe(
      true,
    );
    // The accepted row's note: sentence case, in this list's own words.
    const accepted = screen.getByText(
      'Accepted · waiting for the agent to finish',
    );
    expect(
      accepted.classList.contains('queued-messages__label--accepted'),
    ).toBe(true);
    expect(screen.queryByText(/Accepted; waiting for completion/)).toBeNull();
  });

  it('counts failed drafts as action-required rather than waiting to send', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'pending', content: 'later', status: 'pending' },
          { clientTurnId: 'failed', content: 'fix me', status: 'failed' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(
      screen.getByText('1 message waiting to send · 1 message need action'),
    ).not.toBeNull();
  });

  it('does not offer retry or mutation for a foreground turn that may already have started', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'do not replay',
            status: 'may-have-started',
            lastError: 'Foreground start indeterminate: receipt unavailable',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(screen.getByText('May have reached the agent')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('#3596: an unconfirmed message can be discarded only after the risk is stated and the user confirms', async () => {
    dismissUnconfirmedMock.mockResolvedValue(undefined);
    const onDiscarded = vi.fn();
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'may have gone',
            status: 'may-have-started',
          },
          { clientTurnId: 'turn-2', content: 'after it', status: 'pending' },
        ]}
        onError={vi.fn()}
        onDiscarded={onDiscarded}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    const discard = screen.getByRole('button', { name: 'Discard…' });
    discard.focus();
    fireEvent.click(discard);
    const confirm = screen.getByRole('group', {
      name: 'Discard this message?',
    });
    expect(confirm.textContent).toContain(
      'It may already have reached the agent.',
    );
    // The button stays, points at the question, and focus moves into it.
    expect(discard.isConnected).toBe(true);
    expect(discard.getAttribute('aria-expanded')).toBe('true');
    expect(discard.getAttribute('aria-controls')).toBe(confirm.id);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Keep it' }),
    );
    // Keep it closes the question and hands focus back to Discard….
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(
      screen.queryByRole('group', { name: 'Discard this message?' }),
    ).toBeNull();
    expect(document.activeElement).toBe(discard);
    fireEvent.click(discard);
    expect(dismissUnconfirmedMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'I checked, discard it' }),
    );
    await waitFor(() =>
      expect(dismissUnconfirmedMock).toHaveBeenCalledWith('turn-1'),
    );
    expect(discardOutboundTurnMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledWith(1));
  });

  it('a send with no answer says so, and offers Check and the explicit discard', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'no answer came back',
            status: 'invoking',
            awaitingLookup: true,
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    expect(screen.getByText('1 with no answer yet')).toBeTruthy();
    // The same words its bubble uses.
    expect(
      screen.getByText(
        'No answer yet · sends once Station confirms it never arrived',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/delivery-uncertain/)).toBeNull();
    // Check and Discard… sit in one action group, outside the label.
    const check = screen.getByRole('button', { name: 'Check' });
    const discard = screen.getByRole('button', { name: 'Discard…' });
    expect(check.parentElement).toBe(discard.parentElement);
    expect(
      check.parentElement?.classList.contains('queued-message__actions'),
    ).toBe(true);
  });

  it('#3596: a row still invoking offers no discard; its send may be under way', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          { clientTurnId: 'turn-1', content: 'in flight', status: 'invoking' },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Discard…' })).toBeNull();
  });

  it('offers workspace recovery without a Retry for a permanent refusal', () => {
    const onStartNewChat = vi.fn();
    const attachment = {
      id: 'attachment-1',
      name: 'context.txt',
      type: 'text/plain',
      size: 7,
      data: 'data:text/plain;base64,Y29udGV4dA==',
    };
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'move this message',
            attachments: [attachment],
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={onStartNewChat}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'New chat',
      }),
    );
    expect(onStartNewChat).toHaveBeenCalledWith(
      'move this message',
      [attachment],
      'turn-1',
    );
  });

  it('adds moved-on context and a prominent dismiss when messages are newer than the refused turn', async () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        messages={[{ role: 'assistant', timestamp: 201 }]}
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'possibly answered',
            createdAt: 200,
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'The conversation moved on — this may have been answered from the original workspace',
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(discardOutboundTurnMock).toHaveBeenCalledWith('turn-1'),
    );
  });

  it('does not claim the conversation moved on for a newer non-assistant message', () => {
    // A system event or the user's own later message is not an answer.
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        messages={[
          { role: 'user', timestamp: 300 },
          { role: 'system', timestamp: 400 },
        ]}
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'not answered',
            createdAt: 200,
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(screen.queryByText(/The conversation moved on/)).toBeNull();
  });

  it('does not claim the conversation moved on without a newer message', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        messages={[{ role: 'assistant', timestamp: 200 }]}
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'not advanced',
            createdAt: 200,
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(screen.queryByText(/The conversation moved on/)).toBeNull();
  });

  it('surfaces a pre-draft refusal as its own message, not the kept-row copy', async () => {
    const { NewChatUnavailableError } = await import(
      '../components/chat-dock/newChatErrors'
    );
    const onError = vi.fn();
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'move this message',
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={onError}
        onRetry={vi.fn()}
        onStartNewChat={vi
          .fn()
          .mockRejectedValue(
            new NewChatUnavailableError(
              'agent "codex" is not available on this device',
            ),
          )}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Could not start a new chat: agent "codex" is not available on this device',
      ),
    );
  });

  it('reports a post-draft discard failure with the kept-row copy', async () => {
    const onError = vi.fn();
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'move this message',
            status: 'failed',
            lastError: 'Workspace refusal: worktree is gone',
          },
        ]}
        onError={onError}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn().mockRejectedValue(new Error('storage failed'))}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'New chat created; old queued turn kept: storage failed',
      ),
    );
  });
});
