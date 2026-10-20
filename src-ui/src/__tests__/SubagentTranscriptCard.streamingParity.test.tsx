import capturedCodexEvents from './fixtures/codex-subagent-transcript-events.json';
/**
 * @vitest-environment jsdom
 *
 * The live streaming row and the settled row draw the same subagent card for
 * the same tool call: a turn must not gain or lose its subagent when it
 * settles. Both rows read the transcript's fold of `child-work.updated`
 * events (`foldTranscriptChildren`), in the shape the Claude adapter
 * publishes.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const useStreamingContent = vi.fn();
vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: (sessionId: string) => useStreamingContent(sessionId),
}));

import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import { StreamingMessage } from '../components/chat/StreamingMessage';
import {
  foldTranscriptChildren,
  TranscriptChildrenContext,
  TranscriptTurnContext,
} from '../components/chat/transcript-child-work';

const THREAD = 'claude-session-1';
const TOOL_CALL = 'toolu_agent_1';

const child: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: THREAD,
  childId: 'a1b2c3',
  status: 'running',
  parent: { toolCallId: TOOL_CALL, turnId: 'turn-1' },
  title: 'Survey the decision records',
  kindLabel: 'Explore',
  model: { id: 'claude-haiku-5', source: 'subagent-reply' },
  backgrounded: false,
  startedAt: '2026-10-14T14:25:00.000Z',
  controls: { stop: 'provider-task-stop' },
};

function events(): { sequence: number; event: CanonicalRuntimeEvent }[] {
  return [
    {
      sequence: -1,
      event: {
        eventId: 'turn-start',
        provider: 'claude',
        threadId: THREAD,
        createdAt: child.startedAt!,
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'Survey records',
      },
    },
    {
      sequence: 0,
      event: {
        eventId: 'tool-start',
        itemId: TOOL_CALL,
        provider: 'claude',
        threadId: THREAD,
        createdAt: child.startedAt!,
        method: 'tool.started',
        turnId: 'turn-1',
        toolCallId: TOOL_CALL,
        toolName: 'Agent',
        arguments: {},
      },
    },
    {
      sequence: 1,
      event: {
        eventId: 'evt-1',
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-10-14T14:25:00.000Z',
        method: 'child-work.updated',
        delta: {
          kind: 'snapshot',
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          running: [child],
        },
      },
    },
    {
      sequence: 2,
      event: {
        eventId: 'evt-2',
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-10-14T14:25:30.000Z',
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          childId: 'a1b2c3',
          status: 'failed',
          result: {
            summary: 'Could not read docs/decisions: permission denied',
          },
          identity: {
            parent: child.parent,
            title: child.title,
            kindLabel: child.kindLabel,
            model: child.model,
            startedAt: child.startedAt,
            endedAt: '2026-10-14T14:25:30.000Z',
          },
        },
      },
    },
  ];
}

const toolPart = {
  type: 'tool-invocation',
  toolCallId: TOOL_CALL,
  toolName: 'Agent',
  state: 'result',
  args: { description: child.title, subagent_type: 'Explore' },
  result: 'Agent failed.',
};

afterEach(() => {
  cleanup();
  useStreamingContent.mockReset();
});

describe('subagent card streaming parity', () => {
  test('Codex streaming text keeps a spawned card between pre-spawn and post-spawn prose before the turn settles', () => {
    const captured = capturedCodexEvents[0];
    const spawnAt = captured.findIndex(
      (event) => event.method === 'child-work.updated',
    );
    const children = foldTranscriptChildren(
      captured
        .slice(0, spawnAt + 1)
        .map((event) => ({ event: event as CanonicalRuntimeEvent })),
    );
    const before = captured
      .slice(0, spawnAt)
      .filter((event) => event.method === 'content.text-delta')
      .map((event) => ('delta' in event ? event.delta : ''))
      .join('');
    useStreamingContent.mockReturnValue({
      streamingText: `${before}After spawning the child.`,
      hasContent: true,
      contentRevision: 1,
      contentParts: [],
    });
    render(
      <TranscriptChildrenContext.Provider value={children}>
        <TranscriptTurnContext.Provider
          value={{
            threadId: 'thread-codex',
            turnId: '00000000-0000-7000-8000-000000000002',
          }}
        >
          <StreamingMessage
            sessionId="chat-tab"
            agentIcon={<span>AI</span>}
            agentIconStyle={{}}
            fontSize={14}
          />
        </TranscriptTurnContext.Provider>
      </TranscriptChildrenContext.Provider>,
    );
    const card = screen.getByTestId('subagent-card');
    expect(within(card).getByText('Running')).toBeTruthy();
    const text = document.body.textContent ?? '';
    const cardAt = text.indexOf(card.textContent ?? '');
    expect(cardAt).toBeGreaterThan(text.indexOf(before));
    expect(text.indexOf('After spawning the child.')).toBeGreaterThan(cardAt);
  });

  test('a live whole-turn row keeps the Codex spawn before and after a same-turn steer', () => {
    const captured = capturedCodexEvents[0];
    const spawnAt = captured.findIndex(
      (event) => event.method === 'child-work.updated',
    );
    const turnId = '00000000-0000-7000-8000-000000000002';
    const envelope = {
      provider: 'codex' as const,
      threadId: 'thread-codex',
      createdAt: captured[0].createdAt,
      turnId,
    };
    const start: CanonicalRuntimeEvent = {
      ...envelope,
      eventId: 'start',
      method: 'turn.started',
      prompt: 'Start',
    };
    const steer: CanonicalRuntimeEvent = {
      ...envelope,
      eventId: 'steer',
      method: 'turn.started',
      inputKind: 'steer',
      prompt: 'Change direction',
    };
    const before = captured
      .slice(0, spawnAt)
      .filter((event) => event.method === 'content.text-delta')
      .map((event) => ('delta' in event ? event.delta : ''))
      .join('');
    useStreamingContent.mockReturnValue({
      streamingText: `${before}Still working.`,
      hasContent: true,
      contentRevision: 1,
      contentParts: [],
    });
    const tree = (steered: boolean) => (
      <TranscriptChildrenContext.Provider
        value={foldTranscriptChildren(
          [
            start,
            ...(captured.slice(0, spawnAt + 1) as CanonicalRuntimeEvent[]),
            ...(steered ? [steer] : []),
          ].map((event) => ({ event })),
        )}
      >
        <TranscriptTurnContext.Provider
          value={{ threadId: 'thread-codex', turnId, wholeTurn: true }}
        >
          <StreamingMessage
            sessionId="chat-tab"
            agentIcon={<span>AI</span>}
            agentIconStyle={{}}
            fontSize={14}
          />
        </TranscriptTurnContext.Provider>
      </TranscriptChildrenContext.Provider>
    );
    const view = render(tree(false));
    for (const steered of [false, true]) {
      view.rerender(tree(steered));
      const card = screen.getByTestId('subagent-card');
      expect(screen.getAllByTestId('subagent-card')).toHaveLength(1);
      const text = document.body.textContent ?? '';
      expect(text.indexOf(card.textContent ?? '')).toBeGreaterThan(
        text.indexOf(before),
      );
      expect(text.indexOf('Still working.')).toBeGreaterThan(
        text.indexOf(card.textContent ?? ''),
      );
    }
  });

  test('the streaming row and the settled row draw the same card for one spawning call', () => {
    const children = foldTranscriptChildren(events());
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentRevision: 1,
      contentParts: [toolPart],
    });
    render(
      <TranscriptChildrenContext.Provider value={children}>
        <div data-testid="streaming">
          <StreamingMessage
            sessionId="chat-tab"
            agentIcon={<span>AI</span>}
            agentIconStyle={{}}
            fontSize={14}
            renderToolCall={(_part, index) => <div key={index}>Used Agent</div>}
          />
        </div>
        <div data-testid="settled">
          <MessageContent
            contentParts={[toolPart as never]}
            textContent=""
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            isStreamingMessage={false}
          />
        </div>
      </TranscriptChildrenContext.Provider>,
    );
    const live = within(screen.getByTestId('streaming')).getByTestId(
      'subagent-card',
    );
    const settled = within(screen.getByTestId('settled')).getByTestId(
      'subagent-card',
    );
    for (const card of [live, settled]) {
      expect(
        within(card).getByText('Survey the decision records'),
      ).toBeTruthy();
      expect(within(card).getByText('Failed')).toBeTruthy();
      expect(within(card).queryByText('claude-haiku-5')).toBeNull();
      expect(within(card).getByText('0:30')).toBeTruthy();
      expect(
        within(card).getByText(
          'Could not read docs/decisions: permission denied',
        ),
      ).toBeTruthy();
    }
    for (const card of [live, settled]) {
      fireEvent.click(within(card).getByRole('button', { expanded: false }));
      expect(within(card).getByText('claude-haiku-5')).toBeTruthy();
    }
    expect(live.textContent).toBe(settled.textContent);
  });

  test('a call no child names draws no card on either row', () => {
    const children = foldTranscriptChildren(events());
    const other = { ...toolPart, toolCallId: 'toolu_other' };
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentRevision: 1,
      contentParts: [other],
    });
    render(
      <TranscriptChildrenContext.Provider value={children}>
        <StreamingMessage
          sessionId="chat-tab"
          agentIcon={<span>AI</span>}
          agentIconStyle={{}}
          fontSize={14}
          renderToolCall={(_part, index) => <div key={index}>Used Agent</div>}
        />
        <MessageContent
          contentParts={[other as never]}
          textContent=""
          chatFontSize={14}
          showReasoning={false}
          showToolDetails={false}
          isStreamingMessage={false}
        />
      </TranscriptChildrenContext.Provider>,
    );
    expect(screen.queryByTestId('subagent-card')).toBeNull();
  });
});
