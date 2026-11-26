/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatContentPart } from '../../../contexts/active-chats-state';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import type { InlineBrowserActivity } from '../../browser-activity/InlineBrowserActivity';
import type { BrowserActivityScope } from '../BrowserActivityContext';
import {
  BrowserActivityContext,
  BrowserActivityProvider,
} from '../BrowserActivityContext';
import {
  BrowserTurnActivityProvider,
  LiveBrowserTurnActivities,
} from '../BrowserTurnActivity';
import { MessageContent } from '../message-bubble/MessageContent';
import { StreamingMessageView } from '../StreamingMessage';
import { TranscriptTurnContext } from '../transcript-child-work';

vi.mock('../../browser-activity/InlineBrowserActivity', () => ({
  InlineBrowserActivity: ({
    browserSessionId,
    active,
    status,
    toolCount,
    children,
  }: ComponentProps<typeof InlineBrowserActivity>) => (
    <section
      aria-label={`Browser ${browserSessionId}`}
      data-active={String(active)}
    >
      <span>{status}</span>
      <span>{toolCount} actions</span>
      {children}
    </section>
  ),
}));

const scope = {
  apiBase: '/station',
  requestScope: { apiBase: '/station', authorityKey: 'account-a' },
  projectSlug: 'project',
  threadIds: ['thread'],
  conversationKey: 'conversation',
} satisfies BrowserActivityScope;
const parts: ChatContentPart[] = [
  {
    type: 'tool-invocation',
    toolCallId: 'open',
    toolName: 'mcp__station-browser__browser_open',
    input: {},
    output: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            session: { browserSessionId: 'tab-a' },
          }),
        },
      ],
    },
  },
  {
    type: 'tool-invocation',
    toolCallId: 'click',
    toolName: 'mcp__station-browser__browser_click',
    input: { browserSessionId: 'tab-a' },
    needsApproval: true,
  },
  {
    type: 'tool-invocation',
    toolCallId: 'other',
    toolName: 'mcp__other__browser_click',
    input: { browserSessionId: 'tab-a' },
  },
];
const props = {
  sessionId: 'thread',
  agentIcon: null,
  agentIconStyle: {},
  fontSize: 14,
  streamingText: '',
  hasContent: true,
  contentRevision: 1,
  contentParts: parts,
  renderToolCall: (part: ChatContentPart) => (
    <div key={part.toolCallId}>
      {part.toolCallId}
      {part.needsApproval ? ' approval' : ''}
    </div>
  ),
};

function TestTurn({
  children,
  calls = parts,
  live = true,
}: {
  children: React.ReactNode;
  calls?: ChatContentPart[];
  live?: boolean;
}) {
  return (
    <BrowserTurnActivityProvider
      messages={[
        {
          role: 'assistant',
          content: '',
          sessionId: 'thread',
          turnId: 'turn',
          contentParts: calls,
        },
      ]}
      chatId="thread"
      threadId="thread"
      liveTurnId="turn"
      live={live}
      includeStream={false}
    >
      <TranscriptTurnContext.Provider
        value={{ threadId: 'thread', turnId: 'turn', browserOwner: 'row:0' }}
      >
        {children}
      </TranscriptTurnContext.Provider>
      <LiveBrowserTurnActivities />
    </BrowserTurnActivityProvider>
  );
}

describe('browser activity in the transcript', () => {
  test('groups a real open result with its selected browser action and leaves another server outside', async () => {
    render(
      <BrowserActivityContext.Provider value={scope}>
        <TestTurn>
          <StreamingMessageView {...props} />
        </TestTurn>
      </BrowserActivityContext.Provider>,
    );
    const card = await screen.findByRole('region', { name: 'Browser tab-a' });
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('click approval')).toBeTruthy();
    expect(card.textContent).not.toContain('other');
    expect(screen.getByText('other')).toBeTruthy();
  });
  test('keeps normal tool rows when the preview is unavailable', () => {
    render(
      <TestTurn>
        <StreamingMessageView {...props} />
      </TestTurn>,
    );
    expect(screen.queryByRole('region', { name: 'Browser tab-a' })).toBeNull();
    expect(screen.getByText('click approval')).toBeTruthy();
  });
});

afterEach(cleanup);

test('a settled card retains the pending approval and answers its exact request', async () => {
  const approve = vi.fn(async () => 'answered' as const);
  const pending: ChatContentPart = {
    ...parts[1],
    type: 'tool-invocation',
    state: 'awaiting-approval',
    approvalId: 'approval-a',
    approvalThreadId: 'thread',
    approvalEventId: 'event-a',
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const failed: ChatContentPart = {
    ...parts[1],
    toolCallId: 'failed-click',
    needsApproval: false,
    state: 'output-error',
    errorText: 'The page refused the action.',
  };
  render(
    <QueryClientProvider client={client}>
      <BrowserActivityContext.Provider value={scope}>
        <TestTurn calls={[parts[0]!, failed, pending]} live={false}>
          <MessageContent
            contentParts={[parts[0]!, failed, pending]}
            textContent=""
            chatFontSize={14}
            showReasoning={false}
            showToolDetails
            isStreamingMessage={false}
            onToolApproval={approve}
          />
        </TestTurn>
      </BrowserActivityContext.Provider>
    </QueryClientProvider>,
  );
  const card = await screen.findByRole('region', { name: 'Browser tab-a' });
  expect(card.getAttribute('data-active')).toBe('false');
  expect(within(card).getByText(/1 failed/)).toBeTruthy();
  const failedRow = screen.getByText('Failed').closest('button');
  expect(failedRow).toBeTruthy();
  fireEvent.click(failedRow!);
  expect(screen.getByText('The page refused the action.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await waitFor(() => expect(approve).toHaveBeenCalledWith(pending, 'once'));
  client.clear();
});

test.each([
  ['preview off', { enabled: false }],
  [
    'different authority',
    {
      hostAuthority: {
        ...scope.requestScope,
        authorityKey: 'account-b',
        isCurrent: () => true,
      },
    },
  ],
  ['read only or replay', { readOnly: true }],
  ['remote Station', { routeKind: 'direct' }],
])(
  '%s leaves browser calls on the normal transcript path',
  (_label, overrides) => {
    const authority = { ...scope.requestScope, isCurrent: () => true };
    render(
      <BrowserActivityProvider
        enabled
        apiBase="/station"
        requestScope={authority}
        hostAuthority={authority}
        routeKind="host"
        readOnly={false}
        session={{ id: 'thread', projectSlug: 'project' }}
        {...overrides}
      >
        <TestTurn>
          <StreamingMessageView {...props} />
        </TestTurn>
      </BrowserActivityProvider>,
    );
    expect(screen.queryByRole('region', { name: 'Browser tab-a' })).toBeNull();
    expect(screen.getByText('click approval')).toBeTruthy();
  },
);

test('matching host authority enables the browser card', async () => {
  const authority = { ...scope.requestScope, isCurrent: () => true };
  render(
    <BrowserActivityProvider
      enabled
      apiBase="/station"
      requestScope={authority}
      hostAuthority={authority}
      routeKind="host"
      readOnly={false}
      session={{ id: 'thread', projectSlug: 'project' }}
    >
      <TestTurn>
        <StreamingMessageView {...props} />
      </TestTurn>
    </BrowserActivityProvider>,
  );
  expect(
    await screen.findByRole('region', { name: 'Browser tab-a' }),
  ).toBeTruthy();
});

test('keeps one activity per turn and browser session across assistant messages', async () => {
  const click = { ...parts[1]!, needsApproval: false, output: 'ok' };
  const second = {
    ...click,
    toolCallId: 'second-session',
    input: { browserSessionId: 'tab-b' },
  };
  const unknown = { ...click, toolCallId: 'unknown', input: {} };
  const messages = [
    {
      role: 'assistant' as const,
      content: '',
      sessionId: 'thread',
      turnId: 'turn',
      contentParts: [parts[0]!],
    },
    {
      role: 'assistant' as const,
      content: 'Between calls',
      sessionId: 'thread',
      turnId: 'turn',
      contentParts: [click, parts[2]!, second, unknown],
    },
    {
      role: 'assistant' as const,
      content: '',
      sessionId: 'thread',
      turnId: 'older',
      contentParts: [{ ...click, toolCallId: 'older' }],
    },
  ];
  const view = (live: boolean) => (
    <BrowserActivityContext.Provider value={scope}>
      <BrowserTurnActivityProvider
        messages={messages}
        chatId="thread"
        threadId="thread"
        liveTurnId="turn"
        live={live}
        includeStream={false}
      >
        {messages.map((message, index) => (
          <TranscriptTurnContext.Provider
            key={message.turnId + message.content}
            value={{
              threadId: 'thread',
              turnId: message.turnId,
              browserOwner: `row:${index}`,
            }}
          >
            <StreamingMessageView
              {...props}
              contentParts={message.contentParts}
              streamingText={message.content}
            />
          </TranscriptTurnContext.Provider>
        ))}
        <LiveBrowserTurnActivities />
      </BrowserTurnActivityProvider>
    </BrowserActivityContext.Provider>
  );
  const rendered = render(view(true));
  await waitFor(() =>
    expect(
      screen.getAllByRole('region', { name: 'Browser tab-a' }),
    ).toHaveLength(2),
  );
  expect(
    screen
      .getByRole('region', { name: 'Browser tab-b' })
      .getAttribute('data-active'),
  ).toBe('true');
  expect(
    screen
      .getAllByRole('region', { name: 'Browser tab-a' })
      .map((card) => card.getAttribute('data-active')),
  ).toEqual(['false', 'true']);
  expect(screen.getByText('unknown')).toBeTruthy();
  expect(screen.getByText('other')).toBeTruthy();
  rendered.rerender(view(false));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('region', { name: 'Browser tab-a' })
        .every((card) => card.getAttribute('data-active') === 'false'),
    ).toBe(true),
  );
});

test('deduplicates stream flush overlap and switches the live source with the chat', async () => {
  const meta = { agentSlug: 'agent', agentName: 'Agent', title: 'Chat' };
  activeChatsStore.initChat('flush-a', meta);
  activeChatsStore.initChat('flush-b', meta);
  const callA = { ...parts[1]!, needsApproval: false, output: 'ok' };
  const callB = {
    ...callA,
    toolCallId: 'click-b',
    input: { browserSessionId: 'tab-b' },
  };
  activeChatsStore.updateChat('flush-a', {
    streamingMessage: { role: 'assistant', content: '', contentParts: [callA] },
  });
  activeChatsStore.updateChat('flush-b', {
    streamingMessage: { role: 'assistant', content: '', contentParts: [callB] },
  });
  const view = (chat: 'flush-a' | 'flush-b') => {
    const call = chat === 'flush-a' ? callA : callB;
    const persisted =
      chat === 'flush-a'
        ? [
            {
              role: 'assistant' as const,
              content: '',
              turnId: 'turn',
              contentParts: [callA],
            },
          ]
        : [];
    return (
      <BrowserActivityContext.Provider value={scope}>
        <BrowserTurnActivityProvider
          messages={persisted}
          chatId={chat}
          threadId={chat}
          liveTurnId="turn"
          live
          includeStream
        >
          {persisted.length > 0 && (
            <TranscriptTurnContext.Provider
              value={{ threadId: chat, turnId: 'turn', browserOwner: 'row:0' }}
            >
              <StreamingMessageView {...props} contentParts={[callA]} />
            </TranscriptTurnContext.Provider>
          )}
          <TranscriptTurnContext.Provider
            value={{ threadId: chat, turnId: 'turn', browserOwner: 'stream' }}
          >
            <StreamingMessageView {...props} contentParts={[call]} />
          </TranscriptTurnContext.Provider>
          <LiveBrowserTurnActivities />
        </BrowserTurnActivityProvider>
      </BrowserActivityContext.Provider>
    );
  };
  try {
    const rendered = render(view('flush-a'));
    await waitFor(() =>
      expect(
        screen.getAllByRole('region', { name: 'Browser tab-a' }),
      ).toHaveLength(1),
    );
    expect(screen.getAllByText('click')).toHaveLength(1);
    rendered.rerender(view('flush-b'));
    await waitFor(() =>
      expect(
        screen.getAllByRole('region', { name: 'Browser tab-b' }),
      ).toHaveLength(1),
    );
    expect(screen.queryByRole('region', { name: 'Browser tab-a' })).toBeNull();
    expect(screen.getAllByText('click-b')).toHaveLength(1);
  } finally {
    activeChatsStore.removeChat('flush-a');
    activeChatsStore.removeChat('flush-b');
  }
});

test('retains distinct terminal events sharing a tool call id', async () => {
  const first = {
    ...parts[1]!,
    needsApproval: false,
    sourceEventId: 'event-one',
    output: 'first result',
  };
  const second = {
    ...first,
    sourceEventId: 'event-two',
    output: 'second result',
  };
  render(
    <BrowserActivityContext.Provider value={scope}>
      <TestTurn calls={[first, second]}>
        <StreamingMessageView
          {...props}
          contentParts={[first, second]}
          renderToolCall={(part) => (
            <div key={part.sourceEventId}>{String(part.output)}</div>
          )}
        />
      </TestTurn>
    </BrowserActivityContext.Provider>,
  );
  expect(screen.getByText('first result')).toBeTruthy();
  expect(screen.getByText('second result')).toBeTruthy();
  const card = await screen.findByRole('region', { name: 'Browser tab-a' });
  expect(within(card).getByText('2 actions')).toBeTruthy();
});

test('a terminal result supersedes its open call in the activity count', async () => {
  const open = { ...parts[1]!, needsApproval: false, toolCallId: 'settling' };
  const terminal = {
    ...open,
    sourceEventId: 'terminal-event',
    output: 'result',
  };
  render(
    <BrowserActivityContext.Provider value={scope}>
      <TestTurn calls={[open, terminal]}>
        <StreamingMessageView {...props} contentParts={[open, terminal]} />
      </TestTurn>
    </BrowserActivityContext.Provider>,
  );
  const card = await screen.findByRole('region', { name: 'Browser tab-a' });
  expect(within(card).getByText('1 actions')).toBeTruthy();
  expect(screen.getAllByText('settling')).toHaveLength(1);
});
