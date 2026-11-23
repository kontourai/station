/**
 * @vitest-environment jsdom
 *
 * chat-24 (#5446): the transcript marks a model change, a fresh context and
 * an engine switch, each once, and only when the recorded data says it
 * happened. The fixture holds three event windows captured from a running
 * Station with the free scripted model (see its `_note`), scrubbed of folder,
 * device, display name and time zone. Each goes through the same projection
 * the chat dock uses, so the markers are derived exactly as after a reload.
 * The per-engine cases rewrite the captured turns into the shape each
 * adapter writes (cited at each case).
 */

import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import type { ConversationHandoffProjection } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const { agents, mobile } = vi.hoisted(() => ({
  agents: {
    current: [
      { slug: 'station', name: 'Station Assistant', engineId: 'station' },
      { slug: 'reviewer', name: 'Reviewer', engineId: 'station' },
    ] as unknown[],
  },
  mobile: { current: false },
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
  StreamingMessage: () => <div data-testid="streaming-row">Streaming</div>,
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
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => mobile.current }));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import { PreviewProvider } from '../contexts/PreviewContext';
import { conversationMessageToChatMessage } from '../hooks/orchestration/conversationTranscriptParts';
import type { ChatMessage, ChatSession } from '../types';
import captured from './fixtures/transcript-markers-window.json';

/** A captured event as the window carries it, metadata bag included. */
type RecordedEvent = CanonicalRuntimeEvent & {
  metadata?: Record<string, unknown>;
};
type EventEdit = (event: RecordedEvent) => RecordedEvent | RecordedEvent[];

interface CapturedWindow {
  currentSessionId: string;
  events: { sequence: number; event: RecordedEvent }[];
  handoffs: ConversationHandoffProjection[];
  contextBoundaries: ConversationContextBoundaryTranscriptMarker[];
}

const COMPLETED = captured.completed as unknown as CapturedWindow;
const REFUSED = captured.refused as unknown as CapturedWindow;
const RESET_THEN_SWITCH = captured.resetThenSwitch as unknown as CapturedWindow;

const turnStarts = (window: CapturedWindow) =>
  window.events
    .map(({ event }) => event)
    .filter((event) => event.method === 'turn.started');
const rootSession = (window: CapturedWindow) =>
  turnStarts(window)[0]?.threadId as string;

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
    window.events.flatMap(({ event }) => edit(structuredClone(event))),
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

function session(
  window: CapturedWindow,
  messages: ChatMessage[],
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id: rootSession(window),
    conversationId: rootSession(window),
    currentSessionId: window.currentSessionId,
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
    ...overrides,
  } as unknown as ChatSession;
}

function renderTranscript(
  window: CapturedWindow,
  messages: ChatMessage[],
  overrides: Partial<ChatSession> = {},
) {
  return render(
    <PreviewProvider>
      <ChatMessageList
        activeSession={session(window, messages, overrides)}
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

const kinds = (container: HTMLElement) =>
  [...container.querySelectorAll('.transcript-change')].map((node) =>
    node.className.replace('transcript-change transcript-change--', ''),
  );

/** Only the first Session's events, with no switch or reset rows. */
function rootOnly(window: CapturedWindow): CapturedWindow {
  const root = rootSession(window);
  return {
    ...window,
    currentSessionId: root,
    handoffs: [],
    contextBoundaries: [],
    events: window.events.filter(({ event }) => event.threadId === root),
  };
}

const isTurnEvent = (event: RecordedEvent) =>
  event.method === 'turn.started' || event.method === 'turn.completed';

/** The model each captured turn asked for, by turn id. */
function requestedByTurn(window: CapturedWindow): Map<string, string> {
  return new Map(
    turnStarts(window).map((event) => [
      event.turnId as string,
      (event as RecordedEvent).metadata?.effectiveModel as string,
    ]),
  );
}

describe('chat-24 transcript markers', () => {
  test('a captured chat with all three changes shows each marker once, in reading order, each its own item', () => {
    const { container } = renderTranscript(COMPLETED, transcript(COMPLETED));
    // Captured order: model change, switch, then a fresh context.
    expect(kinds(container)).toEqual(['model', 'engine', 'context']);
    const [model] = markers(container, 'model');
    const [engine] = markers(container, 'engine');
    const [context] = markers(container, 'context');

    expect(model?.textContent).toBe(
      'Model: Scripted Echo →  to Scripted ShowcaseSame engine, same memory.',
    );
    expect(engine?.querySelector('.transcript-change__pill')?.textContent).toBe(
      '→Switched to Reviewer · Station',
    );
    expect(engine?.querySelector('.transcript-change__note')?.textContent).toBe(
      'Reviewer read up to about 8K tokens of recent messages. Approvals, tool servers and queued messages start fresh.',
    );
    expect(context?.textContent).toBe(
      'Fresh contextStation’s engine forgot everything above. You still see it.',
    );

    // Each marker is read once, in place: no label repeating it, never inside
    // a message. The model pill is not part of the answer's item; a switch or
    // fresh context is its own row.
    for (const marker of [model, engine, context])
      expect(marker?.getAttribute('aria-label')).toBeNull();
    expect(model?.closest('article')).toBeNull();
    for (const marker of [engine, context])
      expect(marker?.closest('article')?.textContent).toBe(marker?.textContent);
    // The model pill sits before the answer it explains.
    const answer = [...container.querySelectorAll('article')].find((node) =>
      node.textContent?.includes('Scripted showcase'),
    );
    expect(answer).toBeDefined();
    expect(
      (model as Node).compareDocumentPosition(answer as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('a recorded switch the server refused draws no switch row', () => {
    const { container } = renderTranscript(REFUSED, transcript(REFUSED));
    expect(kinds(container)).toEqual(['model', 'context']);
    expect(container.textContent).not.toContain('Switched to');
  });

  test('a later message in the reused Session does not turn a refused switch into one', () => {
    // After the refused switch the person writes again: that turn runs in
    // the fresh context's Session the refused record names, on the old Agent.
    const handoff = REFUSED.handoffs[0] as ConversationHandoffProjection;
    const later = Date.parse(handoff.createdAt) + 60_000;
    const reusedTurn = REFUSED.events.filter(
      ({ event }) => event.threadId === handoff.sessionId && event.turnId,
    );
    expect(reusedTurn.length).toBeGreaterThan(0);
    const again: CapturedWindow = {
      ...REFUSED,
      events: [
        ...REFUSED.events,
        ...reusedTurn.map(({ sequence, event }, offset) => ({
          sequence: sequence + 1000,
          event: {
            ...event,
            eventId: `${event.eventId}-again`,
            turnId: `${event.turnId}-again`,
            createdAt: new Date(later + offset).toISOString(),
          },
        })),
      ],
    };
    const { container } = renderTranscript(again, transcript(again));
    expect(container.textContent).not.toContain('Switched to');
  });

  test('a switch that started from an empty fresh context says nothing was read', () => {
    const { container } = renderTranscript(
      RESET_THEN_SWITCH,
      transcript(RESET_THEN_SWITCH),
    );
    const [engine] = markers(container, 'engine');
    expect(engine?.querySelector('.transcript-change__note')?.textContent).toBe(
      'Approvals, tool servers and queued messages start fresh.',
    );
  });

  test('a switch that started from a summary says a summary was read', () => {
    const summary: CapturedWindow = {
      ...RESET_THEN_SWITCH,
      contextBoundaries: RESET_THEN_SWITCH.contextBoundaries.map(
        (boundary) => ({ ...boundary, policy: 'summary-next-cold-start' }),
      ),
    };
    const { container } = renderTranscript(summary, transcript(summary));
    expect(
      markers(container, 'engine')[0]?.querySelector('.transcript-change__note')
        ?.textContent,
    ).toBe(
      'Reviewer read a summary instead of recent messages. Approvals, tool servers and queued messages start fresh.',
    );
  });

  describe('what ran, not only what was asked for', () => {
    test('requested changed but the engine reported the same model: no pill', () => {
      const window = rootOnly(COMPLETED);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) =>
          event.method === 'turn.completed'
            ? {
                ...event,
                metadata: { ...event.metadata, reportedModel: 'scripted-echo' },
              }
            : event,
        ),
      );
      expect(markers(container, 'model')).toHaveLength(0);
    });

    test('the engine reported a different model: the pill names what ran', () => {
      const window = rootOnly(COMPLETED);
      const requested = requestedByTurn(window);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) =>
          event.method === 'turn.completed' && event.turnId
            ? {
                ...event,
                metadata: {
                  ...event.metadata,
                  reportedModel: `${requested.get(event.turnId)}-resolved`,
                },
              }
            : event,
        ),
      );
      expect(markers(container, 'model')[0]?.textContent).toBe(
        'Model: Scripted Echo Resolved →  to Scripted Showcase ResolvedSame engine, same memory.',
      );
    });

    test('one turn with the engine’s report and one without: no pill rather than an alias against an id', () => {
      const window = rootOnly(COMPLETED);
      const [first] = turnStarts(window);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) =>
          event.method === 'turn.completed' && event.turnId === first?.turnId
            ? {
                ...event,
                metadata: { ...event.metadata, reportedModel: 'scripted-echo' },
              }
            : event,
        ),
      );
      expect(markers(container, 'model')).toHaveLength(0);
    });

    test('a reroute inside one turn keeps its own line and adds no model pill', () => {
      // Codex: `model/rerouted` → `model.rerouted`, scope turn
      // (codex-adapter-notifications.ts `codexModelReroute`); both turns
      // asked for the same model.
      const window = rootOnly(COMPLETED);
      const [first, second] = turnStarts(window);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) => {
          const same = isTurnEvent(event)
            ? {
                ...event,
                provider: 'codex',
                metadata: { ...event.metadata, effectiveModel: 'gpt-a' },
              }
            : { ...event, provider: 'codex' };
          if (
            event.method === 'turn.started' &&
            event.turnId === second?.turnId
          )
            return [
              same as RecordedEvent,
              {
                ...event,
                eventId: `${event.eventId}-reroute`,
                method: 'model.rerouted',
                provider: 'codex',
                fromModel: 'gpt-a',
                toModel: 'gpt-b',
                trigger: 'other',
                scope: 'turn',
                turnId: event.turnId,
              } as unknown as RecordedEvent,
            ];
          return same as RecordedEvent;
        }),
      );
      expect(first).toBeDefined();
      expect(markers(container, 'model')).toHaveLength(0);
      expect(container.textContent).toContain(
        'Model switched from gpt-a to gpt-b',
      );
    });
  });

  describe('each engine, in the shape its adapter writes', () => {
    test('Claude Code: asked-for model on the start, the engine’s own on the end', () => {
      // claude-adapter.ts `dispatchedTurnStartEvent` (effectiveModel on
      // turn.started); claude-adapter-events.ts turn.completed carries only
      // `reportedModel`.
      const window = rootOnly(COMPLETED);
      const reported = new Map([
        ['scripted-echo', 'claude-sonnet-reported'],
        ['scripted-showcase', 'claude-opus-reported'],
      ]);
      const requested = requestedByTurn(window);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) => {
          const base = { ...event, provider: 'claude' } as RecordedEvent;
          if (event.method === 'turn.started')
            return {
              ...base,
              metadata: {
                effectiveModel:
                  event.metadata?.effectiveModel === 'scripted-echo'
                    ? 'sonnet'
                    : 'opus',
                effectiveModelOptions: {},
              },
            };
          if (event.method === 'turn.completed')
            return {
              ...base,
              metadata: {
                reportedModel: reported.get(
                  requested.get(event.turnId as string) as string,
                ),
              },
            };
          return base;
        }),
      );
      expect(markers(container, 'model')[0]?.textContent).toBe(
        'Model: Sonnet Reported →  to Opus ReportedSame engine, same memory.',
      );
    });

    test('Codex: the asked-for model on the start, nothing on the end', () => {
      // codex-adapter.ts turn.started `effectiveModelMetadata(input.modelId
      // ?? record.session.model)`; codex-adapter-notifications.ts
      // turn.completed has no metadata.
      const window = rootOnly(COMPLETED);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) => {
          const base = { ...event, provider: 'codex' } as RecordedEvent;
          if (event.method === 'turn.completed') {
            const { metadata: _none, ...rest } = base;
            return rest as RecordedEvent;
          }
          return base;
        }),
      );
      expect(markers(container, 'model')).toHaveLength(1);
    });

    test('an ACP engine: a model change starts a new Session, so no pill claims the same memory', () => {
      // ACP applies a model only at session start: the server reserves a
      // successor Session for the next turn (`conversation-lineage.ts`
      // `needsModelRestart`), with no boundary row.
      const window = rootOnly(COMPLETED);
      const [, second] = turnStarts(window);
      const successor = `${rootSession(window)}:session:model-restart`;
      const { container } = renderTranscript(
        window,
        transcript(window, (event) => {
          const base = {
            ...event,
            provider: 'acp',
            ...(event.turnId === second?.turnId ? { threadId: successor } : {}),
          } as RecordedEvent;
          return isTurnEvent(event)
            ? {
                ...base,
                metadata: { ...base.metadata, engineDisplayName: 'OpenCode' },
              }
            : base;
        }),
      );
      expect(markers(container, 'model')).toHaveLength(0);
    });

    test('OpenCode native: turns record no model, so no pill', () => {
      // opencode-serve-session.ts `publishStart`: turn.started carries no
      // model metadata.
      const window = rootOnly(COMPLETED);
      const { container } = renderTranscript(
        window,
        transcript(window, (event) => {
          const base = { ...event, provider: 'opencode' } as RecordedEvent;
          if (!isTurnEvent(event)) return base;
          const { metadata: _none, ...rest } = base;
          return rest as RecordedEvent;
        }),
      );
      expect(markers(container, 'model')).toHaveLength(0);
    });
  });

  test('a turn with no recorded model between two that did breaks the comparison', () => {
    // Refused window, first Session: echo, echo, echo, echo, showcase.
    const window = rootOnly(REFUSED);
    const echoes = turnStarts(window).filter(
      (event) =>
        (event as RecordedEvent).metadata?.effectiveModel === 'scripted-echo',
    );
    const lastEcho = echoes.at(-1)?.turnId;
    expect(echoes.length).toBeGreaterThan(1);
    const intact = renderTranscript(window, transcript(window));
    expect(markers(intact.container, 'model')).toHaveLength(1);
    intact.unmount();
    const { container } = renderTranscript(
      window,
      transcript(window, (event) => {
        if (event.turnId !== lastEcho || !event.metadata) return event;
        const { effectiveModel: _omitted, ...metadata } = event.metadata;
        return { ...event, metadata };
      }),
    );
    expect(markers(container, 'model')).toHaveLength(0);
  });

  test('a turn still streaming shows its pill from the model it asked for', () => {
    const window = rootOnly(COMPLETED);
    const [, second] = turnStarts(window);
    // The settled turn carries the engine's own report; the running one has
    // only what it asked for, compared with what the previous turn asked for.
    const settled = transcript(window, (event) =>
      event.method === 'turn.completed'
        ? {
            ...event,
            metadata: { ...event.metadata, reportedModel: 'scripted-echo-ran' },
          }
        : event,
    ).filter((message) => message.turnId !== second?.turnId);
    const { container, getByTestId } = renderTranscript(window, settled, {
      orchestrationSessionStarted: true,
      orchestrationTurnOpen: true,
      orchestrationModel: 'scripted-showcase',
      currentSessionId: rootSession(window),
    } as Partial<ChatSession>);
    const [model] = markers(container, 'model');
    expect(model?.textContent).toBe(
      'Model: Scripted Echo →  to Scripted ShowcaseSame engine, same memory.',
    );
    expect(
      (model as Node).compareDocumentPosition(getByTestId('streaming-row')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('on a phone, no exchange rule is drawn straight after a change marker', () => {
    mobile.current = true;
    try {
      const { container } = renderTranscript(COMPLETED, transcript(COMPLETED));
      const rows = [...container.querySelectorAll('article')];
      for (const kind of ['engine', 'context']) {
        const at = rows.findIndex((row) =>
          row.querySelector(`.transcript-change--${kind}`),
        );
        const next = rows[at + 1];
        expect(next?.querySelector('.message-row--user')).toBeTruthy();
        expect(next?.querySelector('.message-row--exchange-start')).toBeNull();
      }
      // Other exchanges keep their rule.
      expect(
        container.querySelectorAll('.message-row--exchange-start').length,
      ).toBeGreaterThan(0);
    } finally {
      mobile.current = false;
    }
  });

  test('the handed-over size in the copy is the server seed budget', async () => {
    const { TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET } = await import(
      '../../../src-server/services/orchestration/conversation-transcript-seed'
    );
    expect(TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET).toBe(8_000);
    const { container } = renderTranscript(COMPLETED, transcript(COMPLETED));
    expect(markers(container, 'engine')[0]?.textContent).toContain(
      `about ${TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET / 1000}K tokens`,
    );
  });
});
