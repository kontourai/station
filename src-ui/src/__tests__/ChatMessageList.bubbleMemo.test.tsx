/**
 * @vitest-environment jsdom
 *
 * `useDerivedSessions` mints a new `ChatSession` object per streamed token by
 * design — the plan panel reads the artifact off the derived session, so the
 * artifact has to advance — and its own doc comment records the consequence:
 * "ChatDock, ChatMessageList and every MessageBubble still re-render per
 * token." The transcript array survives that (the plan-only reuse branch
 * passes it back by reference), so the only thing defeating each row's `memo`
 * was the session object itself, handed down whole.
 *
 * This mounts the REAL `ChatMessageList` and re-renders it with a new session
 * object whose eight row-relevant fields are unchanged, counting how many
 * times a memoised row is asked to render. The row stand-in is `memo`'d with
 * React's default shallow comparison — the same comparison the real
 * `MessageBubble` uses — because what is under test is the props this list
 * constructs, not what the bubble draws.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { memo, type ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const bubbleRendered = vi.hoisted(() => vi.fn());
const stableToolApproval = vi.hoisted(() => vi.fn());
const stableSendMessage = vi.hoisted(() => vi.fn());
const stableShowToast = vi.hoisted(() => vi.fn());
const stableAgents = vi.hoisted(() => [
  { slug: 'dev-agent', name: 'Dev Agent' },
]);

vi.mock('../components/chat/MessageBubble', async () => {
  const react = await import('react');
  return {
    MessageBubble: react.memo(function MockMessageBubble(props: {
      msg: { content: string };
      idx: number;
    }) {
      bubbleRendered(props.msg.content);
      return <div data-testid={`bubble-${props.idx}`}>{props.msg.content}</div>;
    }),
  };
});

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => stableAgents,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: stableShowToast }),
}));
vi.mock('../hooks/useToolApproval', () => ({
  useToolApproval: () => stableToolApproval,
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => stableSendMessage,
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: memo(() => <div data-testid="streaming-message" />),
  SmoothStreamingMessage: memo(() => <div data-testid="streaming-message" />),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function wrap(ui: ReactElement) {
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

/**
 * One transcript array, shared by both renders. Production preserves this
 * reference across a plan-only re-derivation, which is exactly the case where
 * the row props are otherwise unchanged — building a second array here would
 * change `msg` identity and hide whatever the session prop does.
 */
const MESSAGES = [
  {
    role: 'user' as const,
    content: 'first question',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    role: 'assistant' as const,
    content: 'settled answer',
    timestamp: '2026-01-01T00:00:01.000Z',
  },
];

function session(planRawText: string) {
  return {
    id: 'memo-session',
    agentSlug: agentId('dev-agent'),
    agentName: 'Dev Agent',
    title: 'Memo chat',
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    hasUnread: false,
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    source: 'manual',
    messages: MESSAGES,
    // The two fields that move per streamed token and that no row reads.
    planArtifact: {
      source: 'assistant',
      rawText: planRawText,
      steps: [],
      updatedAt: planRawText,
    },
    // biome-ignore lint/suspicious/noExplicitAny: the list's own prop type is
    // the full ChatSession; this fixture carries only what it reads.
  } as any;
}

function listFor(planRawText: string) {
  return (
    <ChatMessageList
      activeSession={session(planRawText)}
      fontSize={14}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

describe('ChatMessageList row memoisation', () => {
  beforeEach(() => {
    bubbleRendered.mockClear();
  });

  test('a new session object with unchanged row fields does not re-render settled rows', () => {
    const view = render(wrap(listFor('plan v1')));

    const initialRenders = bubbleRendered.mock.calls.length;
    // Without this the assertion below would also hold for a list that
    // rendered no rows at all.
    expect(initialRenders).toBeGreaterThanOrEqual(MESSAGES.length);
    expect(view.getByTestId('bubble-1').textContent).toBe('settled answer');

    bubbleRendered.mockClear();
    view.rerender(wrap(listFor('plan v2')));

    expect(bubbleRendered).not.toHaveBeenCalled();
  });
});
