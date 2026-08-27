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

  it('projects a durable invocation claim as possible-effect evidence after reload', () => {
    render(
      <OutboundQueuedMessages
        sessionId="session-1"
        turns={[
          {
            clientTurnId: 'turn-1',
            content: 'already sending',
            status: 'invoking',
          },
        ]}
        onError={vi.fn()}
        onRetry={vi.fn()}
        onStartNewChat={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'May have started; inspect this session before sending again',
      ),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
  });

  it('separates waiting, accepted, and delivery-uncertain counts', () => {
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

    expect(
      screen.getByText(
        '1 message waiting to send · 1 accepted and waiting for completion · 1 delivery-uncertain; inspect this session',
      ),
    ).not.toBeNull();
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

    expect(
      screen.getByText(
        'May have started; inspect this session before sending again',
      ),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
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
