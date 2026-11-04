import { join } from 'node:path';
import { STATION_COMPAT_PROTOCOL_VERSION } from '@kontourai/station-contracts/environment-security';
import { parseSessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  mapClaudeSdkMessage,
  settleUnresolvedClaudeToolCalls,
} from '../../../providers/adapters/claude-adapter-events.js';
import { UNRESOLVED_TOOL_OUTPUT } from '../../../providers/adapters/unresolved-tool-output.js';
import { EventStore } from '../event-store.js';
import {
  createSessionInventoryModule,
  UNRESOLVED_TOOL_RESULT_CLIENT_PROTOCOL,
} from '../session-inventory-module.js';

const tempRoot = trackTempDirs();
const THREAD = 'station:1:session:crashed-turn';

/**
 * The owner's crash, in a real store: one command reported a result, then the
 * engine process exited with two still open. The Claude adapter's own
 * settlement writes those two as `tool.completed` with status `unresolved`.
 */
function seedCrashedTurn(store: EventStore) {
  store.appendEvent({
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-10-24T16:00:00.000Z',
    eventId: 'start',
    turnId: 'turn-1',
    method: 'turn.started',
    prompt: 'Run the checks',
    attachments: [],
  } as never);
  store.appendEvent({
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-10-24T16:00:01.000Z',
    eventId: 'done',
    turnId: 'turn-1',
    itemId: 'call-done',
    method: 'tool.completed',
    toolCallId: 'call-done',
    toolName: 'Bash',
    status: 'success',
    output: 'ok',
  } as never);
  settleUnresolvedClaudeToolCalls({
    provider: 'claude',
    record: {
      session: { threadId: THREAD },
      activeToolCalls: new Map([
        ['call-open-1', { toolName: 'Bash', turnId: 'turn-1' }],
        ['call-open-2', { toolName: 'Read', turnId: 'turn-1' }],
      ]),
    } as never,
    publish: (event) => store.appendEvent(event),
    createdAt: '2026-10-24T16:00:02.000Z',
  });
}

/**
 * The Execution group as a client sees it: the first read's preview, then
 * every page the UI's "load more" would fetch, until the owner says exact.
 */
async function readExecution(
  store: EventStore,
  clientProtocol: number,
  from: 'preview' | 'page' = 'preview',
  /** Runs after each page, before the next is requested. */
  afterPage?: (page: number) => void,
) {
  const issued = new Map<string, unknown>();
  let serial = 0;
  const module = createSessionInventoryModule({
    sessionOutputs: {
      list: vi.fn().mockResolvedValue({
        status: 'found',
        page: { version: 'session-outputs/v1', items: [], partial: false },
      }),
    } as never,
    canReadSession: () => true,
    readWholeSessionEvents: (
      sessionId,
      frozenHighWater,
      continuation,
      group,
      limit,
    ) =>
      store.listSessionInventoryEvents(sessionId, {
        frozenHighWater,
        continuation,
        group,
        limit,
      }),
    issueCursor: (cursor) => {
      const token = `cursor-${serial++}`;
      issued.set(token, cursor);
      return token;
    },
    readCursor: (token) => issued.get(token) as never,
  });
  const scope = { kind: 'whole-session' as const, sessionId: THREAD };
  const authority = sessionReadAuthorityFromRequest(
    'owner',
    undefined,
    undefined,
  );
  if (from === 'page') {
    // "Load more" from the group itself: the first page carries no cursor.
    const rows: unknown[][] = [];
    let continuation: string | undefined;
    let finalCount: unknown;
    let pages = 0;
    do {
      const page = await module.page({
        scope,
        authority,
        current: () => true,
        clientProtocol,
        groupId: 'execution',
        ...(continuation ? { continuation } : {}),
      });
      if (page.status !== 'found')
        throw new Error(`expected page ${pages + 1}, got ${page.status}`);
      pages += 1;
      afterPage?.(pages);
      for (const item of page.page.group.items)
        rows.push(
          item.kind === 'thread-tool-result'
            ? [item.toolCallId, item.terminalStatus]
            : [item.kind],
        );
      continuation = page.page.group.continuation;
      finalCount = page.page.group.count;
    } while (continuation && pages < 10);
    return { rows, finalCount, pages };
  }
  const result = await module.read({
    scope,
    authority,
    current: () => true,
    clientProtocol,
  });
  if (result.status !== 'found') throw new Error('expected projection');
  // What a client receives must still parse under the published contract.
  expect(
    parseSessionInventoryProjection(
      JSON.parse(JSON.stringify(result.projection)),
    ),
  ).not.toBeNull();
  let group = result.projection.groups.find((item) => item.id === 'execution');
  if (!group) throw new Error('expected an execution group');
  const rows = [...group.items];
  for (let guard = 0; group.continuation && guard < 10; guard += 1) {
    const page = await module.page({
      scope,
      authority,
      current: () => true,
      clientProtocol,
      groupId: 'execution',
      continuation: group.continuation,
    });
    if (page.status !== 'found')
      throw new Error(`expected a page, got ${page.status}`);
    group = page.page.group;
    rows.push(...group.items);
  }
  return {
    rows: rows.map((item) =>
      item.kind === 'thread-tool-result'
        ? [item.toolCallId, item.terminalStatus]
        : [item.kind],
    ),
    finalCount: group.count,
  };
}

describe('Session inventory commands with no recorded result (#4178)', () => {
  test('lists and counts them for a protocol-4 client, and omits them for older clients', async () => {
    expect(UNRESOLVED_TOOL_RESULT_CLIENT_PROTOCOL).toBe(4);
    expect(STATION_COMPAT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(
      UNRESOLVED_TOOL_RESULT_CLIENT_PROTOCOL,
    );
    const store = new EventStore(
      join(tempRoot('station-inventory-unresolved-'), 'orchestration.sqlite'),
    );
    try {
      seedCrashedTurn(store);

      const current = await readExecution(store, 4);
      // Every command is listed and counted, as the transcript's
      // "2 with no result" beside one result says.
      expect(current.rows).toEqual([
        ['call-done', 'succeeded'],
        ['call-open-1', 'unresolved'],
        ['call-open-2', 'unresolved'],
      ]);
      expect(current.finalCount).toEqual({ kind: 'exact', value: 3 });

      // A client built before the member validates the vocabulary exactly,
      // so it keeps the omission and a projection it can parse.
      for (const older of [1, 3]) {
        const legacy = await readExecution(store, older);
        expect(legacy.rows).toEqual([['call-done', 'succeeded']]);
        expect(legacy.finalCount).toEqual({ kind: 'exact', value: 1 });
      }
    } finally {
      store.close?.();
    }
  });

  test('pages past omitted commands for an older client, and through them for a current one', async () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-unresolved-'), 'orchestration.sqlite'),
    );
    try {
      seedCrashedTurn(store);
      // Enough later results that Execution spans three owner pages of 20
      // events, with omitted commands inside the first and the second.
      for (let index = 0; index < 42; index += 1) {
        // A third command left open inside the second page.
        if (index === 25)
          settleUnresolvedClaudeToolCalls({
            provider: 'claude',
            record: {
              session: { threadId: THREAD },
              activeToolCalls: new Map([
                ['call-open-3', { toolName: 'Bash', turnId: 'turn-1' }],
              ]),
            } as never,
            publish: (event) => store.appendEvent(event),
            createdAt: '2026-10-24T16:01:25.500Z',
          });
        store.appendEvent({
          provider: 'claude',
          threadId: THREAD,
          createdAt: `2026-10-24T16:01:${String(index).padStart(2, '0')}.000Z`,
          eventId: `later-${index}`,
          turnId: 'turn-1',
          itemId: `call-later-${index}`,
          method: 'tool.completed',
          toolCallId: `call-later-${index}`,
          toolName: 'Bash',
          status: 'success',
          output: 'ok',
        } as never);
      }

      const legacy = await readExecution(store, 3, 'page');
      expect(legacy.pages).toBe(3);
      expect(legacy.rows).toHaveLength(43);
      expect(legacy.rows.some(([, status]) => status === 'unresolved')).toBe(
        false,
      );
      expect(legacy.finalCount).toEqual({ kind: 'exact', value: 43 });

      const current = await readExecution(store, 4, 'page');
      expect(current.rows).toHaveLength(46);
      expect(
        current.rows.filter(([, status]) => status === 'unresolved'),
      ).toHaveLength(3);
    } finally {
      store.close?.();
    }
  });

  test('lists a call once when its real result arrives after the session-end settle', async () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-unresolved-'), 'orchestration.sqlite'),
    );
    try {
      store.appendEvent({
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-10-24T16:00:00.000Z',
        eventId: 'start',
        turnId: 'turn-1',
        method: 'turn.started',
        prompt: 'Run the checks',
        attachments: [],
      } as never);
      // One adapter record across both writes, as in a session whose stop
      // grace elapsed while the SDK still held the result (station#1569).
      const record = {
        session: { threadId: THREAD },
        activeToolCalls: new Map([
          ['call-late', { toolName: 'Task', turnId: 'turn-1' }],
          ['call-open', { toolName: 'Bash', turnId: 'turn-1' }],
        ]),
      } as never;
      const publish = (event: Parameters<typeof store.appendEvent>[0]) =>
        store.appendEvent(event);
      settleUnresolvedClaudeToolCalls({
        provider: 'claude',
        record,
        publish,
        createdAt: '2026-10-24T16:00:02.000Z',
      });
      mapClaudeSdkMessage({
        provider: 'claude',
        record,
        publish,
        message: {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call-late', content: 'ok' },
            ],
          },
        } as never,
      });
      // Reached: the store holds both completions for the late call.
      const storedLate = (
        store as unknown as {
          db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
        }
      ).db
        .prepare(
          `SELECT json_extract(payload, '$.status') AS status
             FROM orchestration_events
            WHERE thread_id = ? AND method = 'tool.completed'
              AND json_extract(payload, '$.toolCallId') = 'call-late'
            ORDER BY sequence`,
        )
        .all(THREAD);
      expect(storedLate).toEqual([
        { status: 'unresolved' },
        { status: 'success' },
      ]);

      // The transcript shows the late call succeeded and one call with no
      // result; the inventory says the same.
      const current = await readExecution(store, 4);
      expect(current.rows).toEqual([
        ['call-open', 'unresolved'],
        ['call-late', 'succeeded'],
      ]);
      expect(current.finalCount).toEqual({ kind: 'exact', value: 2 });
    } finally {
      store.close?.();
    }
  });

  test.each([
    ['the same store serves page 2', false],
    // A restart, another instance, or a cache eviction: nothing remembers
    // page 1's answer, so page 2 must re-derive it from the frozen read.
    ['a freshly opened store serves page 2', true],
  ] as const)(
    'a late result arriving between pages does not break the continuation: %s',
    async (_label, reopen) => {
      const path = join(
        tempRoot('station-inventory-unresolved-'),
        'orchestration.sqlite',
      );
      const store = new EventStore(path);
      let serving = store;
      let reopened: EventStore | undefined;
      const reader = {
        listSessionInventoryEvents: (
          ...args: Parameters<EventStore['listSessionInventoryEvents']>
        ) => serving.listSessionInventoryEvents(...args),
      } as unknown as EventStore;
      try {
        seedCrashedTurn(store);
        for (let index = 0; index < 25; index += 1)
          store.appendEvent({
            provider: 'claude',
            threadId: THREAD,
            createdAt: `2026-10-24T16:01:${String(index).padStart(2, '0')}.000Z`,
            eventId: `later-${index}`,
            turnId: 'turn-1',
            itemId: `call-later-${index}`,
            method: 'tool.completed',
            toolCallId: `call-later-${index}`,
            toolName: 'Bash',
            status: 'success',
            output: 'ok',
          } as never);
        const result = await readExecution(reader, 4, 'page', (page) => {
          if (page !== 1) return;
          // After page 1 listed call-open-1 as unresolved, its result lands.
          store.appendEvent({
            provider: 'claude',
            threadId: THREAD,
            createdAt: '2026-10-24T16:02:00.000Z',
            eventId: 'late-open-1',
            turnId: 'turn-1',
            itemId: 'call-open-1',
            method: 'tool.completed',
            toolCallId: 'call-open-1',
            toolName: 'Bash',
            status: 'success',
            output: 'ok',
          } as never);
          if (reopen) {
            reopened = new EventStore(path);
            serving = reopened;
          }
        });
        // The read stays the snapshot it started as: page 2 is served, and
        // the late event (above the frozen watermark) belongs to a fresh read.
        expect(result.pages).toBe(2);
        expect(result.rows).toHaveLength(28);
        expect(result.rows).toContainEqual(['call-open-1', 'unresolved']);
        const fresh = await readExecution(store, 4, 'page');
        expect(fresh.rows).not.toContainEqual(['call-open-1', 'unresolved']);
        expect(fresh.rows).toContainEqual(['call-open-1', 'succeeded']);
      } finally {
        reopened?.close?.();
        store.close?.();
      }
    },
  );

  function turnStart(turnId: string) {
    return {
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-10-24T16:00:01.000Z',
      eventId: `start-${turnId}`,
      turnId,
      method: 'turn.started',
      prompt: 'Again',
      attachments: [],
    } as never;
  }

  /** One tool lifecycle event in the shape the adapters write. */
  function toolEvent(
    eventId: string,
    turnId: string,
    method: 'tool.started' | 'tool.completed',
    status?: 'success' | 'unresolved',
  ) {
    return {
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-10-24T16:00:01.000Z',
      eventId,
      turnId,
      itemId: 'call-x',
      method,
      toolCallId: 'call-x',
      toolName: 'Bash',
      ...(status
        ? {
            status,
            output: status === 'unresolved' ? UNRESOLVED_TOOL_OUTPUT : 'ok',
          }
        : {}),
    } as never;
  }

  test.each([
    [
      'a late result replaces the unresolved row',
      [
        toolEvent('s1', 'turn-1', 'tool.started'),
        toolEvent('u1', 'turn-1', 'tool.completed', 'unresolved'),
        toolEvent('late', 'turn-1', 'tool.completed', 'success'),
      ],
      [['call-x', 'succeeded']],
    ],
    [
      'a new start in between claims the later result',
      [
        toolEvent('s1', 'turn-1', 'tool.started'),
        toolEvent('u1', 'turn-1', 'tool.completed', 'unresolved'),
        toolEvent('s2', 'turn-1', 'tool.started'),
        toolEvent('done', 'turn-1', 'tool.completed', 'success'),
      ],
      [
        ['call-x', 'unresolved'],
        ['call-x', 'succeeded'],
      ],
    ],
    [
      'a second unresolved in between is the row a late result would replace',
      [
        toolEvent('u1', 'turn-1', 'tool.completed', 'unresolved'),
        turnStart('turn-2'),
        toolEvent('u2', 'turn-2', 'tool.completed', 'unresolved'),
        toolEvent('late', 'turn-1', 'tool.completed', 'success'),
      ],
      [
        ['call-x', 'unresolved'],
        ['call-x', 'unresolved'],
        ['call-x', 'succeeded'],
      ],
    ],
    [
      'a start in between claims only the next completion; the one after still replaces',
      [
        toolEvent('s1', 'turn-1', 'tool.started'),
        toolEvent('u1', 'turn-1', 'tool.completed', 'unresolved'),
        toolEvent('s2', 'turn-1', 'tool.started'),
        toolEvent('done', 'turn-1', 'tool.completed', 'success'),
        toolEvent('late', 'turn-1', 'tool.completed', 'success'),
      ],
      [
        ['call-x', 'succeeded'],
        ['call-x', 'succeeded'],
      ],
    ],
    [
      'a result for another turn is skipped, and the late result still replaces',
      [
        toolEvent('s1', 'turn-1', 'tool.started'),
        toolEvent('u1', 'turn-1', 'tool.completed', 'unresolved'),
        turnStart('turn-2'),
        toolEvent('other', 'turn-2', 'tool.completed', 'success'),
        toolEvent('late', 'turn-1', 'tool.completed', 'success'),
      ],
      [
        ['call-x', 'succeeded'],
        ['call-x', 'succeeded'],
      ],
    ],
  ] as const)(
    'agrees with the transcript when one call id recurs: %s',
    async (_label, events, expected) => {
      const store = new EventStore(
        join(tempRoot('station-inventory-unresolved-'), 'orchestration.sqlite'),
      );
      try {
        store.appendEvent({
          provider: 'claude',
          threadId: THREAD,
          createdAt: '2026-10-24T16:00:00.000Z',
          eventId: 'start-1',
          turnId: 'turn-1',
          method: 'turn.started',
          prompt: 'Run the checks',
          attachments: [],
        } as never);
        for (const event of events) store.appendEvent(event);
        // The transcript's own fold of the same stored events.
        const transcript = projectRuntimeEventsToMessages(
          store.listEventPayloads(THREAD),
        )
          .flatMap((message) => message.parts)
          .filter((part) => part.type === 'tool-invocation')
          .map((part) => (part.state === 'unresolved' ? 'unresolved' : 'other'))
          .sort();
        const current = await readExecution(store, 4);
        expect(current.rows).toEqual(expected);
        expect(
          current.rows
            .map(([, status]) =>
              status === 'unresolved' ? 'unresolved' : 'other',
            )
            .sort(),
        ).toEqual(transcript);
      } finally {
        store.close?.();
      }
    },
  );

  test.each([
    ['through the same store', false],
    // Another connection or process: nothing local hears about the delete.
    ['through another connection', true],
  ] as const)(
    'a thread deleted and recreated under the same id is read afresh, %s',
    async (_label, elsewhere) => {
      const path = join(
        tempRoot('station-inventory-unresolved-'),
        'orchestration.sqlite',
      );
      const store = new EventStore(path);
      const other = elsewhere ? new EventStore(path) : undefined;
      const unresolvedCall = (eventId: string, toolCallId: string) =>
        ({
          provider: 'claude',
          threadId: THREAD,
          createdAt: '2026-10-24T16:00:01.000Z',
          eventId,
          turnId: 'turn-1',
          itemId: toolCallId,
          method: 'tool.completed',
          toolCallId,
          toolName: 'Bash',
          status: 'unresolved',
          output: UNRESOLVED_TOOL_OUTPUT,
        }) as never;
      const start = (eventId: string) =>
        ({
          provider: 'claude',
          threadId: THREAD,
          createdAt: '2026-10-24T16:00:00.000Z',
          eventId,
          turnId: 'turn-1',
          method: 'turn.started',
          prompt: 'Run it',
          attachments: [],
        }) as never;
      try {
        store.appendEvent(start('first-start'));
        store.appendEvent(unresolvedCall('first-open', 'call-first'));
        expect((await readExecution(store, 4)).rows).toEqual([
          ['call-first', 'unresolved'],
        ]);
        // Same id, same number of events: the per-thread marks repeat.
        const writer = other ?? store;
        writer.deleteThread(THREAD);
        writer.appendEvent(start('second-start'));
        writer.appendEvent(unresolvedCall('second-open', 'call-second'));
        expect((await readExecution(store, 4)).rows).toEqual([
          ['call-second', 'unresolved'],
        ]);
      } finally {
        other?.close?.();
        store.close?.();
      }
    },
  );

  test('the transcript check reads only events at or below the frozen mark, even with nothing cached', () => {
    const store = new EventStore(
      join(tempRoot('station-inventory-unresolved-'), 'orchestration.sqlite'),
    );
    try {
      seedCrashedTurn(store);
      const { highWater } = store.listSessionInventoryEvents(THREAD, {
        group: 'execution',
      });
      // call-open-1's result lands after the read's mark.
      store.appendEvent({
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-10-24T16:02:00.000Z',
        eventId: 'late-open-1',
        turnId: 'turn-1',
        itemId: 'call-open-1',
        method: 'tool.completed',
        toolCallId: 'call-open-1',
        toolName: 'Bash',
        status: 'success',
        output: 'ok',
      } as never);
      // Model an eviction: the answer must be re-derived, not remembered.
      (
        store as unknown as { standingUnresolvedCache: Map<string, unknown> }
      ).standingUnresolvedCache.clear();
      const atMark = store.standingUnresolvedCompletionIds(THREAD, highWater);
      const openOne = store
        .listEventPayloads(THREAD)
        .find(
          (event) =>
            event.method === 'tool.completed' &&
            'toolCallId' in event &&
            event.toolCallId === 'call-open-1' &&
            'status' in event &&
            event.status === 'unresolved',
        );
      if (!openOne) throw new Error('the settle did not write call-open-1');
      expect(atMark.has(openOne.eventId)).toBe(true);
      // And a read at the new mark sees the late result replace it.
      expect(
        store
          .standingUnresolvedCompletionIds(
            THREAD,
            store.listSessionInventoryEvents(THREAD, { group: 'execution' })
              .highWater,
          )
          .has(openOne.eventId),
      ).toBe(false);
    } finally {
      store.close?.();
    }
  });
});
