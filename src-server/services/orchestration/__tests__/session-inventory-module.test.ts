import { parseSessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { composeAuthorizedSessionAnswerBasis } from '../../projects/task-basis-module.js';
import {
  createSessionInventoryModule,
  withTaskKeptRows,
} from '../session-inventory-module.js';
import type { SessionWorkItemModule } from '../session-work-item-module.js';

const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);
const output = {
  ref: { sessionId: 'session-a', eventId: 'event-a' },
  turnId: 'turn-a',
  toolCallId: 'call-a',
  declaredAt: '2026-08-26T00:00:00.000Z',
  descriptor: {
    kind: 'workspace-file' as const,
    relativePath: 'result.txt',
    digest: 'a'.repeat(64),
    length: 2,
  },
};
function currentAnswer(turnId = 'turn-a', inputs: readonly unknown[] = []) {
  return {
    status: 'found' as const,
    sessionId: 'session-a',
    turnId,
    observedAt: '2026-08-26T00:00:00.000Z',
    binding: {
      version: 'station-answer-binding/v1' as const,
      sessionId: 'session-a',
      turnId,
      answer: {
        authority: '@kontourai/thread' as const,
        schemaVersion: '1.2.0' as const,
        kind: 'assistant-message' as const,
        standing: 'observed' as const,
        threadId: 'session-a',
        messageId: 'message-a',
      },
    },
    inputs,
    results: [],
  };
}
function exactFound(answer = currentAnswer()) {
  return {
    status: 'found' as const,
    answer,
    projection: composeAuthorizedSessionAnswerBasis(answer as never),
  };
}
function workItem(overrides: Record<string, unknown> = {}) {
  return {
    version: 'station.session-work-item/v1' as const,
    associationId: 'association-a',
    sessionId: 'session-a',
    conversationId: 'conversation-a',
    eventId: 'event-a',
    turnId: 'turn-a',
    toolCallId: 'call-a',
    relation: 'created' as const,
    provider: { id: 'github' as const, host: 'github.com' as const },
    workItemRef: 'github:kontourai/station#235' as const,
    repository: { owner: 'kontourai', name: 'station' },
    nativeId: '1234567890',
    observedAt: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}
describe('SessionInventoryModule', () => {
  test('projects one deduplicated exact-session work item with only trusted facts', async () => {
    const observation = workItem();
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      conversationForSession: () => ({ conversationId: 'conversation-a' }),
      sessionWorkItems: {
        read: () => ({
          status: 'found',
          projection: {
            version: 'station.session-work-item/v1',
            observations: [
              observation,
              { ...observation, associationId: 'association-b' },
            ],
            items: [
              {
                sessionId: 'session-a',
                conversationId: 'conversation-a',
                workItemRef: observation.workItemRef,
                provider: observation.provider,
                repository: observation.repository,
                nativeId: observation.nativeId,
                associationIds: ['association-a', 'association-b'],
                observedAt: observation.observedAt,
              },
            ],
          },
        }),
      } as never,
    });
    const result = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected projection');
    const group = result.projection.groups.find(
      (item) => item.id === 'work-items',
    );
    expect(group).toMatchObject({
      state: 'available',
      count: { kind: 'exact', value: 1 },
    });
    expect(group?.items[0]).toMatchObject({
      associationIds: ['association-a', 'association-b'],
      eventId: 'event-a',
    });
    expect(JSON.stringify(group)).not.toContain('http');
    expect(parseSessionInventoryProjection(result.projection)).toEqual(
      result.projection,
    );
  });
  test('keeps work-item owner gaps typed and task association exact', async () => {
    const outputs = {
      list: vi.fn().mockResolvedValue({
        status: 'found',
        page: { version: 'session-outputs/v1', items: [], partial: false },
      }),
    } as never;
    for (const [status, state] of [
      ['not-found', 'restricted'],
      ['unavailable', 'unavailable'],
      ['corrupt', 'corrupt'],
    ] as const) {
      const module = createSessionInventoryModule({
        sessionOutputs: outputs,
        canReadSession: () => true,
        conversationForSession: () => ({ conversationId: 'conversation-a' }),
        sessionWorkItems: { read: () => ({ status }) } as never,
      });
      const result = await module.read({
        scope: { kind: 'whole-session', sessionId: 'session-a' },
        authority,
        current: () => true,
      });
      expect(result).toMatchObject({
        status: 'found',
        projection: {
          groups: expect.arrayContaining([
            expect.objectContaining({ id: 'work-items', state }),
          ]),
        },
      });
    }
    const observation = workItem();
    const module = createSessionInventoryModule({
      sessionOutputs: outputs,
      canReadSession: () => true,
      conversationForSession: (sessionId) =>
        sessionId === 'session-a'
          ? { conversationId: 'conversation-a' }
          : undefined,
      sessionWorkItems: {
        read: ({
          sessionId,
          conversationId,
        }: Parameters<SessionWorkItemModule['read']>[0]) =>
          sessionId === 'session-a' && conversationId === 'conversation-a'
            ? {
                status: 'found',
                projection: {
                  version: 'station.session-work-item/v1',
                  observations: [observation],
                  items: [
                    {
                      sessionId: 'session-a',
                      conversationId: 'conversation-a',
                      workItemRef: observation.workItemRef,
                      provider: observation.provider,
                      repository: observation.repository,
                      nativeId: observation.nativeId,
                      associationIds: ['association-a'],
                      observedAt: observation.observedAt,
                    },
                  ],
                },
              }
            : { status: 'not-found' },
      } as never,
    });
    const exact = await module.read({
      scope: { kind: 'kept-in-task', sessionId: 'session-a', taskId: 'task-a' },
      taskWorkItemRef: 'github:kontourai/station#235',
      authority,
      current: () => true,
    });
    const unrelated = await module.read({
      scope: { kind: 'kept-in-task', sessionId: 'session-a', taskId: 'task-a' },
      taskWorkItemRef: 'github:kontourai/station#236',
      authority,
      current: () => true,
    });
    const exactRow =
      exact.status === 'found'
        ? exact.projection.groups.find((group) => group.id === 'work-items')
            ?.items[0]
        : undefined;
    const unrelatedRow =
      unrelated.status === 'found'
        ? unrelated.projection.groups.find((group) => group.id === 'work-items')
            ?.items[0]
        : undefined;
    expect(exactRow).toMatchObject({
      relations: ['observed-during', 'produced-by', 'kept-in-task'],
    });
    expect(unrelatedRow).toMatchObject({
      relations: ['observed-during', 'produced-by'],
    });
    await expect(
      module.read({
        scope: { kind: 'whole-session', sessionId: 'session-child' },
        authority,
        current: () => true,
      }),
    ).resolves.toMatchObject({
      status: 'found',
      projection: {
        groups: expect.arrayContaining([
          expect.objectContaining({ id: 'work-items', state: 'not-captured' }),
        ]),
      },
    });
  });
  test('keeps same-turn declared output out of current answer and never reads bodies', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 'found',
      page: {
        version: 'session-outputs/v1',
        items: [output],
        partial: false,
      },
    });
    const module = createSessionInventoryModule({
      sessionOutputs: { list } as never,
      canReadSession: () => true,
      readExactAnswerBasis: (async () => exactFound()) as never,
    });
    const answer = await module.read({
      scope: {
        kind: 'current-answer',
        sessionId: 'session-a',
        turnId: 'turn-a',
      },
      authority,
      current: () => true,
    });
    expect(answer).toMatchObject({
      status: 'found',
      projection: {
        groups: expect.arrayContaining([
          expect.objectContaining({ id: 'outputs', items: [] }),
        ]),
      },
    });
    expect(list).not.toHaveBeenCalled();
  });
  test('uses the exact answer owner, exposes only contributed Thread facts, and makes a wrong turn opaque', async () => {
    const readExactAnswerBasis = vi.fn(async (_input: { turnId: string }) =>
      _input.turnId === 'turn-a'
        ? exactFound(
            currentAnswer('turn-a', [
              {
                eventId: 'input-a',
                kind: 'initial' as const,
                prompt: 'never exposed',
                attachments: [],
              },
            ]),
          )
        : { status: 'not-found' as const },
    );
    const module = createSessionInventoryModule({
      sessionOutputs: { list: vi.fn() } as never,
      canReadSession: () => true,
      readExactAnswerBasis: readExactAnswerBasis as never,
    });
    const found = await module.read({
      scope: {
        kind: 'current-answer',
        sessionId: 'session-a',
        turnId: 'turn-a',
      },
      authority,
      current: () => true,
    });
    expect(found.status).toBe('found');
    if (found.status !== 'found') throw new Error('expected projection');
    expect(
      found.projection.groups.find((group) => group.id === 'inputs'),
    ).toMatchObject({ items: [{ eventId: 'input-a' }] });
    expect(
      found.projection.groups.find((group) => group.id === 'outputs'),
    ).toMatchObject({ items: [] });
    expect(
      found.projection.groups.find((group) => group.id === 'sources'),
    ).toMatchObject({ state: 'not-captured' });
    // The module's exact-answer relation is a closed transport relation, not
    // a locally typed value the public parser will later reject.
    expect(parseSessionInventoryProjection(found.projection)).toEqual(
      found.projection,
    );
    // The captured Basis remains Surface's exact projection; inventory rows
    // themselves never reproduce the input body.
    expect(JSON.stringify(found.projection.groups)).not.toContain(
      'never exposed',
    );
    expect(readExactAnswerBasis).toHaveBeenCalledTimes(1);
    await expect(
      module.read({
        scope: {
          kind: 'current-answer',
          sessionId: 'session-a',
          turnId: 'wrong-turn',
        },
        authority,
        current: () => true,
      }),
    ).resolves.toEqual({ status: 'not-found' });
    // The route turns this answer-owner miss into the same opaque 404 as a
    // denied session; the module deliberately publishes no current-answer facts.
    expect(readExactAnswerBasis).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'session-a',
        turnId: 'wrong-turn',
        authority,
      }),
    );
  });
  test('returns owner-qualified bounded output metadata and rechecks authority', async () => {
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: {
            version: 'session-outputs/v1',
            items: [output, output, output],
            partial: false,
          },
        }),
      } as never,
      canReadSession: () => true,
    });
    const found = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    expect(found.status).toBe('found');
    if (found.status !== 'found') throw new Error('expected projection');
    const outputs = found.projection.groups.find(
      (group) => group.id === 'outputs',
    );
    expect(outputs?.state).toBe('available');
    expect(outputs?.items).toHaveLength(2);
    expect(outputs?.items[0]).toMatchObject({
      output: expect.not.objectContaining({ text: expect.anything() }),
    });
    expect(
      found.projection.groups.find((group) => group.id === 'sources'),
    ).toMatchObject({
      state: 'not-captured',
      gaps: [
        { kind: 'not-captured', code: 'session-source-index-not-captured' },
      ],
    });
    const revoked = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => false,
    });
    expect(revoked).toEqual({ status: 'not-found' });
  });
  test('folds only canonical descriptors and ignores text, reasoning and progress bodies', async () => {
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionEvents: () => ({
        events: [
          {
            id: 'input',
            payload: {
              method: 'turn.started',
              turnId: 'turn-a',
              prompt: 'never returned',
              attachments: [],
            },
          },
          {
            id: 'tool',
            payload: {
              method: 'tool.completed',
              turnId: 'turn-a',
              toolCallId: 'call-a',
              toolName: 'shell',
              status: 'success',
              output: 'never returned',
            },
          },
          {
            id: 'progress',
            payload: {
              method: 'tool.progress',
              toolCallId: 'call-a',
              message: 'never returned',
            },
          },
          {
            id: 'delta',
            payload: { method: 'content.text-delta', delta: 'never returned' },
          },
        ] as never,
        highWater: 4,
      }),
    });
    const result = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected projection');
    expect(
      result.projection.groups.find((group) => group.id === 'inputs')?.items,
    ).toMatchObject([{ eventId: 'input', inputKind: 'message' }]);
    expect(
      result.projection.groups.find((group) => group.id === 'execution')?.items,
    ).toMatchObject([
      { eventId: 'tool', toolCallId: 'call-a', terminalStatus: 'succeeded' },
    ]);
    expect(JSON.stringify(result.projection)).not.toContain('never returned');
  });
  // station#1558 (fix round, M4): `ThreadToolResultRow.terminalStatus` is a
  // published, exactly-validated vocabulary of outcomes Station observed. An
  // unresolved completion is not one of them, and the old else-branch would
  // have published it as `cancelled` — a stop nobody asked for.
  test('publishes no tool-result row for an unresolved completion rather than calling it cancelled', async () => {
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionEvents: () => ({
        events: [
          {
            id: 'tool-done',
            payload: {
              method: 'tool.completed',
              turnId: 'turn-a',
              toolCallId: 'call-done',
              toolName: 'shell',
              status: 'success',
            },
          },
          {
            id: 'tool-open',
            payload: {
              method: 'tool.completed',
              turnId: 'turn-a',
              toolCallId: 'call-open',
              toolName: 'shell',
              status: 'unresolved',
            },
          },
        ] as never,
        highWater: 2,
      }),
    });
    const result = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('expected projection');
    const execution = result.projection.groups.find(
      (group) => group.id === 'execution',
    );
    // The observed one is published; the unresolved one is absent entirely,
    // and above all is not published as `cancelled`.
    expect(execution?.items).toMatchObject([
      { eventId: 'tool-done', terminalStatus: 'succeeded' },
    ]);
    expect(JSON.stringify(execution)).not.toContain('call-open');
    expect(JSON.stringify(execution)).not.toContain('cancelled');
  });
  test('pages folded groups from an authenticated stable high-water without duplicates', async () => {
    const issued = new Map<string, any>();
    let serial = 0;
    const inputIds = ['input-0', 'input-1', 'input-2'];
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionEvents: (_sessionId, frozenHighWater) => ({
        events: inputIds
          .slice(0, frozenHighWater ?? inputIds.length)
          .map((id) => ({
            id,
            payload: {
              method: 'turn.started',
              turnId: 'turn-a',
              attachments: [],
            },
          })) as never,
        highWater: frozenHighWater ?? inputIds.length,
      }),
      issueCursor: (cursor) => {
        const token = `signed-${serial++}`;
        issued.set(token, cursor);
        return token;
      },
      readCursor: (token) => issued.get(token),
    });
    const preview = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    if (preview.status !== 'found') throw new Error('expected projection');
    const inputs = preview.projection.groups.find(
      (group) => group.id === 'inputs',
    )!;
    expect(inputs.items).toHaveLength(2);
    expect(inputs.continuation).toBeTruthy();
    // A later append belongs to a subsequent inventory read, never this page.
    inputIds.push('input-future');
    const page = await module.page({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      groupId: 'inputs',
      continuation: inputs.continuation,
      authority,
      current: () => true,
    });
    expect(page).toMatchObject({
      status: 'found',
      page: { group: { items: [{ eventId: 'input-2' }] } },
    });
    if (page.status !== 'found') throw new Error('expected page');
    expect(page.page.group.continuation).toBeUndefined();
    expect(page.page.group.items).not.toContainEqual(
      expect.objectContaining({ eventId: 'input-future' }),
    );
    await expect(
      module.page({
        scope: { kind: 'whole-session', sessionId: 'session-a' },
        groupId: 'inputs',
        continuation: 'tampered',
        authority,
        current: () => true,
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });
  test('kept replacement admits only exact stored provenance rows and keeps a bounded preview', async () => {
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
    });
    const base = await module.read({
      scope: { kind: 'kept-in-task', sessionId: 'session-a', taskId: 'task-a' },
      authority,
      current: () => true,
    });
    expect(base.status).toBe('found');
    if (base.status !== 'found') throw new Error('expected projection');
    const projected = withTaskKeptRows(base.projection, [
      {
        kind: 'task-kept-answer',
        key: 'a',
        owner: { owner: 'task', id: 'v1' },
        relations: ['kept-in-task'],
        taskId: 'task-a',
        provenanceSessionId: 'session-a',
        referenceId: 'turn:session-a/a',
      },
      {
        kind: 'task-kept-input',
        key: 'b',
        owner: { owner: 'task', id: 'v1' },
        relations: ['kept-in-task'],
        taskId: 'task-a',
        provenanceSessionId: 'session-a',
        referenceId: 'input:session-a/b',
      },
      {
        kind: 'task-kept-result',
        key: 'c',
        owner: { owner: 'task', id: 'v1' },
        relations: ['kept-in-task'],
        taskId: 'task-a',
        provenanceSessionId: 'session-a',
        referenceId: 'result:session-a/c',
      },
    ]);
    expect(projected.groups.find((group) => group.id === 'kept')).toMatchObject(
      {
        state: 'available',
        count: { kind: 'at-least', value: 3 },
        items: [
          expect.objectContaining({ provenanceSessionId: 'session-a' }),
          expect.objectContaining({ provenanceSessionId: 'session-a' }),
        ],
      },
    );
  });

  test('rejects a same-length historical descriptor mutation behind an inventory cursor', async () => {
    const issued = new Map<string, any>();
    const ids = ['input-0', 'input-1', 'input-2'];
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionEvents: (_sessionId, frozenHighWater) => ({
        events: ids.slice(0, frozenHighWater ?? ids.length).map((id) => ({
          id,
          method: 'turn.started',
          turnId: `turn-${id}`,
          attachments: [],
        })) as never,
        highWater: frozenHighWater ?? ids.length,
      }),
      issueCursor: (cursor) => {
        const token = `cursor-${issued.size}`;
        issued.set(token, cursor);
        return token;
      },
      readCursor: (token) => issued.get(token),
    });
    const preview = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    if (preview.status !== 'found') throw new Error('expected projection');
    const continuation = preview.projection.groups.find(
      (group) => group.id === 'inputs',
    )?.continuation;
    expect(continuation).toBeTruthy();
    ids[1] = 'input-mutated';
    await expect(
      module.page({
        scope: { kind: 'whole-session', sessionId: 'session-a' },
        groupId: 'inputs',
        continuation,
        authority,
        current: () => true,
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });

  test('follows bounded descriptor pages so target rows after unrelated history remain complete', async () => {
    const issued = new Map<string, any>();
    const unrelated = Array.from({ length: 4_000 }, (_, index) => ({
      id: `tool-${index}`,
      sequence: index + 1,
      method: 'tool.completed' as const,
      turnId: `turn-tool-${index}`,
      toolCallId: `call-${index}`,
      name: 'shell',
      terminalStatus: 'succeeded' as const,
    }));
    const targets = Array.from({ length: 3 }, (_, index) => ({
      id: `input-${index}`,
      sequence: index + 21,
      method: 'turn.started' as const,
      turnId: `turn-input-${index}`,
      attachments: [],
    }));
    const readWholeSessionEvents = vi.fn(
      (
        _sessionId: string,
        frozenHighWater: number | undefined,
        _continuation: { sequence: number; eventId: string } | undefined,
        group: string | undefined,
      ) => {
        // The owner receives only the requested group. Thousands of earlier
        // execution descriptors must never be scanned into an inputs read.
        expect(group).toBeDefined();
        return {
          events: (group === 'inputs' ? targets : []) as never,
          highWater: frozenHighWater ?? unrelated.length + targets.length,
        };
      },
    );
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionEvents,
      issueCursor: (cursor) => {
        const token = `cursor-${issued.size}`;
        issued.set(token, cursor);
        return token;
      },
      readCursor: (token) => issued.get(token),
    });
    const preview = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    if (preview.status !== 'found') throw new Error('expected projection');
    const inputs = preview.projection.groups.find(
      (group) => group.id === 'inputs',
    )!;
    expect(inputs).toMatchObject({
      count: { kind: 'at-least', value: 3 },
      items: [{ eventId: 'input-0' }, { eventId: 'input-1' }],
    });
    expect(readWholeSessionEvents).toHaveBeenCalledTimes(4);
    const page = await module.page({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      groupId: 'inputs',
      continuation: inputs.continuation,
      authority,
      current: () => true,
    });
    expect(page).toMatchObject({
      status: 'found',
      page: {
        group: {
          count: { kind: 'exact', value: 3 },
          items: [{ eventId: 'input-2' }],
        },
      },
    });
  });

  test('chains bounded input pages 2-preview then 20/20/5 without loading history', async () => {
    const issued = new Map<string, any>();
    const events = Array.from({ length: 47 }, (_, index) => ({
      id: `input-${index}`,
      sequence: index + 1,
      method: 'turn.started' as const,
      turnId: `turn-${index}`,
      attachments: [],
    }));
    const reads: number[] = [];
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionHighWater: () => 47,
      readWholeSessionEvents: (
        _session,
        highWater,
        start,
        group,
        limit = 2,
      ) => {
        reads.push(limit);
        const from = start ? start.sequence : 0;
        const rows = group === 'inputs' ? events.slice(from, from + limit) : [];
        const last = rows.at(-1);
        return {
          events: rows as never,
          highWater: highWater ?? 47,
          ...(last && last.sequence < 47
            ? { continuation: { sequence: last.sequence, eventId: last.id } }
            : {}),
        };
      },
      issueCursor: (cursor) => {
        const token = `cursor-${issued.size}`;
        issued.set(token, cursor);
        return token;
      },
      readCursor: (token) => issued.get(token),
    });
    const read = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    if (read.status !== 'found') throw new Error('expected read');
    let token = read.projection.groups.find(
      (group) => group.id === 'inputs',
    )!.continuation;
    const sizes: number[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = await module.page({
        scope: { kind: 'whole-session', sessionId: 'session-a' },
        groupId: 'inputs',
        continuation: token,
        authority,
        current: () => true,
      });
      if (result.status !== 'found') throw new Error('expected page');
      sizes.push(result.page.group.items.length);
      token = result.page.group.continuation;
    }
    expect(sizes).toEqual([20, 20, 5]);
    expect(reads.every((limit) => limit <= 20)).toBe(true);
  });

  test('keeps successful groups available when one bounded owner group fails', async () => {
    const module = createSessionInventoryModule({
      sessionOutputs: {
        list: vi.fn().mockResolvedValue({
          status: 'found',
          page: { version: 'session-outputs/v1', items: [], partial: false },
        }),
      } as never,
      canReadSession: () => true,
      readWholeSessionHighWater: () => 2,
      readWholeSessionEvents: (_session, highWater, _start, group) => {
        if (group === 'resources') throw new Error('store unavailable');
        return {
          events:
            group === 'inputs'
              ? ([
                  {
                    id: 'input',
                    sequence: 1,
                    method: 'turn.started',
                    turnId: 'turn-a',
                    attachments: [],
                  },
                ] as never)
              : [],
          highWater: highWater ?? 2,
        };
      },
    });
    const result = await module.read({
      scope: { kind: 'whole-session', sessionId: 'session-a' },
      authority,
      current: () => true,
    });
    if (result.status !== 'found') throw new Error('expected inventory');
    expect(
      result.projection.groups.find((group) => group.id === 'inputs'),
    ).toMatchObject({ state: 'available', items: [{ eventId: 'input' }] });
    expect(
      result.projection.groups.find((group) => group.id === 'resources'),
    ).toMatchObject({ state: 'unavailable', gaps: [{ kind: 'unavailable' }] });
  });

  test('pages 21 exact current-answer inputs through the answer owner', async () => {
    const issued = new Map<string, any>();
    const answer = currentAnswer(
      'turn-a',
      Array.from({ length: 21 }, (_, index) => ({
        eventId: `input-${index}`,
        kind: 'initial',
        prompt: 'never exposed',
        attachments: [],
      })),
    );
    const module = createSessionInventoryModule({
      sessionOutputs: { list: vi.fn() } as never,
      canReadSession: () => true,
      readExactAnswerBasis: vi.fn().mockResolvedValue(exactFound(answer)),
      issueCursor: (cursor) => {
        const token = `cursor-${issued.size}`;
        issued.set(token, cursor);
        return token;
      },
      readCursor: (token) => issued.get(token),
    });
    const scope = {
      kind: 'current-answer' as const,
      sessionId: 'session-a',
      turnId: 'turn-a',
    };
    const first = await module.page({
      scope,
      groupId: 'inputs',
      authority,
      current: () => true,
    });
    if (first.status !== 'found') throw new Error('expected page');
    expect(first.page.group.items).toHaveLength(20);
    expect(
      parseSessionInventoryProjection({
        version: 'station.session-inventory/v1',
        scope,
        basis: first.page.basis,
        basisBinding: first.page.basisBinding,
        groups: [
          'inputs',
          'sources',
          'execution',
          'decisions',
          'outputs',
          'verification-delivery',
          'live-now',
          'kept',
          'attention',
          'resources',
        ].map((id) =>
          id === 'inputs'
            ? {
                ...first.page.group,
                items: first.page.group.items.slice(0, 2),
                count: { kind: 'at-least', value: 21 },
              }
            : {
                id,
                owner: { owner: 'station.inventory', id: 'v1' },
                state: 'empty',
                count: { kind: 'exact', value: 0 },
                items: [],
                gaps: [],
              },
        ),
      }),
    ).not.toBeNull();
    const second = await module.page({
      scope,
      groupId: 'inputs',
      continuation: first.page.group.continuation,
      authority,
      current: () => true,
    });
    expect(second).toMatchObject({
      status: 'found',
      page: { group: { items: [{ eventId: 'input-20' }] } },
    });
  });

  test.each([
    ['inputs', 'found', 'found'],
    ['outputs', 'found', 'found'],
    ['sources', 'found', 'found'],
    ['inputs', 'not-found', 'not-found'],
    ['outputs', 'unavailable', 'unavailable'],
    ['sources', 'corrupt', 'unavailable'],
  ] as const)(
    'gates current-answer %s pages on one exact owner %s read',
    async (groupId, ownerStatus, expected) => {
      const readExactAnswerBasis = vi
        .fn()
        .mockResolvedValue(
          ownerStatus === 'found' ? exactFound() : { status: ownerStatus },
        );
      const module = createSessionInventoryModule({
        sessionOutputs: { list: vi.fn() } as never,
        canReadSession: () => true,
        readExactAnswerBasis,
      });
      const result = await module.page({
        scope: {
          kind: 'current-answer',
          sessionId: 'session-a',
          turnId: 'turn-a',
        },
        groupId,
        authority,
        current: () => true,
      });
      expect(result.status).toBe(expected);
      expect(readExactAnswerBasis).toHaveBeenCalledTimes(1);
    },
  );

  test('fails closed when current-answer authority is lost during its page owner read', async () => {
    let current = true;
    const module = createSessionInventoryModule({
      sessionOutputs: { list: vi.fn() } as never,
      canReadSession: () => current,
      readExactAnswerBasis: vi.fn().mockImplementation(async () => {
        current = false;
        return exactFound();
      }),
    });
    await expect(
      module.page({
        scope: {
          kind: 'current-answer',
          sessionId: 'session-a',
          turnId: 'turn-a',
        },
        groupId: 'inputs',
        authority,
        current: () => current,
      }),
    ).resolves.toEqual({ status: 'not-found' });
  });
});
