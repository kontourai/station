import { join } from 'node:path';
import { STATION_COMPAT_PROTOCOL_VERSION } from '@kontourai/station-contracts/environment-security';
import { parseSessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { settleUnresolvedClaudeToolCalls } from '../../../providers/adapters/claude-adapter-events.js';
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
});
