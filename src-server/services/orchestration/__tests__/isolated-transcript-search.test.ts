import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import {
  createIsolatedTranscriptReads,
  type IsolatedTranscriptReads,
} from '../../search/isolated-transcript-search.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { createIsolatedSessionTranscriptSearch } from '../isolated-session-transcript-search.js';
import { OrchestrationService } from '../orchestration-service.js';
import { SessionAuthorization } from '../session-authorization.js';
import { SessionTranscriptReads } from '../session-transcript-reads.js';
import {
  queryTranscriptMessages,
  TranscriptReadLimitError,
} from '../transcript-search-queries.js';

const roots: string[] = [];
const stores: EventStore[] = [];
const readers: IsolatedTranscriptReads[] = [];
const services: OrchestrationService[] = [];
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'station-transcript-read-'));
  roots.push(directory);
  return directory;
}
function storeAt(directory = root()) {
  const store = new EventStore(join(directory, 'events.sqlite'));
  stores.push(store);
  return store;
}
function populate(
  store: EventStore,
  threadId = 'thread-a',
  owner = 'user-a',
  prompt = 'Find cobalt albatross 中文内容',
  tenant?: string,
) {
  if (tenant)
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
      tenantExecutionContext: { tenantId: tenantId(tenant), source: 'session' },
    });
  store.appendEvent({
    eventId: `${threadId}:start`,
    provider: 'claude',
    threadId,
    createdAt: '2026-09-03T00:00:00.000Z',
    method: 'session.started',
    sessionId: threadId,
    metadata: { userId: owner, agentSlug: 'claude', projectSlug: 'project-a' },
  });
  store.appendEvent({
    eventId: `${threadId}:turn`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}:turn-id`,
    createdAt: '2026-09-03T00:00:01.000Z',
    method: 'turn.started',
    prompt,
  });
  store.appendEvent({
    eventId: `${threadId}:end`,
    provider: 'claude',
    threadId,
    turnId: `${threadId}:turn-id`,
    createdAt: '2026-09-03T00:00:02.000Z',
    method: 'turn.completed',
    outputText: 'The cobalt albatross is here.',
  });
}
const personal = (user = 'user-a') =>
  sessionReadAuthorityFromRequest(user, undefined, undefined);
function syncReads(store: EventStore, authz: SessionAuthorization) {
  return new SessionTranscriptReads({
    canReadSession: (thread, authority) =>
      authz.canReadSession(thread, authority),
    isEphemeralSession: () => false,
    sessionAttributionFor: () => null,
    listEventPayloads: () => [],
    listUsageEventRecords: () => [],
    listUsageReceiptEvents: () => [],
    listUsageCoverageEvents: () => [],
    searchConversationMessages: (input) =>
      store.searchConversationMessages(input),
    readSessionThreadIds: () => [],
    requireTenantExecutionContext: () => false,
    reportDroppedUsageFigure: () => {},
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const reader of readers.splice(0)) {
    await reader.close();
    await expect.poll(() => reader.inspect().phase).toBe('closed');
  }
  for (const store of stores.splice(0))
    await expect.poll(() => store.close().kind).toBe('closed');
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('isolated transcript read owner and existing session policy', () => {
  test('real indexed SQL, message identity, CJK and excerpts match the existing owner API', async () => {
    const store = storeAt();
    populate(store);
    populate(store, 'other', 'user-b');
    const authz = new SessionAuthorization({
      eventStore: store,
      ownerlessSessionAccess: 'deny',
    });
    const reads = syncReads(store, authz);
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    const isolated = reads.createIsolatedSearch(source, authz, () => true);
    for (const query of ['cobalt albatross', '中文', '!!!']) {
      const expected = reads.searchSessionMessages(query, personal());
      expect(
        await isolated.search({
          query,
          authority: personal(),
          current: () => true,
        }),
      ).toEqual({ state: 'available', matches: expected });
    }
    expect(
      await isolated.search({
        query: 'cobalt',
        authority: personal('not-owner'),
        current: () => true,
      }),
    ).toEqual({ state: 'available', matches: [] });
  });

  test('production OrchestrationService factory uses its single authority with no main-thread FTS or cold owner read', async () => {
    const store = storeAt();
    const service = new OrchestrationService({
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    });
    services.push(service);
    expect(() => service.createIsolatedTranscriptSearch()).toThrow(
      'Initialize',
    );
    service.initialize();
    const isolated = service.createIsolatedTranscriptSearch();
    await expect
      .poll(
        async () =>
          (
            await isolated.search({
              query: 'cobalt',
              authority: personal(),
              current: () => true,
            })
          ).state,
      )
      .toBe('available');
    // Add after recovery: this Session's owner has never entered the runtime cache.
    populate(store, 'fresh-after-recovery');
    const syncFts = vi
      .spyOn(store, 'searchConversationMessages')
      .mockImplementation(() => {
        throw new Error('main-thread FTS forbidden');
      });
    const syncOwner = vi
      .spyOn(store, 'findSessionOwnerUserId')
      .mockImplementation(() => {
        throw new Error('main-thread owner lookup forbidden');
      });
    const result = await isolated.search({
      query: 'cobalt',
      authority: personal(),
      current: () => true,
    });
    expect(result).toMatchObject({
      state: 'available',
      matches: [
        expect.objectContaining({ conversationId: 'fresh-after-recovery' }),
        expect.objectContaining({ conversationId: 'fresh-after-recovery' }),
      ],
    });
    expect(syncFts).not.toHaveBeenCalled();
    expect(syncOwner).not.toHaveBeenCalled();
    syncFts.mockRestore();
    syncOwner.mockRestore();
  }, 15_000);

  test('async cold-cache policy preserves personal legacy bridge, ownerless, and hosted decisions', async () => {
    const store = storeAt();
    populate(store, 'legacy', 'released-alias');
    populate(store, 'ordinary');
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: tenantId('alpha'), authority: 'alpha.test' },
        { id: tenantId('beta'), authority: 'beta.test' },
      ],
    });
    const local = sessionReadAuthorityFromRequest(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      undefined,
      undefined,
      { localHomePossession: true },
    );
    const cases = [
      { thread: 'legacy', authority: local, allowOwnerless: false },
      {
        thread: 'legacy',
        authority: personal('released-alias'),
        allowOwnerless: false,
      },
      {
        thread: 'legacy',
        authority: personal(LOCAL_OPERATOR_PRINCIPAL_ID),
        allowOwnerless: false,
      },
      { thread: 'ordinary', authority: personal(), allowOwnerless: false },
      {
        thread: 'ordinary',
        authority: personal('wrong'),
        allowOwnerless: false,
      },
      { thread: 'missing', authority: personal(), allowOwnerless: true },
      { thread: 'missing', authority: personal(), allowOwnerless: false },
    ];
    for (const item of cases) {
      const options = {
        eventStore: store,
        legacyPersonalOwner: 'released-alias',
        ownerlessSessionAccess: item.allowOwnerless
          ? ('single-user-compat' as const)
          : ('deny' as const),
      };
      const expected = new SessionAuthorization(options).canReadSession(
        item.thread,
        item.authority,
      );
      const actual = new SessionAuthorization(options);
      expect(
        await actual.canReadSessionAsync(
          item.thread,
          item.authority,
          () => true,
        ),
      ).toBe(expected);
    }
    const authz = new SessionAuthorization({
      eventStore: store,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (context) =>
        context?.tenantId === 'alpha' ? context : undefined,
    });
    authz.bindTenantContext('ordinary', {
      tenantId: tenantId('alpha'),
      source: 'session',
    });
    for (const id of ['alpha', 'beta']) {
      const authority = sessionReadAuthorityFromRequest(
        'user-a',
        { tenantId: tenantId(id) },
        registry,
      );
      expect(
        await authz.canReadSessionAsync('ordinary', authority, () => true),
      ).toBe(authz.canReadSession('ordinary', authority));
    }
  });

  test('read and authorization stay bound to the same construction-time EventStore', async () => {
    const original = storeAt();
    populate(original, 'same-thread', 'user-a', 'cobalt original');
    const peer = storeAt();
    populate(peer, 'same-thread', 'user-a', 'cobalt peer');
    const options = {
      eventStore: original,
      adoptionLedger: original.createAdoptionLedger(),
      eventBus: new EventBus(),
      adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
      logger: { debug() {}, warn() {} },
    };
    const service = new OrchestrationService(options);
    services.push(service);
    service.initialize();
    options.eventStore = peer;
    const search = service.createIsolatedTranscriptSearch();
    let result: Awaited<ReturnType<typeof search.search>> = {
      state: 'unavailable',
    };
    await expect
      .poll(async () => {
        result = await search.search({
          query: 'cobalt',
          authority: personal(),
          current: () => true,
        });
        return result.state;
      })
      .toBe('available');
    expect(result).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ excerpt: 'cobalt original' }),
      ]),
    });
    expect(result).not.toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({ excerpt: 'cobalt peer' }),
      ]),
    });
  });

  test('hosted FTS and post-read policy retain exact tenant and refuse missing tenant context', async () => {
    const store = storeAt();
    populate(store, 'alpha-thread', 'user-a', 'cobalt', 'alpha');
    populate(store, 'beta-thread', 'user-a', 'cobalt', 'beta');
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: tenantId('alpha'), authority: 'alpha.test' },
        { id: tenantId('beta'), authority: 'beta.test' },
      ],
    });
    const authz = new SessionAuthorization({
      eventStore: store,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (context) => context,
    });
    authz.bindTenantContext('alpha-thread', {
      tenantId: tenantId('alpha'),
      source: 'session',
    });
    authz.bindTenantContext('beta-thread', {
      tenantId: tenantId('beta'),
      source: 'session',
    });
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    const search = createIsolatedSessionTranscriptSearch(
      source,
      authz,
      () => true,
    );
    const result = await search.search({
      query: 'cobalt',
      authority: sessionReadAuthorityFromRequest(
        'user-a',
        { tenantId: tenantId('alpha') },
        registry,
      ),
      current: () => true,
    });
    expect(result).toMatchObject({
      state: 'available',
      matches: [
        expect.objectContaining({ conversationId: 'alpha-thread' }),
        expect.objectContaining({ conversationId: 'alpha-thread' }),
      ],
    });
    expect(
      await search.search({
        query: 'cobalt',
        authority: sessionReadAuthorityFromRequest(
          'user-a',
          undefined,
          registry,
        ),
        current: () => true,
      }),
    ).toEqual({ state: 'unavailable' });
  });

  test.each(['owner', 'tenant', 'principal'])(
    '%s invalidation while a real cold owner read is withheld refuses publication and stale caching',
    async (change) => {
      const store = storeAt();
      populate(store);
      const source = store.createIsolatedTranscriptReads();
      readers.push(source);
      const authz = new SessionAuthorization({ eventStore: store });
      const release = deferred<string | undefined>();
      const entered = deferred<void>();
      const realOwnerRead = source.readOwner;
      const lookup = vi
        .spyOn(source, 'readOwner')
        .mockImplementationOnce(async (id, signal) => {
          const owner = await realOwnerRead(id, signal);
          entered.resolve();
          await release.promise;
          return owner;
        });
      let principalCurrent = true;
      const search = createIsolatedSessionTranscriptSearch(
        source,
        authz,
        () => true,
      );
      const pending = search.search({
        query: 'cobalt',
        authority: personal(),
        current: () => principalCurrent,
      });
      await entered.promise;
      if (change === 'owner') authz.invalidateSessionOwner('thread-a');
      if (change === 'tenant') {
        authz.bindTenantContext('thread-a', {
          tenantId: tenantId('other'),
          source: 'session',
        });
        authz.forgetTenantContext('thread-a');
      }
      if (change === 'principal') principalCurrent = false;
      release.resolve(undefined);
      expect(await pending).toEqual({ state: 'unavailable' });
      principalCurrent = true;
      const calls = lookup.mock.calls.length;
      expect(
        await search.search({
          query: 'cobalt',
          authority: personal(),
          current: () => true,
        }),
      ).toMatchObject({ state: 'available' });
      expect(lookup.mock.calls.length).toBeGreaterThan(calls);
    },
  );

  test('missing database and schema are unavailable; readonly worker creates no database or migrations', async () => {
    const directory = root();
    const missing = join(directory, 'absent', 'events.sqlite');
    const absent = createIsolatedTranscriptReads(missing);
    readers.push(absent);
    await expect(
      absent.search({ query: 'cobalt', ownerUserId: 'user-a', limit: 20 }),
    ).rejects.toThrow('unavailable');
    expect(existsSync(join(directory, 'absent'))).toBe(false);
    const path = join(directory, 'empty.sqlite');
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE sentinel(value TEXT)');
    database.close();
    const before = readFileSync(path);
    const empty = createIsolatedTranscriptReads(path);
    readers.push(empty);
    await expect(
      empty.search({ query: 'cobalt', ownerUserId: 'user-a', limit: 20 }),
    ).rejects.toThrow('unavailable');
    expect(readFileSync(path)).toEqual(before);
  });

  test('oversized content and owner facts fail unavailable instead of ownerless authorization', async () => {
    const directory = root();
    const store = storeAt(directory);
    populate(store, 'large', 'user-a', 'cobalt');
    populate(store, 'large-owner', 'x'.repeat(257));
    // Fault-inject historical projection bytes beyond today's ingress ceiling.
    const legacy = new DatabaseSync(join(directory, 'events.sqlite'));
    try {
      legacy
        .prepare(
          'UPDATE orchestration_message_search_v3 SET content = ? WHERE thread_id = ?',
        )
        .run(`cobalt ${'x'.repeat(131072)}`, 'large');
    } finally {
      legacy.close();
    }
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    await expect(
      source.search({ query: 'cobalt', ownerUserId: 'user-a', limit: 20 }),
    ).rejects.toThrow('unavailable');
    const authz = new SessionAuthorization({
      eventStore: store,
      ownerlessSessionAccess: 'single-user-compat',
    });
    await expect(
      authz.canReadSessionAsync('large-owner', personal(), () => true),
    ).rejects.toThrow('unavailable');
  });

  test('EventStore close fences and retains the exact active read until the worker is gone', async () => {
    const store = storeAt();
    populate(store);
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    const pending = source.search({
      query: 'cobalt',
      ownerUserId: 'user-a',
      limit: 20,
    });
    const result = pending.catch(() => 'refused');
    expect(store.close()).toEqual({ kind: 'pending' });
    expect(() => store.createIsolatedTranscriptReads()).toThrow('closing');
    expect(await result).toBe('refused');
    await expect.poll(() => store.close().kind).toBe('closed');
    expect(source.inspect()).toEqual({ phase: 'closed' });
  });

  test.each(['created_at', 'turn_anchor_id', 'role'] as const)(
    'bounds %s in SQLite before JavaScript materialization without rewriting identity',
    async (field) => {
      const directory = root();
      const store = storeAt(directory);
      // Only the assistant row matches; an oversized anchor cannot be caught
      // accidentally by the separate user-row event_id bound.
      populate(store, 'projection', 'user-a', 'unrelated user request');
      const database = new DatabaseSync(join(directory, 'events.sqlite'));
      const oversized = 'x'.repeat(512 * 1024);
      try {
        // Historical/corrupt metadata fixture, beyond current ingress limits.
        database.exec('PRAGMA foreign_keys = OFF');
        if (field === 'turn_anchor_id') {
          database
            .prepare('UPDATE orchestration_events SET id = ? WHERE id = ?')
            .run(oversized, 'projection:turn');
        } else {
          database
            .prepare(
              `UPDATE orchestration_message_search_v3 SET ${field} = ? WHERE event_id = ?`,
            )
            .run(oversized, 'projection:end');
        }
        const input = { query: 'cobalt', ownerUserId: 'user-a', limit: 20 };
        const unbounded = queryTranscriptMessages(database, input);
        const projectedField =
          field === 'created_at'
            ? 'createdAt'
            : field === 'turn_anchor_id'
              ? 'turnAnchorId'
              : 'role';
        expect(unbounded).toHaveLength(1);
        expect(unbounded[0][projectedField]).toBe(oversized);

        let materialized: Record<string, unknown>[] = [];
        const observedDatabase = {
          prepare(sql: string) {
            const statement = database.prepare(sql);
            return {
              get: (...parameters: SQLInputValue[]) =>
                statement.get(...parameters),
              all: (...parameters: SQLInputValue[]) => {
                materialized = statement.all(...parameters);
                return materialized;
              },
            };
          },
        };
        let refusal: unknown;
        try {
          queryTranscriptMessages(observedDatabase, input, true);
        } catch (error) {
          refusal = error;
        }
        // This observes the actual native SQLite->JS boundary, not a later
        // parent response validator or a substring check over generated SQL.
        expect(materialized).toHaveLength(1);
        expect(
          materialized.some(
            (row) =>
              typeof row[field] === 'string' &&
              Buffer.byteLength(row[field]) > 256,
          ),
        ).toBe(false);
        expect(materialized[0][field]).toBeNull();
        expect(refusal).toBeInstanceOf(TranscriptReadLimitError);
        const source = store.createIsolatedTranscriptReads();
        readers.push(source);
        await expect(source.search(input)).rejects.toThrow('unavailable');
      } finally {
        database.close();
      }
    },
  );

  test('locked SQLite cold reads leave parent heartbeat responsive and retain cancellation until actual worker exit', async () => {
    const directory = root();
    const store = storeAt(directory);
    populate(store);
    expect(store.close()).toEqual({ kind: 'closed' });
    const path = join(directory, 'events.sqlite');
    const locker = new DatabaseSync(path);
    let exited = false;
    const terminate = vi.fn((worker: Worker) => {
      worker.once('exit', () => {
        exited = true;
      });
      return worker.terminate();
    });
    const source = createIsolatedTranscriptReads(path, { terminate });
    readers.push(source);
    const controller = new AbortController();
    let settled = false;
    let heartbeatObservedPending = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let locked = false;
    try {
      locker.exec('PRAGMA journal_mode = DELETE');
      // Warm the worker and prove this fixture reaches valid canonical owner SQL.
      expect(await source.readOwner('thread-a')).toBe('user-a');
      locker.exec('BEGIN EXCLUSIVE');
      locked = true;
      const pending = source
        .readOwner('thread-a', controller.signal)
        .catch(() => 'unavailable')
        .finally(() => {
          settled = true;
        });
      heartbeat = setTimeout(() => {
        heartbeatObservedPending = !settled;
        controller.abort();
      }, 50);
      expect(await pending).toBe('unavailable');
      expect(heartbeatObservedPending).toBe(true);
      const closed = await source.close();
      if (closed.state === 'closed') expect(exited).toBe(true);
      else expect(closed.state).toBe('winding-down');
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(heartbeat);
      controller.abort();
      try {
        if (locked) locker.exec('COMMIT');
      } finally {
        locker.close();
      }
    }
    await expect.poll(() => source.inspect().phase).toBe('closed');
    expect(exited).toBe(true);
  });

  test('worker crash and malformed owner replies are unavailable, not ownerless grants', async () => {
    for (const body of [
      "throw new Error('crash')",
      "parentPort.postMessage(JSON.stringify({id:request.id,result:{state:'available',rows:[]}}))",
    ]) {
      const source = createIsolatedTranscriptReads(
        join(root(), 'unused.sqlite'),
        {
          workerSourceUrl: new URL(
            `data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads'; parentPort.on('message', wire => { const request = JSON.parse(wire); ${body}; });`)}`,
          ),
        },
      );
      readers.push(source);
      const store = storeAt();
      vi.spyOn(store, 'createIsolatedTranscriptReads').mockReturnValue(source);
      const lookup = vi.spyOn(source, 'readOwner');
      const authz = new SessionAuthorization({
        eventStore: store,
        ownerlessSessionAccess: 'single-user-compat',
      });
      await expect(
        authz.canReadSessionAsync('thread-a', personal(), () => true),
      ).rejects.toThrow('unavailable');
      expect(lookup).toHaveBeenCalledTimes(1);
    }
  });

  test('request accessor and proxy traps never run on the parent thread', async () => {
    const source = createIsolatedTranscriptReads(join(root(), 'unused.sqlite'));
    readers.push(source);
    const getter = vi.fn(() => 'cobalt');
    const input = {
      ownerUserId: 'user-a',
      limit: 20,
      get query() {
        return getter();
      },
    };
    await expect(source.search(input)).rejects.toThrow('unavailable');
    const trap = vi.fn(() => {
      throw new Error('proxy trap');
    });
    await expect(
      source.search(
        new Proxy(
          { query: 'cobalt', ownerUserId: 'user-a', limit: 20 },
          { ownKeys: trap },
        ),
      ),
    ).rejects.toThrow('unavailable');
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(source.inspect().phase).toBe('idle');
  });

  test('an absent cold owner is never cached across later durable ownership', async () => {
    const store = storeAt();
    const source = store.createIsolatedTranscriptReads();
    readers.push(source);
    const authz = new SessionAuthorization({
      eventStore: store,
      ownerlessSessionAccess: 'single-user-compat',
    });
    const lookup = vi.spyOn(source, 'readOwner');
    expect(
      await authz.canReadSessionAsync('later', personal(), () => true),
    ).toBe(true);
    populate(store, 'later', 'other-user');
    expect(
      await authz.canReadSessionAsync('later', personal(), () => true),
    ).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
