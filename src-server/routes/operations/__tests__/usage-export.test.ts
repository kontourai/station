import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import type { UsageExportPage } from '@kontourai/station-contracts/usage-export';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { readAuthorizedUsageExport } from '../../../analytics/usage-export-reader.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createAnalyticsRoutes } from '../analytics.js';

const makeHome = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});

function fixture() {
  const storePath = join(makeHome('usage-export-'), 'events.sqlite');
  const store = new EventStore(storePath);
  stores.push(store);
  const day = new Date().toISOString().slice(0, 10);
  let owners: string[] | undefined = ['reader', 'account-member'];
  let authority = sessionReadAuthorityFromRequest(
    'reader',
    undefined,
    undefined,
  );
  let stationId = 'station-a';
  const app = createAnalyticsRoutes(
    undefined,
    undefined,
    undefined,
    undefined,
    stationId,
    undefined,
    async (_context, request) => {
      // This fixture supplies trusted request authority; it proves SQL/projection
      // and response release, not runtime authentication or analytics grants.
      const selected = readAuthorizedUsageExport({
        store,
        authority,
        stationId,
        request,
        personalOwnerIds: () => owners,
      });
      return {
        page: selected.page,
        assertCurrent: async () => selected.assertCurrent(),
      };
    },
  );
  let index = 0;
  const providers = new Map<string, 'codex' | 'claude'>();
  const start = (
    thread: string,
    owner: string,
    tenant?: string,
    provider: 'codex' | 'claude' = 'codex',
  ) => {
    providers.set(thread, provider);
    const time = new Date().toISOString();
    store.upsertSession({
      threadId: thread,
      provider,
      status: 'ready',
      createdAt: time,
      updatedAt: time,
    });
    store.appendEvent({
      eventId: `start-${thread}`,
      provider,
      threadId: thread,
      sessionId: thread,
      method: 'session.started',
      initialState: 'created',
      createdAt: time,
      metadata: { userId: owner },
    });
    if (tenant)
      store.upsertSession({
        threadId: thread,
        provider,
        status: 'ready',
        createdAt: time,
        updatedAt: time,
        tenantExecutionContext: {
          tenantId: tenantId(tenant),
          source: 'session',
        },
      });
  };
  const observation = (
    thread = 'own',
    createdAt = new Date().toISOString(),
  ) => {
    const id = `usage-${++index}`;
    store.appendEvent({
      eventId: id,
      provider: providers.get(thread) ?? 'codex',
      threadId: thread,
      method: 'token-usage.updated',
      createdAt,
      promptTokens: index,
      completionTokens: 1,
      reportedCostUsd: 0.25,
    });
    return id;
  };
  const url = (extra = '') => `/usage-export?from=${day}&to=${day}${extra}`;
  return {
    store,
    storePath,
    app,
    start,
    observation,
    url,
    setOwners: (value: string[] | undefined) => {
      owners = value;
    },
    setAuthority: (value: typeof authority) => {
      authority = value;
    },
    setStation: (value: string) => {
      stationId = value;
    },
  };
}

test('mounted export walks more than 500 committed facts and excludes later appends from its fixed head', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
  const f = fixture();
  f.start('own', 'reader');
  const expected = Array.from({ length: 503 }, (_, index) =>
    f.observation('own', new Date(1700000000000 - index * 1000).toISOString()),
  );
  let response = await f.app.request(f.url('&pageSize=100'));
  const received: string[] = [];
  let fixed: number | undefined;
  f.observation();
  while (true) {
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: UsageExportPage };
    fixed ??= body.data.highWater;
    expect(body.data.highWater).toBe(fixed);
    expect(body.data.coverage.state).toBe('unknown');
    for (const row of body.data.observations) {
      const receipt = row.receipts.find(
        (item) => item.inputTokens !== undefined,
      );
      expect(receipt?.observedAt).toBeDefined();
      expect(receipt?.occurredAt).toBeDefined();
      received.push(receipt!.sourceEventId!);
      expect(
        row.receipts.find((item) => item.reportedCost)?.reportedCost,
      ).toEqual({ amount: 0.25, currency: 'USD' });
    }
    if (!body.data.nextCursor) break;
    response = await f.app.request(
      f.url(`&pageSize=100&cursor=${body.data.nextCursor}`),
    );
  }
  expect(received).toEqual(expected);
});

test('personal nonmembers refuse account scope while retaining individual reads', async () => {
  const f = fixture();
  f.start('own', 'reader');
  f.observation();
  f.setOwners(undefined);
  expect((await f.app.request(f.url('&scope=personal-account'))).status).toBe(
    403,
  );
  expect((await f.app.request(f.url())).status).toBe(200);
});

test('a single-row page refuses over-budget cumulative history before hydration', async () => {
  const f = fixture();
  f.start('own', 'reader', undefined, 'claude');
  for (let index = 0; index < 1001; index++) f.observation();
  const response = await f.app.request(f.url('&pageSize=1'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: 'usage_export_unavailable' },
  });
});

test('scope choice and tenant predicates do not turn account membership into individual or foreign-tenant access', async () => {
  const f = fixture();
  for (const [thread, owner, tenant] of [
    ['own', 'reader'],
    ['member', 'account-member'],
    ['foreign', 'someone-else'],
    ['tenant', 'reader', 'alpha'],
  ]) {
    f.start(thread, owner, tenant);
    f.observation(thread);
  }
  const individual = (await (await f.app.request(f.url())).json()) as {
    data: UsageExportPage;
  };
  expect(
    new Set(
      individual.data.observations.flatMap((row) =>
        row.receipts.map((receipt) => receipt.threadId),
      ),
    ),
  ).toEqual(new Set(['own']));
  const account = (await (
    await f.app.request(f.url('&scope=personal-account'))
  ).json()) as { data: UsageExportPage };
  expect(
    new Set(
      account.data.observations.flatMap((row) =>
        row.receipts.map((receipt) => receipt.threadId),
      ),
    ),
  ).toEqual(new Set(['own', 'member']));
  f.setAuthority(
    sessionReadAuthorityFromRequest(
      'reader',
      { tenantId: tenantId('alpha') },
      parseHostedTenantRegistry({
        schemaVersion: 1,
        tenants: [{ id: tenantId('alpha'), authority: 'alpha.test' }],
      }),
    ),
  );
  const hosted = (await (await f.app.request(f.url())).json()) as {
    data: UsageExportPage;
  };
  expect(
    new Set(
      hosted.data.observations.flatMap((row) =>
        row.receipts.map((receipt) => receipt.threadId),
      ),
    ),
  ).toEqual(new Set(['tenant']));
  expect((await f.app.request(f.url('&scope=personal-account'))).status).toBe(
    400,
  );
});

test('continuations and queued response release stay bound to current source and membership', async () => {
  const f = fixture();
  f.start('own', 'reader');
  f.observation();
  f.observation();
  const first = (await (
    await f.app.request(f.url('&scope=personal-account&pageSize=1'))
  ).json()) as { data: UsageExportPage };
  const cursor = first.data.nextCursor!;
  f.setStation('station-b');
  expect(
    (await f.app.request(f.url(`&scope=personal-account&cursor=${cursor}`)))
      .status,
  ).toBe(403);
  f.setStation('station-a');
  const queued = await f.app.request(f.url('&scope=personal-account'));
  f.setOwners(['reader']);
  await expect(queued.text()).rejects.toThrow('usage_export_authority_changed');
  expect(
    (await f.app.request(f.url(`&scope=personal-account&cursor=${cursor}`)))
      .status,
  ).toBe(403);
});

test('thread deletion ends a queued export and invalidates its earlier continuation', async () => {
  const f = fixture();
  f.start('own', 'reader');
  f.observation();
  f.observation();
  const first = await f.app.request(f.url('&pageSize=1'));
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { data: UsageExportPage };
  const cursor = firstBody.data.nextCursor;
  expect(cursor).toBeDefined();
  const queued = await f.app.request(f.url());
  expect(queued.status).toBe(200);
  f.store.deleteThread('own');
  await expect(queued.text()).rejects.toThrow('usage_export_authority_changed');
  expect((await f.app.request(f.url(`&cursor=${cursor}`))).status).toBe(403);
  const fresh = await f.app.request(f.url());
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({ data: { observations: [] } });
});

test('a failed invalidation write rolls thread deletion back without invalidating an unchanged queued page', async () => {
  const f = fixture();
  f.start('own', 'reader');
  const eventId = f.observation();
  const revision = f.store.usageExportRevision();
  const queued = await f.app.request(f.url());
  const db = new DatabaseSync(f.storePath);
  try {
    db.exec(`CREATE TRIGGER fixture_invalidation_write_failure AFTER UPDATE ON orchestration_usage_export_state
      BEGIN SELECT RAISE(ABORT,'fixture invalidation write failed'); END;`);
    expect(() => f.store.deleteThread('own')).toThrow(
      'fixture invalidation write failed',
    );
    expect(f.store.usageExportRevision()).toBe(revision);
    db.exec('DROP TRIGGER fixture_invalidation_write_failure');
    const body = (await queued.json()) as { data: UsageExportPage };
    expect(
      body.data.observations
        .flatMap((row) => row.receipts)
        .some((row) => row.sourceEventId === eventId),
    ).toBe(true);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS retained FROM orchestration_usage_export_invalidations',
        )
        .get(),
    ).toEqual({ retained: revision });
  } finally {
    db.close();
  }
});

test('tenant reassignment journals both scopes and fences the old tenant snapshot', async () => {
  const f = fixture();
  f.start('own', 'reader', 'tenant-a');
  f.observation();
  const registry = parseHostedTenantRegistry({
    schemaVersion: 1,
    tenants: [
      { id: 'tenant-a', authority: 'a.example.test' },
      { id: 'tenant-b', authority: 'b.example.test' },
    ],
  });
  f.setAuthority(
    sessionReadAuthorityFromRequest(
      'reader',
      { tenantId: tenantId('tenant-a') },
      registry,
    ),
  );
  const revision = f.store.usageExportRevision();
  const queued = await f.app.request(f.url());
  const time = new Date().toISOString();
  f.store.upsertSession({
    threadId: 'own',
    provider: 'codex',
    status: 'ready',
    createdAt: time,
    updatedAt: time,
    tenantExecutionContext: {
      tenantId: tenantId('tenant-b'),
      source: 'session',
    },
  });
  expect(f.store.usageExportRevision()).toBe(revision + 2);
  await expect(queued.text()).rejects.toThrow('usage_export_authority_changed');
  const oldScope = await f.app.request(f.url());
  expect(await oldScope.json()).toMatchObject({ data: { observations: [] } });
  const db = new DatabaseSync(f.storePath, { readOnly: true });
  try {
    expect(
      db
        .prepare(
          'SELECT owner_user_id,tenant_id,thread_id,reason FROM orchestration_usage_export_invalidations ORDER BY revision',
        )
        .all(),
    ).toEqual([
      {
        owner_user_id: 'reader',
        tenant_id: 'tenant-a',
        thread_id: 'own',
        reason: 'scope-changed',
      },
      {
        owner_user_id: 'reader',
        tenant_id: 'tenant-b',
        thread_id: 'own',
        reason: 'scope-entered',
      },
    ]);
  } finally {
    db.close();
  }
  f.setAuthority(
    sessionReadAuthorityFromRequest(
      'reader',
      { tenantId: tenantId('tenant-b') },
      registry,
    ),
  );
  const newScope = await f.app.request(f.url());
  const body = (await newScope.json()) as { data: UsageExportPage };
  expect(body.data.observations).toHaveLength(1);
});

test('the invalidation journal retains 10000 entries and refuses missing retained evidence', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.storePath);
  try {
    db.exec(`BEGIN;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10005)
      INSERT INTO orchestration_conversation_history(thread_id,owner_user_id,created_at,updated_at)
        SELECT 'journal-bound-'||i,'reader','2026-10-24T00:00:00.000Z','2026-10-24T00:00:00.000Z' FROM n;
      DELETE FROM orchestration_conversation_history WHERE thread_id LIKE 'journal-bound-%';
      COMMIT;`);
    expect(f.store.usageExportRevision()).toBe(10005);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS retained,MIN(revision) AS first,MAX(revision) AS last FROM orchestration_usage_export_invalidations',
        )
        .get(),
    ).toEqual({ retained: 10000, first: 6, last: 10005 });
    expect(
      db
        .prepare('SELECT retained_after FROM orchestration_usage_export_state')
        .get(),
    ).toEqual({ retained_after: 5 });
    db.exec(
      'DELETE FROM orchestration_usage_export_invalidations WHERE revision=10005',
    );
    expect(() => f.store.usageExportRevision()).toThrow(
      'invalidation journal is unavailable',
    );
    expect((await f.app.request(f.url())).status).toBe(503);
  } finally {
    db.close();
  }
});

test('startup refuses a same-name invalidation trigger with changed behavior', () => {
  const f = fixture();
  const db = new DatabaseSync(f.storePath);
  try {
    db.exec(`DROP TRIGGER orchestration_usage_export_history_deleted;
      CREATE TRIGGER orchestration_usage_export_history_deleted AFTER DELETE ON orchestration_conversation_history BEGIN SELECT 1; END;`);
    expect(() => new EventStore(f.storePath)).toThrow(
      'Usage export invalidation schema is incomplete or changed',
    );
  } finally {
    db.close();
  }
});

test('startup does not reset a previously initialized journal when all of its local objects are lost', async () => {
  const f = fixture();
  const db = new DatabaseSync(f.storePath);
  try {
    db.exec(`DROP TRIGGER orchestration_usage_export_history_deleted;
      DROP TRIGGER orchestration_usage_export_scope_changed;
      DROP TRIGGER orchestration_usage_export_scope_entered;
      DROP TRIGGER orchestration_usage_export_recorded;
      DROP TABLE orchestration_usage_export_invalidations;
      DROP TABLE orchestration_usage_export_state;`);
    expect((await f.app.request(f.url())).status).toBe(503);
    expect(() => new EventStore(f.storePath)).toThrow(
      'Previously initialized usage export journal is missing',
    );
  } finally {
    db.close();
  }
});

test.each([
  '&pageSize=0',
  '&pageSize=101',
  '&cursor=bad',
  '&userId=someone-else',
  '&scope=station',
])('malformed export query refuses %s', async (suffix) => {
  const f = fixture();
  expect((await f.app.request(f.url(suffix))).status).toBe(400);
});

test('an impossible calendar day is refused before the canonical read', async () => {
  const f = fixture();
  const query = new URLSearchParams({ from: '2026-02-31', to: '2026-03-01' });
  expect((await f.app.request(`/usage-export?${query}`)).status).toBe(400);
});
