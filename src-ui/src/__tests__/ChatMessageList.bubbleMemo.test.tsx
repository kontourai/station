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
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
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
  const { TranscriptTurnContext } = await import(
    '../components/chat/transcript-child-work'
  );
  return {
    MessageBubble: react.memo(function MockMessageBubble(props: {
      msg: { content: string };
      idx: number;
    }) {
      react.useContext(TranscriptTurnContext);
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
  StreamingMessage: memo(
    ({ onContentChange }: { onContentChange: () => void }) => (
      <button type="button" onClick={onContentChange}>
        Flush stream
      </button>
    ),
  ),
  SmoothStreamingMessage: memo(
    ({ onContentChange }: { onContentChange: () => void }) => (
      <button type="button" onClick={onContentChange}>
        Flush stream
      </button>
    ),
  ),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { conversationPartToContentParts } from '../hooks/orchestration/conversationTranscriptParts';

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
  test('replayed real-shape content parts do not re-render unchanged mounted bubbles', () => {
    const events: CanonicalRuntimeEvent[] = Array.from(
      { length: 10 },
      (_, i) => {
        const base = {
          provider: 'codex' as const,
          threadId: 'memo-session',
          turnId: `turn-${i}`,
          createdAt: new Date(i * 1000).toISOString(),
        };
        return [
          {
            ...base,
            eventId: `start-${i}`,
            method: 'turn.started' as const,
            prompt: `question ${i}`,
          },
          {
            ...base,
            eventId: `tool-${i}`,
            method: 'tool.started' as const,
            itemId: `tool-${i}`,
            toolCallId: `call-${i}`,
            toolName: 'Read',
            arguments: { path: `file-${i}` },
          },
          {
            ...base,
            eventId: `result-${i}`,
            method: 'tool.completed' as const,
            itemId: `tool-${i}`,
            toolCallId: `call-${i}`,
            toolName: 'Read',
            status: 'success' as const,
            output: 'Found it',
          },
          {
            ...base,
            eventId: `text-${i}`,
            method: 'content.text-delta' as const,
            itemId: `text-${i}`,
            delta: `answer ${i}`,
          },
          { ...base, eventId: `done-${i}`, method: 'turn.completed' as const },
        ];
      },
    ).flat();
    const messages = () =>
      projectRuntimeEventsToMessages(events, { stableIds: true }).map(
        (message) => ({
          id: message.id,
          role: message.role,
          content: message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join(''),
          contentParts: message.parts.flatMap(conversationPartToContentParts),
          turnId: message.metadata?.turnId,
          sessionId: message.metadata?.sessionId,
          provenance: message.metadata?.provenance,
        }),
      );
    expect(messages().filter((message) => message.provenance)).toHaveLength(10);
    const tree = () =>
      wrap(
        <ChatMessageList
          activeSession={{ ...session(''), messages: messages() }}
          fontSize={14}
          showReasoning={false}
          showToolDetails={false}
        />,
      );
    const view = render(tree());
    expect(bubbleRendered).toHaveBeenCalledTimes(20);
    bubbleRendered.mockClear();
    view.rerender(tree());
    expect(bubbleRendered).not.toHaveBeenCalled();
    const terminal = events[4];
    if (terminal.method !== 'turn.completed')
      throw new Error('Expected a completed turn fixture');
    events[4] = { ...terminal, metadata: { reportedModel: 'updated-model' } };
    view.rerender(tree());
    expect(bubbleRendered.mock.calls.map(([content]) => content)).toEqual([
      'answer 0',
    ]);
  });
  test('a stream flush pins imperatively without rendering the list again and respects the reader', () => {
    const renderOverride = vi.fn(() => null);
    const view = render(
      wrap(
        <ChatMessageList
          activeSession={{
            ...session(''),
            orchestrationSessionStarted: true,
            orchestrationTurnOpen: true,
          }}
          renderOverride={renderOverride}
          fontSize={14}
          showReasoning={false}
          showToolDetails={false}
        />,
      ),
    );
    const scroller = view.getByRole('log');
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
    });
    expect(renderOverride).toHaveBeenCalled();
    renderOverride.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Flush stream' }));
    expect(scroller.scrollTop).toBe(2000);
    expect(renderOverride).not.toHaveBeenCalled();
    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 500;
    fireEvent.scroll(scroller);
    fireEvent.click(view.getByRole('button', { name: 'Flush stream' }));
    expect(scroller.scrollTop).toBe(500);
  });

  test('a user row keeps its preceding fork source across unrelated session renders', () => {
    const messages = [
      {
        id: 'a',
        role: 'assistant' as const,
        content: 'answer',
        turnId: 't1',
        sessionId: 'execution',
        answerEligible: true,
        agentSlug: 'dev-agent',
        contentParts: conversationPartToContentParts({
          type: 'text',
          text: 'answer',
        }),
      },
      {
        id: 'u',
        role: 'user' as const,
        content: 'next question',
        contentParts: conversationPartToContentParts({
          type: 'text',
          text: 'next question',
        }),
      },
    ];
    const tree = (plan: string) =>
      wrap(
        <ChatMessageList
          activeSession={{ ...session(plan), messages }}
          fontSize={14}
          showReasoning={false}
          showToolDetails={false}
        />,
      );
    const view = render(tree('one'));
    expect(bubbleRendered).toHaveBeenCalledTimes(2);
    bubbleRendered.mockClear();
    view.rerender(tree('two'));
    expect(bubbleRendered).not.toHaveBeenCalled();
  });
});
