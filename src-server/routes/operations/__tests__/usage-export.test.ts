import { join } from 'node:path';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import type { UsageExportPage } from '@kontourai/station-contracts/usage-export';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { readAuthorizedUsageExport } from '../../../analytics/usage-export-reader.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createAnalyticsRoutes } from '../analytics.js';

const makeHome = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new EventStore(
    join(makeHome('usage-export-'), 'events.sqlite'),
  );
  stores.push(store);
  const day = new Date().toISOString().slice(0, 10);
  let owners = ['reader', 'account-member'];
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
  const start = (thread: string, owner: string, tenant?: string) => {
    const time = new Date().toISOString();
    store.upsertSession({
      threadId: thread,
      provider: 'codex',
      status: 'ready',
      createdAt: time,
      updatedAt: time,
    });
    store.appendEvent({
      eventId: `start-${thread}`,
      provider: 'codex',
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
        provider: 'codex',
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
      provider: 'codex',
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
    app,
    start,
    observation,
    url,
    setOwners: (value: string[]) => {
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
