/**
 * @vitest-environment jsdom
 *
 * chat-24 (#5446): the transcript marks a model change, a fresh context and
 * an engine switch, each once. The fixture is an event window captured from a
 * running Station with the free scripted model (a model change between two
 * turns of one Session, a "start fresh" context reset, then a handoff to a
 * second Agent), scrubbed of its folder, device and display name. It goes
 * through the same projection the chat dock uses, so the markers here are
 * derived from what the turns recorded, exactly as after a reload.
 */

import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import type { ConversationHandoffProjection } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { render, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const { agents } = vi.hoisted(() => ({
  agents: {
    current: [
      { slug: 'station', name: 'Station Assistant', engineId: 'station' },
      { slug: 'reviewer', name: 'Reviewer', engineId: 'station' },
    ] as unknown[],
  },
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents.current,
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
  StreamingMessage: () => null,
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

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { PreviewProvider } from '../contexts/PreviewContext';
import { conversationMessageToChatMessage } from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage, ChatSession } from '../types';
import captured from './fixtures/transcript-markers-window.json';

interface CapturedWindow {
  currentSessionId: string;
  events: { sequence: number; event: RecordedEvent }[];
  handoffs: ConversationHandoffProjection[];
  contextBoundaries: ConversationContextBoundaryTranscriptMarker[];
}

const WINDOW = captured.window as unknown as CapturedWindow;

/** A captured event as the window carries it, metadata bag included. */
type RecordedEvent = CanonicalRuntimeEvent & {
  metadata?: Record<string, unknown>;
};
type EventEdit = (event: RecordedEvent) => RecordedEvent;

/**
 * The rows the dock renders for a window: the shared projection, then the
 * handoff and context-boundary rows in the shape `useActiveChatTranscript`
 * builds them, merged by time.
 */
function transcript(
  window: CapturedWindow,
  edit: EventEdit = (event) => event,
): ChatMessage[] {
  const rows = projectRuntimeEventsToMessages(
    window.events.map(({ event }) => edit(structuredClone(event))),
    { stableIds: true, markEndedTurns: true },
  ).map(conversationMessageToChatMessage);
  const handoffs: ChatMessage[] = window.handoffs.map((handoff) => ({
    id: `conversation-handoff:${handoff.sessionId}`,
    role: 'system',
    content: '',
    timestamp: Date.parse(handoff.createdAt),
    contentParts: [
      { type: 'conversation-handoff', conversationHandoff: handoff },
    ],
  }));
  const boundaries: ChatMessage[] = window.contextBoundaries.map(
    (boundary) => ({
      id: `conversation-context-boundary:${boundary.boundaryId}`,
      role: 'system',
      content: '',
      timestamp: Date.parse(boundary.consumedAt),
      contentParts: [
        {
          type: 'conversation-context-boundary',
          conversationContextBoundary: boundary,
        },
      ],
    }),
  );
  return [...rows, ...handoffs, ...boundaries]
    .map((message, order) => ({ message, order }))
    .sort(
      (left, right) =>
        (left.message.timestamp ?? Number.MAX_SAFE_INTEGER) -
          (right.message.timestamp ?? Number.MAX_SAFE_INTEGER) ||
        left.order - right.order,
    )
    .map(({ message }) => message);
}

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: 'station:1795410818887',
    conversationId: 'station:1795410818887',
    currentSessionId: WINDOW.currentSessionId,
    agentSlug: 'station',
    agentName: 'Station Assistant',
    title: 'Markers',
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
  } as unknown as ChatSession;
}

function renderTranscript(messages: ChatMessage[]) {
  return render(
    <PreviewProvider>
      <ChatMessageList
        activeSession={session(messages)}
        fontSize={14}
        showReasoning={false}
        showToolDetails={false}
      />
    </PreviewProvider>,
  );
}

function markers(container: HTMLElement, kind: string) {
  return [...container.querySelectorAll(`.transcript-change--${kind}`)];
}

/** Rewrites the provider (and, for ACP, the connection name) on every event. */
function asEngine(provider: string, displayName?: string): EventEdit {
  return (event) => {
    const edited = { ...event, provider } as RecordedEvent;
    if (
      displayName &&
      (event.method === 'turn.started' || event.method === 'turn.completed')
    ) {
      edited.metadata = { ...event.metadata, engineDisplayName: displayName };
    }
    return edited;
  };
}

describe('chat-24 transcript markers', () => {
  test('a captured transcript with all three changes shows each marker once, in reading order', () => {
    const { container } = renderTranscript(transcript(WINDOW));

    const [model, ...extraModel] = markers(container, 'model');
    const [context, ...extraContext] = markers(container, 'context');
    const [engine, ...extraEngine] = markers(container, 'engine');
    expect([extraModel, extraContext, extraEngine]).toEqual([[], [], []]);

    expect(model?.textContent).toBe(
      'Model: Scripted Echo →  to Scripted ShowcaseSame engine, same memory.',
    );
    expect(context?.textContent).toBe(
      'Fresh contextStation forgot everything above. You still see it.',
    );
    expect(
      within(engine as HTMLElement).getByText(
        'Reviewer read up to about 8K tokens of recent messages. Approvals, tool servers and queued messages start fresh. Usage is counted separately.',
      ),
    ).toBeTruthy();
    // The switch is a named region (it carries a disclosure); the other two
    // are plain text, never controls.
    expect(engine?.tagName).toBe('SECTION');
    expect(engine?.getAttribute('aria-label')).toBe(
      'Switched to Reviewer (Station)',
    );
    for (const marker of [model, context])
      expect(marker?.querySelector('button, a, [tabindex], [role]')).toBeNull();

    // Reading order: the model change sits just before the answer that ran
    // on the new model, then the fresh context, then the switch.
    const order = [model, context, engine].map((node) =>
      [...container.querySelectorAll('.transcript-change')].indexOf(
        node as Element,
      ),
    );
    expect(order).toEqual([0, 1, 2]);
    const answerAfterModel = (model as HTMLElement).closest('article');
    expect(answerAfterModel?.getAttribute('data-chat-role')).toBe('assistant');
    expect(answerAfterModel?.textContent).toContain('Scripted showcase');
  });

  test.each([
    ['Claude Code', 'claude', undefined],
    ['Codex', 'codex', undefined],
    ['OpenCode', 'acp', 'OpenCode'],
  ])(
    '%s: the same recorded turns derive the same markers and name the engine',
    (label, provider, displayName) => {
      const { container } = renderTranscript(
        transcript(WINDOW, asEngine(provider, displayName)),
      );
      expect(markers(container, 'model')).toHaveLength(1);
      expect(markers(container, 'context')[0]?.textContent).toBe(
        `Fresh context${label} forgot everything above. You still see it.`,
      );
      expect(markers(container, 'engine')).toHaveLength(1);
    },
  );

  test('a chat whose turns recorded no model shows no model marker rather than a guess', () => {
    const { container } = renderTranscript(
      transcript(WINDOW, (event) => {
        if (event.metadata && 'effectiveModel' in event.metadata) {
          const { effectiveModel: _omitted, ...metadata } = event.metadata;
          return { ...event, metadata };
        }
        return event;
      }),
    );
    expect(markers(container, 'model')).toHaveLength(0);
    expect(markers(container, 'context')).toHaveLength(1);
    expect(markers(container, 'engine')).toHaveLength(1);
  });

  test('a model change at a fresh context shows one row, not two', () => {
    // The first turn after the reset recorded no model; give it a different
    // one than the last turn before the reset.
    const firstAfterReset = WINDOW.events.find(
      ({ event }) =>
        event.method === 'turn.started' &&
        event.threadId === WINDOW.contextBoundaries[0]?.successorSessionId,
    )?.event.turnId;
    expect(firstAfterReset).toBeDefined();
    const { container } = renderTranscript(
      transcript(WINDOW, (event) =>
        event.turnId === firstAfterReset &&
        (event.method === 'turn.started' || event.method === 'turn.completed')
          ? {
              ...event,
              metadata: { ...event.metadata, effectiveModel: 'scripted-long' },
            }
          : event,
      ),
    );
    expect(markers(container, 'model')).toHaveLength(1);
    expect(markers(container, 'context')).toHaveLength(1);
    const rows = [...container.querySelectorAll('.transcript-change')];
    expect(rows.map((row) => row.className)).toEqual([
      'transcript-change transcript-change--model',
      'transcript-change transcript-change--context',
      'transcript-change transcript-change--engine',
    ]);
  });

  test('a different model in a new session with no boundary row is not called a model change', () => {
    // A successor session can start without a fresh-context or switch row
    // (a restart, a tools change). Its memory is not the same, so "same
    // engine, same memory" would be false there.
    const successor = WINDOW.contextBoundaries[0]?.successorSessionId;
    const firstInSuccessor = WINDOW.events.find(
      ({ event }) =>
        event.method === 'turn.started' && event.threadId === successor,
    )?.event.turnId;
    expect(firstInSuccessor).toBeDefined();
    const { container } = renderTranscript(
      transcript({ ...WINDOW, contextBoundaries: [], handoffs: [] }, (event) =>
        event.turnId === firstInSuccessor &&
        (event.method === 'turn.started' || event.method === 'turn.completed')
          ? {
              ...event,
              metadata: { ...event.metadata, effectiveModel: 'scripted-long' },
            }
          : event,
      ),
    );
    expect(markers(container, 'model')).toHaveLength(1);
    expect(markers(container, 'context')).toHaveLength(0);
  });

  test('the handed-over size in the copy is the server seed budget', async () => {
    const { TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET } = await import(
      '../../../src-server/services/orchestration/conversation-transcript-seed'
    );
    expect(TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET).toBe(8_000);
    const { container } = renderTranscript(transcript(WINDOW));
    expect(markers(container, 'engine')[0]?.textContent).toContain(
      `about ${TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET / 1000}K tokens`,
    );
  });
});
