/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { precedingForkSource } from '../components/chat/fork-turn-source';
import { MessageBubble } from '../components/chat/MessageBubble';
import type { ChatMessage } from '../types';

vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <span>Agent</span>,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span>User</span>,
}));

const session = {
  id: 'session-1',
  conversationId: 'conversation-1',
  agentSlug: 'claude',
  agentName: 'Claude',
  messages: [],
  messageCount: 2,
};

describe('MessageBubble user-turn recovery (#2216)', () => {
  test('a failed conversation offers New chat from this message, not Copy-only', async () => {
    const onNewChatFromMessage = vi.fn();
    const userMessage = { role: 'user' as const, content: 'Fix the login' };
    const failedAssistant = {
      role: 'assistant' as const,
      content: 'OAuth session expired',
      turnId: 'turn-failed',
      answerEligible: false,
      agentSlug: 'claude',
    };
    render(
      <MessageBubble
        msg={userMessage}
        idx={0}
        activeSession={{ ...session, messageCount: 2 } as never}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        userForkSource={precedingForkSource(
          [userMessage, failedAssistant] as ChatMessage[],
          0,
        )}
        onNewChatFromMessage={onNewChatFromMessage}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'More message actions' }),
    );
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).toBeTruthy();
    expect(
      screen.queryByRole('menuitem', { name: /Fork from here/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'New chat from this message' }),
    );
    expect(onNewChatFromMessage).toHaveBeenCalledWith('Fix the login');
  });

  test('a user turn after a completed answer offers Fork from here', async () => {
    const onForkFromTurn = vi.fn();
    const userMessage = { role: 'user' as const, content: 'Continue' };
    const completed = {
      role: 'assistant' as const,
      content: 'Done',
      turnId: 'turn-ok',
      answerEligible: true,
      agentSlug: 'claude',
      sessionId: 'session-1',
    };
    const laterUser = { role: 'user' as const, content: 'Retry this' };
    render(
      <MessageBubble
        msg={laterUser}
        idx={2}
        activeSession={{ ...session, messageCount: 3 } as never}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        onForkFromTurn={onForkFromTurn}
        userForkSource={precedingForkSource(
          [userMessage, completed, laterUser] as ChatMessage[],
          2,
        )}
        onNewChatFromMessage={vi.fn()}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'More message actions' }),
    );
    expect(
      screen.queryByRole('menuitem', { name: 'New chat from this message' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Fork from here/ }));
    expect(onForkFromTurn).toHaveBeenCalledWith({
      turnId: 'turn-ok',
      agentSlug: 'claude',
      sessionId: 'session-1',
      provider: undefined,
      model: undefined,
    });
  });
});
