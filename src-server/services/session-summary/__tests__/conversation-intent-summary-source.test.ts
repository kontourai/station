import { CONVERSATION_INTENT_SUMMARY_MAX_ITEMS } from '@kontourai/station-contracts/conversation-intent-summary';
import { encodeTaskTurnReference } from '@kontourai/station-contracts/task-graph';
import { describe, expect, test } from 'vitest';
import {
  CONTEXT_BOUNDARY_OMISSION_MARKER,
  SESSION_SUMMARY_MESSAGE_MAX_CHARS,
  SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
} from '../../../routes/chat/session-summary-generation.js';
import {
  AuthoritativeConversationIntentSummarySource,
  createConversationIntentSummaryEvidenceCatalog,
} from '../conversation-intent-summary-source.js';

describe('AuthoritativeConversationIntentSummarySource', () => {
  test('uses only bounded role/text input, emits only empty-policy omissions, and keeps Task evidence non-verifying', () => {
    const source = new AuthoritativeConversationIntentSummarySource();
    const messages = [
      {
        id: 'goal',
        role: 'user',
        parts: [
          { type: 'text', text: 'Ship the safe summary.' },
          { type: 'tool-call', input: { secret: 'must-not-enter' } },
        ],
      },
      {
        id: 'tail',
        role: 'assistant',
        parts: [{ type: 'text', text: 'x'.repeat(8_000) }],
      },
    ] as any;
    const result = source.read({
      messages,
      watermark: 9,
      consumedBoundaries: [
        {
          boundaryId: 'continue-answered',
          policy: 'continue-from-history',
          priorTranscriptInjected: true,
        },
        {
          boundaryId: 'empty-unanswered',
          policy: 'empty-next-cold-start',
          priorTranscriptInjected: false,
        },
      ],
      relatedEvidenceObservations: [
        {
          kind: 'task-turn',
          taskId: 'task-1',
          turnId: 'turn-1',
          eventId: 'event-1',
          authorized: true,
        },
        { kind: 'task-turn', authorized: false, revoked: true },
      ],
    });

    expect(result.transcript).toContain(CONTEXT_BOUNDARY_OMISSION_MARKER);
    expect(
      result.transcript.split(CONTEXT_BOUNDARY_OMISSION_MARKER).length - 1,
    ).toBe(1);
    expect(result.transcript).not.toContain('must-not-enter');
    expect(result.transcript.length).toBeLessThan(4_000);
    expect(result.transcript).toContain('x'.repeat(100));
    expect(result.relatedEvidenceRefs).toEqual([
      {
        kind: 'task-turn',
        taskId: 'task-1',
        turnId: 'turn-1',
        eventId: 'event-1',
      },
    ]);
    expect(result.verificationRefs).toEqual([
      {
        kind: 'task-turn',
        state: 'unavailable',
        unavailableReason: 'not-captured-by-station',
      },
    ]);
    expect(result.ranges).toEqual([
      { fromMessageId: 'goal', throughMessageId: 'tail', messageCount: 2 },
    ]);
    expect(result.transcript.length).toBeLessThanOrEqual(
      SESSION_SUMMARY_MESSAGE_MAX_CHARS + 300,
    );
    expect(source.read({ messages, watermark: 10 }).revision).not.toBe(
      result.revision,
    );
  });

  test.each([
    ['continue-from-history', true, false],
    ['continue-from-history', false, false],
    ['empty-next-cold-start', true, true],
    ['empty-next-cold-start', false, true],
  ] as const)(
    'boundary policy %s with successor answered=%s renders omission=%s',
    (policy, _answered, rendersOmission) => {
      const result = new AuthoritativeConversationIntentSummarySource().read({
        messages: [
          { id: 'u', role: 'user', parts: [{ type: 'text', text: 'goal' }] },
          ...(_answered
            ? [
                {
                  id: 'a',
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'answer' }],
                },
              ]
            : []),
        ] as any,
        consumedBoundaries: [
          {
            boundaryId: `${policy}-${_answered}`,
            policy,
            priorTranscriptInjected: policy === 'continue-from-history',
          },
        ],
      });
      expect(result.transcript.includes(CONTEXT_BOUNDARY_OMISSION_MARKER)).toBe(
        rendersOmission,
      );
      if (rendersOmission)
        expect(result.transcript).toContain(
          '[CONTEXT_BOUNDARY_OMISSION: prior transcript was not injected into the successor engine; this summary separately reads canonical history]',
        );
    },
  );

  test('reports first-goal and recent-turn selections as separate canonical ranges', () => {
    const result = new AuthoritativeConversationIntentSummarySource().read({
      messages: [
        { id: 'goal', role: 'user', parts: [{ type: 'text', text: 'goal' }] },
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `m${index}`,
          role: index % 2 ? 'assistant' : 'user',
          parts: [{ type: 'text', text: `turn ${index}` }],
        })),
      ] as any,
    });
    expect(result.ranges).toEqual([
      { fromMessageId: 'goal', throughMessageId: 'goal', messageCount: 1 },
      { fromMessageId: 'm2', throughMessageId: 'm9', messageCount: 8 },
    ]);
  });

  test('caps source collections and complete transcript input before revision', () => {
    const result = new AuthoritativeConversationIntentSummarySource().read({
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `m${index}`,
        role: index % 2 ? 'assistant' : 'user',
        parts: [{ type: 'text', text: 'x'.repeat(1_600) }],
      })) as any,
      consumedBoundaries: Array.from(
        { length: CONVERSATION_INTENT_SUMMARY_MAX_ITEMS + 1 },
        (_, index) => ({
          boundaryId: `b${index}`,
          policy: 'empty-next-cold-start' as const,
          priorTranscriptInjected: false,
        }),
      ),
      relatedEvidenceObservations: Array.from(
        { length: CONVERSATION_INTENT_SUMMARY_MAX_ITEMS + 1 },
        (_, index) => ({
          kind: 'task-turn' as const,
          taskId: `task-${index}`,
          turnId: `turn-${index}`,
          eventId: `event-${index}`,
          authorized: true as const,
        }),
      ),
    });
    expect(result.contextBoundaries).toHaveLength(
      CONVERSATION_INTENT_SUMMARY_MAX_ITEMS,
    );
    expect(result.relatedEvidenceRefs).toHaveLength(
      CONVERSATION_INTENT_SUMMARY_MAX_ITEMS,
    );
    expect(result.transcript.length).toBeLessThanOrEqual(
      SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
    );
    expect(
      result.ranges.reduce((total, range) => total + range.messageCount, 0),
    ).toBe(result.messages.length);
  });
});

describe('conversation intent evidence catalog', () => {
  test('admits only a current-window, authorized Task turn and drops forged, foreign, and revoked links', async () => {
    const catalog = createConversationIntentSummaryEvidenceCatalog({
      taskGraph: {
        listTasks: () => [
          { id: 'task-good' },
          { id: 'task-foreign' },
          { id: 'task-revoked' },
        ],
        readTaskTurnReferenceScope: (taskId) =>
          taskId === 'task-foreign'
            ? { projectId: 'other-project' }
            : { projectId: 'project' },
        readTaskTurnReferenceLinks: (taskId) => {
          if (taskId === 'task-good')
            return [
              {
                id: 'good',
                targetId: encodeTaskTurnReference('session-1', 'turn-1'),
              },
              { id: 'forged', targetId: 'turn/not-canonical' },
            ];
          if (taskId === 'task-foreign')
            return [
              {
                id: 'foreign',
                targetId: encodeTaskTurnReference('session-1', 'turn-1'),
              },
            ];
          return [
            {
              id: 'revoked',
              targetId: encodeTaskTurnReference('session-1', 'turn-revoked'),
            },
          ];
        },
      },
      sessionQueries: {
        readAssistantTurn: async ({ turnId }) =>
          turnId === 'turn-1'
            ? { status: 'found' as const, projectSlug: 'project' }
            : { status: 'not-found' as const },
      },
    });
    await expect(
      catalog.observe({
        authority: { mode: 'personal', userId: 'user' } as any,
        events: [
          {
            event: {
              eventId: 'event-1',
              threadId: 'session-1',
              turnId: 'turn-1',
              method: 'turn.completed',
            },
          },
          {
            event: {
              eventId: 'tool-only',
              threadId: 'session-1',
              turnId: 'turn-revoked',
              method: 'tool.completed',
            },
          },
        ],
      }),
    ).resolves.toEqual([
      {
        kind: 'task-turn',
        taskId: 'task-good',
        turnId: 'turn-1',
        eventId: 'event-1',
        authorized: true,
      },
    ]);
  });
});
