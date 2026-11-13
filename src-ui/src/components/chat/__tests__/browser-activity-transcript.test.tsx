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
import type { InlineBrowserActivity } from '../../browser-activity/InlineBrowserActivity';
import type { BrowserActivityScope } from '../BrowserActivityContext';
import {
  BrowserActivityContext,
  BrowserActivityProvider,
} from '../BrowserActivityContext';
import { MessageContent } from '../message-bubble/MessageContent';
import { StreamingMessageView } from '../StreamingMessage';

vi.mock('../../browser-activity/InlineBrowserActivity', () => ({
  InlineBrowserActivity: ({
    browserSessionId,
    active,
    status,
    children,
  }: ComponentProps<typeof InlineBrowserActivity>) => (
    <section
      aria-label={`Browser ${browserSessionId}`}
      data-active={String(active)}
    >
      <span>{status}</span>
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

describe('browser activity in the transcript', () => {
  test('groups a real open result with its selected browser action and leaves another server outside', async () => {
    render(
      <BrowserActivityContext.Provider value={scope}>
        <StreamingMessageView {...props} />
      </BrowserActivityContext.Provider>,
    );
    const card = await screen.findByRole('region', { name: 'Browser tab-a' });
    expect(card.textContent).toContain('open');
    expect(card.textContent).toContain('click approval');
    expect(card.textContent).not.toContain('other');
    expect(screen.getByText('other')).toBeTruthy();
  });
  test('keeps normal tool rows when the preview is unavailable', () => {
    render(<StreamingMessageView {...props} />);
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
        <MessageContent
          contentParts={[parts[0]!, failed, pending]}
          textContent=""
          chatFontSize={14}
          showReasoning={false}
          showToolDetails={false}
          isStreamingMessage={false}
          onToolApproval={approve}
        />
      </BrowserActivityContext.Provider>
    </QueryClientProvider>,
  );
  const card = await screen.findByRole('region', { name: 'Browser tab-a' });
  expect(card.getAttribute('data-active')).toBe('false');
  expect(within(card).getByText(/1 failed/)).toBeTruthy();
  expect(within(card).getByText('Browser actions')).toBeTruthy();
  fireEvent.click(within(card).getByRole('button', { name: 'Allow Once' }));
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
        <StreamingMessageView {...props} />
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
      <StreamingMessageView {...props} />
    </BrowserActivityProvider>,
  );
  expect(
    await screen.findByRole('region', { name: 'Browser tab-a' }),
  ).toBeTruthy();
});
