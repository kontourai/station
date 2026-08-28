import { describe, expect, it, test, vi } from 'vitest';
import { K } from '../../../src-shared/monitoring-keys';
import type {
  AgentStats,
  MonitoringEvent,
} from '../contexts/MonitoringContext';

vi.mock(
  '@shared/monitoring-keys',
  async () => import('../../../src-shared/monitoring-keys'),
);

const {
  filterMonitoringEvents,
  getHistoricalAgentSlugs,
  getMonitoringAgentCountLabel,
  getRunningConversations,
  monitoringSessionCounts,
} = await import('../views/monitoring/view-utils');

function createEvent(overrides: Partial<MonitoringEvent>): MonitoringEvent {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    'timestamp.ms': 1,
    'trace.id': 'trace-1',
    'gen_ai.operation.name': 'invoke_agent',
    'span.kind': 'start',
    ...overrides,
  };
}

describe('monitoring view utils', () => {
  it('filters events with selected sidebar filters and sorts oldest first', () => {
    const events = [
      createEvent({
        timestamp: '2026-01-01T00:00:02.000Z',
        [K.AGENT_SLUG]: 'beta',
        [K.CONVERSATION_ID]: 'conversation-2',
      }),
      createEvent({
        timestamp: '2026-01-01T00:00:01.000Z',
        [K.AGENT_SLUG]: 'alpha',
        [K.CONVERSATION_ID]: 'conversation-1',
      }),
    ];

    const filtered = filterMonitoringEvents(events, {
      searchQuery: '',
      selectedAgents: ['alpha'],
      selectedConversation: null,
      selectedToolCallId: null,
      selectedTraceId: null,
      eventTypeFilter: ['agent-start'],
    });

    expect(filtered).toEqual([
      expect.objectContaining({
        [K.AGENT_SLUG]: 'alpha',
        [K.CONVERSATION_ID]: 'conversation-1',
      }),
    ]);
  });

  it('derives historical agents and running conversations from events', () => {
    const activeAgents: AgentStats[] = [
      {
        slug: 'alpha',
        name: 'Alpha',
        status: 'running',
        model: 'model-a',
        conversationCount: 1,
        messageCount: 2,
        cost: 0,
      },
    ];
    const filteredEvents = [
      createEvent({
        [K.AGENT_SLUG]: 'alpha',
        [K.CONVERSATION_ID]: 'conversation:1',
      }),
      createEvent({
        [K.AGENT_SLUG]: 'legacy',
        [K.CONVERSATION_ID]: 'conversation:2',
      }),
    ];

    expect(getHistoricalAgentSlugs(filteredEvents, activeAgents)).toEqual([
      'legacy',
    ]);
    expect(
      getMonitoringAgentCountLabel(
        {
          agents: activeAgents,
          summary: {
            totalAgents: 1,
            activeAgents: 1,
            runningAgents: 1,
            totalMessages: 2,
            totalCost: 0,
          },
        },
        filteredEvents,
      ),
    ).toBe('1 Active • 1 Historical');
    expect(getRunningConversations(filteredEvents, 'alpha')).toEqual([
      {
        id: 'conversation:1',
        color: expect.any(String),
      },
    ]);
  });
});

describe('slug-less events stay reachable (station#3086)', () => {
  it("answers to '(unnamed)' instead of vanishing behind every agent filter", () => {
    // `|| ''` matched these against a bucket nobody can select, so an event
    // with no agent slug was invisible behind ANY agent filter.
    const events = [createEvent({ [K.AGENT_SLUG]: 'alpha' }), createEvent({})];

    const unnamed = filterMonitoringEvents(events, {
      searchQuery: '',
      selectedAgents: ['(unnamed)'],
      selectedConversation: null,
      selectedToolCallId: null,
      selectedTraceId: null,
      eventTypeFilter: [],
    } as never);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]?.[K.AGENT_SLUG]).toBeUndefined();

    // The negative control: a named filter must not start catching them.
    const named = filterMonitoringEvents(events, {
      searchQuery: '',
      selectedAgents: ['alpha'],
      selectedConversation: null,
      selectedToolCallId: null,
      selectedTraceId: null,
      eventTypeFilter: [],
    } as never);
    expect(named).toHaveLength(1);
    expect(named[0]?.[K.AGENT_SLUG]).toBe('alpha');

    // An EMPTY-STRING slug is the same absence as a missing one — that is
    // the whole premise of this change, and it was the one case nothing
    // covered: weakening the rule to `typeof slug === 'string'` (so `''`
    // stays `''`) kept every other test green.
    const emptySlug = filterMonitoringEvents(
      [createEvent({ [K.AGENT_SLUG]: '' })],
      {
        searchQuery: '',
        selectedAgents: ['(unnamed)'],
        selectedConversation: null,
        selectedToolCallId: null,
        selectedTraceId: null,
        eventTypeFilter: [],
      } as never,
    );
    expect(emptySlug).toHaveLength(1);
  });

  it('offers (unnamed) in the agent picker', () => {
    const slugs = getHistoricalAgentSlugs(
      [createEvent({ [K.AGENT_SLUG]: 'alpha' }), createEvent({})],
      [],
    );
    expect(slugs).toContain('(unnamed)');
    expect(slugs).toContain('alpha');
  });
});

// audit 6-: the derivation behind Monitoring's two summary numbers.
describe('monitoringSessionCounts', () => {
  test('counts unstopped sessions as active and open turns as running', () => {
    expect(
      monitoringSessionCounts([
        { lifecycleState: 'running', hasActiveTurn: true },
        { lifecycleState: 'needs_input' },
        { lifecycleState: 'completed', hasActiveTurn: false },
        { lifecycleState: 'failed' },
        { lifecycleState: 'canceled' },
      ]),
    ).toEqual({ activeSessions: 2, runningTurns: 1 });
  });

  test('an undecorated session is not counted active on a state nothing reported', () => {
    expect(monitoringSessionCounts([{}])).toEqual({
      activeSessions: 0,
      runningTurns: 0,
    });
    //...but an open turn is a fact the server did report.
    expect(monitoringSessionCounts([{ hasActiveTurn: true }])).toEqual({
      activeSessions: 0,
      runningTurns: 1,
    });
  });

  test('an empty Station reports zero of both', () => {
    expect(monitoringSessionCounts([])).toEqual({
      activeSessions: 0,
      runningTurns: 0,
    });
  });
});
