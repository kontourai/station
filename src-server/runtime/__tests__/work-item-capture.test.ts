import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';
import { createMCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import {
  createEventStoreWorkItemPrincipalLiveness,
  WorkItemCapture,
} from '../work-item-capture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open() {
  const directory = mkdtempSync(join(tmpdir(), 'station-work-item-capture-'));
  directories.push(directory);
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  store.upsertSession({
    provider: 'station-agent',
    threadId: 'session-1',
    status: 'ready',
    createdAt: '2026-08-28T12:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  });
  return store;
}

function capture(
  store: EventStore,
  isPrincipalCurrent: NonNullable<
    ConstructorParameters<typeof WorkItemCapture>[1]
  > = () => true,
) {
  return new WorkItemCapture(store, isPrincipalCurrent);
}

function completion(): Extract<
  CanonicalRuntimeEvent,
  { method: 'tool.completed' }
> {
  return {
    eventId: 'event-1',
    provider: 'station-agent',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-08-28T12:01:00.000Z',
    method: 'tool.completed',
    itemId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'github_createIssue',
    status: 'success',
    output: { public: true },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const generation = createMCPToolProvenanceGeneration();
  return {
    tool: {
      toolName: 'github_createIssue',
      toolCallId: 'call-1',
      toolArgs: { ignored: true },
      mcp: {
        provenance: generation.mint({
          serverId: 'github',
          originalToolName: 'create_issue',
          runtimeName: 'github_createIssue',
          integrationId: 'github',
        }),
        trustedArguments: {
          owner: 'KontourAI',
          repo: 'Station',
          title: 'Capture',
        },
      },
    },
    result: {
      output: { model: 'never used' },
      mcp: {
        trustedContent: [
          {
            type: 'text',
            text: JSON.stringify({
              id: '1234567890',
              url: 'https://github.com/KontourAI/Station/issues/235',
            }),
          },
        ],
      },
    },
    invocation: {
      agentSlug: 'planner',
      conversationId: 'session-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      principalId: 'account-1',
      userId: 'user-1',
    },
    current: () => true,
    ...overrides,
  } as any;
}

describe('WorkItemCapture', () => {
  test('stages a normalized official GitHub result before its canonical terminal append', () => {
    const store = open();
    try {
      capture(store).capture(input());
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([]);
      store.appendEvent(completion());
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([
        expect.objectContaining({
          associationId: expect.stringMatching(/^swia:v1:[0-9a-f]{64}$/),
          workItemRef: 'github:kontourai/station#235',
          nativeId: '1234567890',
          eventId: 'event-1',
          turnId: 'turn-1',
          toolCallId: 'call-1',
        }),
      ]);
      expect(store.listEvents('session-1')[0]).toMatchObject({
        payload: { output: { public: true } },
      });
    } finally {
      store.close();
    }
  });

  test.each([
    ['failed', { result: { error: new Error('failed') } }],
    [
      'missing Session',
      {
        invocation: {
          agentSlug: 'planner',
          conversationId: 'session-1',
          turnId: 'turn-1',
          principalId: 'account-1',
        },
      },
    ],
    [
      'missing turn',
      {
        invocation: {
          agentSlug: 'planner',
          conversationId: 'session-1',
          sessionId: 'session-1',
          principalId: 'account-1',
        },
      },
    ],
    [
      'wrong lineage',
      {
        invocation: {
          agentSlug: 'planner',
          conversationId: 'other',
          sessionId: 'session-1',
          turnId: 'turn-1',
          principalId: 'account-1',
        },
      },
    ],
    ['revoked current', { current: () => false }],
    [
      'schema drift',
      {
        result: {
          mcp: {
            trustedContent: [
              {
                type: 'text',
                text: '{"id":"123","url":"https://github.com/kontourai/station/issues/235","extra":true}',
              },
            ],
          },
        },
      },
    ],
  ])('does not stage %s material', (_label, overrides) => {
    const store = open();
    try {
      capture(store).capture(input(overrides));
      store.appendEvent(completion());
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('uses child execution Session proof but persists the durable parent Conversation', () => {
    const store = open();
    try {
      store.reserveNextConversationSession({
        conversationId: 'session-1',
        predecessorSessionId: 'session-1',
        proposedSessionId: 'session-2',
        createdAt: '2026-08-28T12:00:30.000Z',
      });
      store.upsertSession({
        provider: 'station-agent',
        threadId: 'session-2',
        status: 'ready',
        createdAt: '2026-08-28T12:00:30.000Z',
        updatedAt: '2026-08-28T12:00:30.000Z',
      });
      capture(store).capture(
        input({
          invocation: {
            agentSlug: 'planner',
            conversationId: 'session-2',
            sessionId: 'session-2',
            turnId: 'turn-2',
            principalId: 'account-1',
            userId: 'user-1',
          },
          tool: {
            ...input().tool,
            toolCallId: 'call-2',
          },
        }),
      );
      store.appendEvent({
        ...completion(),
        eventId: 'event-2',
        threadId: 'session-2',
        turnId: 'turn-2',
        toolCallId: 'call-2',
        itemId: 'call-2',
      });
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-2',
          conversationId: 'session-1',
        }),
      ).toEqual([
        expect.objectContaining({
          sessionId: 'session-2',
          conversationId: 'session-1',
        }),
      ]);
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([]);
      expect(store.readSessionByThread('session-1')?.threadId).toBe(
        'session-1',
      );
      expect(store.readSessionByThread('session-2')?.threadId).toBe(
        'session-2',
      );
    } finally {
      store.close();
    }
  });

  test('rechecks principal and hosted tenant liveness at terminal append', () => {
    const store = open();
    let current = true;
    try {
      capture(store, () => current).capture(input());
      current = false;
      store.appendEvent(completion());
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('fails closed when the runtime-owned owner/tenant resolver drifts', () => {
    const store = open();
    try {
      store.appendEvent({
        eventId: 'session-owner',
        provider: 'station-agent',
        threadId: 'session-1',
        createdAt: '2026-08-28T12:00:00.000Z',
        method: 'session.configured',
        sessionId: 'session-1',
        metadata: { userId: 'user-1' },
      } as any);
      store.upsertSession({
        provider: 'station-agent',
        threadId: 'session-1',
        status: 'ready',
        tenantExecutionContext: { tenantId: 'alpha' as any, source: 'session' },
        createdAt: '2026-08-28T12:00:00.000Z',
        updatedAt: '2026-08-28T12:00:01.000Z',
      });
      capture(store, createEventStoreWorkItemPrincipalLiveness(store)).capture(
        input({
          invocation: {
            agentSlug: 'planner',
            conversationId: 'session-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            principalId: 'tenant-account-1',
            userId: 'user-1',
          },
        }),
      );
      store.upsertSession({
        provider: 'station-agent',
        threadId: 'session-1',
        status: 'ready',
        tenantExecutionContext: { tenantId: 'other' as any, source: 'session' },
        createdAt: '2026-08-28T12:00:00.000Z',
        updatedAt: '2026-08-28T12:00:02.000Z',
      });
      store.appendEvent(completion());
      expect(
        store.listSessionWorkItemObservations({
          sessionId: 'session-1',
          conversationId: 'session-1',
        }),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
});
