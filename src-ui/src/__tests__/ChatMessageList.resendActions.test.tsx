/**
 * @vitest-environment jsdom
 *
 * #4406: Regenerate (an answer's ⋯) and Edit and resend (the person's
 * message ⋯), through the real transcript: `ChatMessageList` derives which
 * message each row would send again and where the fork keeps history up to,
 * `MessageBubble` gates the rows, and the menus hand the request to the host.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => vi.fn(),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));
const { mobile } = vi.hoisted(() => ({ mobile: { current: false } }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current }));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import {
  type MessageResendRequest,
  messageResendSource,
  regenerateSource,
} from '../components/chat/fork-turn-source';
import { PreviewProvider } from '../contexts/PreviewContext';
import type { ChatMessage, ChatSession } from '../types';

const AGENT = agentId('claude');
/** The menus are lazy chunks; a cold transform can take a while. */
const LAZY = { timeout: 15_000 };

function answer(
  turnId: string,
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role: 'assistant',
    content,
    turnId,
    answerEligible: true,
    agentSlug: AGENT,
    sessionId: 'session-1',
    timestamp: 1,
    ...overrides,
  };
}

function userPrompt(
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return { role: 'user', content, timestamp: 1, ...overrides };
}

const IMAGE_PART = {
  type: 'file',
  name: 'chart.png',
  mediaType: 'image/png',
  blobRef: 'blob-chart',
};

/** Two settled exchanges; the second message carries an image. */
const TRANSCRIPT: ChatMessage[] = [
  userPrompt('First question'),
  answer('turn-1', 'First answer'),
  userPrompt('Second question', {
    contentParts: [{ type: 'text', content: 'Second question' }, IMAGE_PART],
  }),
  answer('turn-2', 'Second answer'),
];

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: 'session-1',
    conversationId: 'conversation-1',
    currentSessionId: 'session-1',
    agentSlug: AGENT,
    agentName: 'Claude',
    title: 'Resend',
    source: 'manual',
    messages,
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    error: null,
    createdAt: 1,
    updatedAt: 1,
    hasUnread: false,
  };
}

function renderList(
  messages: ChatMessage[],
  onResendFromMessage?: (request: MessageResendRequest) => void,
) {
  // The image part renders its preview, which reads the preview context.
  return render(
    <PreviewProvider>
      <ChatMessageList
        activeSession={session(messages)}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onForkFromTurn={vi.fn()}
        onNewChatFromMessage={vi.fn()}
        onResendFromMessage={onResendFromMessage}
      />
    </PreviewProvider>,
  );
}

const FORK_AT_TURN_1 = {
  turnId: 'turn-1',
  agentSlug: AGENT,
  sessionId: 'session-1',
  provider: undefined,
  model: undefined,
};

describe('Regenerate and Edit and resend (#4406)', () => {
  // The menus are lazy chunks: load them once, outside any one test's budget.
  beforeAll(async () => {
    await import('../components/chat/TurnActionsMenu');
    await import('../components/chat/AttachAnswerToTaskButton');
  }, 120_000);

  test('Regenerate on an answer re-sends the message that produced it, forking before that message', async () => {
    const onResend = vi.fn();
    renderList(TRANSCRIPT, onResend);
    const triggers = await screen.findAllByRole(
      'button',
      {
        name: 'More answer actions',
      },
      LAZY,
    );
    fireEvent.click(triggers[1]);
    const menu = screen.getByRole('menu', { name: 'Answer actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Regenerate' }));
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onResend).toHaveBeenCalledWith({
      mode: 'regenerate',
      text: 'Second question',
      parts: [{ type: 'text', content: 'Second question' }, IMAGE_PART],
      fork: FORK_AT_TURN_1,
    });
  });

  test('Edit and resend on a message forks before it and hands over its words; the original stays', async () => {
    const onResend = vi.fn();
    renderList(TRANSCRIPT, onResend);
    const triggers = await screen.findAllByRole(
      'button',
      {
        name: 'More message actions',
      },
      LAZY,
    );
    fireEvent.click(triggers[1]);
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    // Fork from here stays beside it: one keeps the message, one rewrites it.
    expect(
      within(menu).getByRole('menuitem', { name: 'Fork from here…' }),
    ).toBeTruthy();
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Edit and resend' }),
    );
    expect(onResend).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit',
        text: 'Second question',
        fork: FORK_AT_TURN_1,
      }),
    );
  });

  test('the message that opened the chat resends without a fork point, in place of New chat from this message', async () => {
    const onResend = vi.fn();
    renderList(TRANSCRIPT, onResend);
    const [firstMessage] = await screen.findAllByRole(
      'button',
      {
        name: 'More message actions',
      },
      LAZY,
    );
    fireEvent.click(firstMessage);
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    expect(
      within(menu).queryByRole('menuitem', {
        name: 'New chat from this message',
      }),
    ).toBeNull();
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Edit and resend' }),
    );
    expect(onResend).toHaveBeenCalledWith({
      mode: 'edit',
      text: 'First question',
      parts: [],
      fork: null,
    });

    const [firstAnswer] = await screen.findAllByRole(
      'button',
      { name: 'More answer actions' },
      LAZY,
    );
    fireEvent.click(firstAnswer);
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Answer actions' })).getByRole(
        'menuitem',
        { name: 'Regenerate' },
      ),
    );
    expect(onResend).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'regenerate', fork: null }),
    );
  });

  test('history no fork can keep offers neither action, so nothing is re-sent without it', async () => {
    const onResend = vi.fn();
    renderList(
      [
        userPrompt('Fix the login'),
        answer('turn-failed', 'OAuth session expired', {
          answerEligible: false,
        }),
        userPrompt('Try again'),
        answer('turn-2', 'Done'),
      ],
      onResend,
    );
    const userTriggers = await screen.findAllByRole(
      'button',
      {
        name: 'More message actions',
      },
      LAZY,
    );
    fireEvent.click(userTriggers[1]);
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    expect(
      within(menu).queryByRole('menuitem', { name: 'Edit and resend' }),
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitem', {
        name: 'New chat from this message',
      }),
    ).toBeTruthy();
    fireEvent.keyDown(menu, { key: 'Escape' });

    const answerTriggers = await screen.findAllByRole(
      'button',
      { name: 'More answer actions' },
      LAZY,
    );
    fireEvent.click(answerTriggers[answerTriggers.length - 1]);
    expect(
      within(screen.getByRole('menu', { name: 'Answer actions' })).queryByRole(
        'menuitem',
        { name: 'Regenerate' },
      ),
    ).toBeNull();
  });

  test('a host that cannot fork (no handler) shows neither action', async () => {
    renderList(TRANSCRIPT);
    const triggers = await screen.findAllByRole(
      'button',
      {
        name: 'More answer actions',
      },
      LAZY,
    );
    fireEvent.click(triggers[1]);
    expect(
      within(screen.getByRole('menu', { name: 'Answer actions' })).queryByRole(
        'menuitem',
        { name: 'Regenerate' },
      ),
    ).toBeNull();
  });

  test('on a phone, Edit and resend is a row of the message sheet and Regenerate is a row of the answer sheet', async () => {
    mobile.current = true;
    try {
      const onResend = vi.fn();
      renderList(TRANSCRIPT, onResend);
      const userSheets = screen.getAllByRole('button', {
        name: 'Your message actions',
      });
      fireEvent.click(userSheets[1]);
      const sheet = screen.getByRole('dialog', {
        name: 'Your message actions',
      });
      fireEvent.click(
        await within(sheet).findByRole('button', { name: 'Edit and resend' }),
      );
      expect(onResend).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'edit', text: 'Second question' }),
      );
      // The fork's draft replaces the chat: the sheet does not stay over it.
      expect(
        screen.queryByRole('dialog', { name: 'Your message actions' }),
      ).toBeNull();

      const answerSheets = screen.getAllByRole('button', {
        name: 'Answer details and actions',
      });
      fireEvent.click(answerSheets[1]);
      const answerSheet = screen.getByRole('dialog', {
        name: 'Answer details and actions',
      });
      // One sheet holds every answer action (#4404): no second menu.
      fireEvent.click(
        await within(answerSheet).findByRole('button', { name: 'Regenerate' }),
      );
      expect(onResend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'regenerate',
          text: 'Second question',
        }),
      );
      expect(
        screen.queryByRole('dialog', { name: 'Answer details and actions' }),
      ).toBeNull();
    } finally {
      mobile.current = false;
    }
  });
});

describe('which message an action sends again (#4406)', () => {
  test('a steer inside a running turn is not re-sent on its own', () => {
    const messages = [
      userPrompt('Start', { turnId: 'turn-1' }),
      answer('turn-1', 'Working'),
      userPrompt('Also check tests', { turnId: 'turn-1' }),
      answer('turn-1', 'Checked'),
    ];
    expect(messageResendSource(messages, 2)).toBeNull();
    expect(regenerateSource(messages, 3)).toBeNull();
    // The turn's first answer row still regenerates from its opening message.
    expect(regenerateSource(messages, 1)).toMatchObject({ text: 'Start' });
  });

  test('another agent’s message and Station’s own sends are not the person’s to re-send', () => {
    expect(
      messageResendSource([userPrompt('Ping', { stationCheckBack: true })], 0),
    ).toBeNull();
    expect(
      messageResendSource(
        [userPrompt('[SYSTEM_EVENT] Task finished', { turnId: 'turn-1' })],
        0,
      ),
    ).toBeNull();
  });

  test('an answer no message of the person’s asked for has nothing to regenerate', () => {
    const messages = [
      userPrompt('Question'),
      answer('turn-1', 'Answer'),
      answer('turn-2', 'Scheduled follow-up'),
    ];
    expect(regenerateSource(messages, 2)).toBeNull();
    expect(regenerateSource(messages, 1)).toMatchObject({
      text: 'Question',
      fork: null,
    });
  });
});
