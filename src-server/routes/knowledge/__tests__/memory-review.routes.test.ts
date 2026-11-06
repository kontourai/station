import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { SqliteVecIndexProvider } from '../../../knowledge-index/sqlite-vec-index-provider.js';
import {
  candidate,
  claim,
  OWNER,
} from '../../../knowledge-store/__tests__/memory-claim-fixtures.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { MemoryErasureCoordinator } from '../../../knowledge-store/memory-erasure-coordinator.js';
import { MemoryReviewService } from '../../../knowledge-store/memory-review.js';
import { MemoryReviewStore } from '../../../knowledge-store/memory-review-store.js';
import {
  MemoryRootManager,
  memoryOwnerHash,
} from '../../../knowledge-store/memory-root.js';
import { createMemoryRoutes } from '../memory-routes.js';

const makeTempDir = trackTempDirs();
const owner = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
const other = sessionReadAuthorityFromRequest(
  'human:other',
  undefined,
  undefined,
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const home = makeTempDir('station-memory-review-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  const state = {
    enabled: true,
    allowRead: true,
    deny: false,
    clock: Date.parse('2026-11-05T09:00:00.000Z'),
  };
  const manager = new MemoryRootManager(
    store,
    persistence,
    home,
    () => state.enabled,
  );
  const review = new MemoryReviewService({
    manager,
    home,
    now: () => new Date(state.clock),
  });
  const guard = vi.fn(
    async (
      _request: Request,
      _roots: readonly KnowledgeStoreRoot[],
      response: Response,
    ) =>
      state.deny
        ? new Response('{"success":false}', { status: 403 })
        : response,
  );
  const app = createMemoryRoutes({
    manager,
    enabled: () => state.enabled,
    authority: (request) => {
      const name = request.headers.get('x-test-user');
      const scope =
        name === 'owner' ? owner : name === 'other' ? other : undefined;
      if (!scope) return undefined;
      return {
        scope,
        assertCurrent: () => {
          if (!state.enabled) throw new Error('disabled');
        },
      };
    },
    // Root access is deliberately independent of who asked: a missing identity must be
    // refused by the authority step alone, not hidden behind this check.
    mayReadRoot: async (_request, root) =>
      state.allowRead && root.readPolicy?.ownerId === OWNER,
    review,
    // Stands in for the host's reading of the authenticated request.
    reviewerKind: (request) =>
      request.headers.get('x-test-kind') === 'human' ? 'human' : 'agent',
    guardReadResponse: guard,
  });
  const root = await manager.ensureRoot(owner, () => {});
  let sequence = 0;
  const seed = async (
    memory: ReturnType<typeof claim>,
    agreement?: { passes: number; agreeing: number } | null,
    sourceVisibility?: ReturnType<typeof claim>['visibility'] | null,
  ) => {
    sequence += 1;
    await sleep(4);
    return manager.propose(
      owner,
      root,
      () => {},
      candidate(memory, agreement, sourceVisibility),
      { agent: 'dream', proposal: 'Distilled memory' },
      'agent:dream',
      `seed-${sequence}`,
    );
  };
  const as = (
    kind: 'human' | 'agent' | null,
    user: string | null = 'owner',
  ) => ({
    ...(user ? { 'x-test-user': user } : {}),
    ...(kind ? { 'x-test-kind': kind } : {}),
    'content-type': 'application/json',
  });
  const get = (path: string, headers = as('human')) =>
    app.request(path, { headers });
  const post = (path: string, body: unknown, headers = as('human')) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = async <T = any>(response: Response): Promise<T> =>
    ((await response.json()) as { data: T }).data;
  return {
    app,
    home,
    manager,
    store,
    root,
    state,
    guard,
    seed,
    get,
    post,
    as,
    json,
  };
}

const postgres = () =>
  claim({
    subject: 'Widget service',
    property: 'database',
    value: 'Postgres',
    excerpt: 'We run the widget service on Postgres.',
    observedAt: '2026-11-01T10:00:00.000Z',
  });
const mysql = () =>
  claim({
    subject: 'Widget service',
    property: 'database',
    value: 'MySQL',
    excerpt: 'Actually the widget service moved to MySQL.',
    observedAt: '2026-11-03T10:00:00.000Z',
  });
const region = () =>
  claim({
    subject: 'Billing',
    property: 'region',
    value: 'eu-west-1',
    excerpt: 'Billing runs in eu-west-1.',
    observedAt: '2026-11-02T10:00:00.000Z',
  });

async function contradiction() {
  const h = await setup();
  await h.seed(postgres());
  await h.seed(mysql());
  await h.seed(region());
  return h;
}

test('a seeded contradiction reaches the queue with its evidence, and an uncontested claim is recallable as proposed without review', async () => {
  const h = await contradiction();
  const queue = await h.json(await h.get('/memory/queue'));
  expect(queue.items).toHaveLength(1);
  const [item] = queue.items;
  expect(item.status).toBe('pending');
  expect(item.reasons.map((r: { rule: string }) => r.rule)).toEqual([
    'contested-by-accumulation',
  ]);
  expect(item.proposed).toMatchObject({
    value: 'MySQL',
    source: { excerpt: 'Actually the widget service moved to MySQL.' },
  });
  expect(item.current).toMatchObject({
    value: 'Postgres',
    source: { excerpt: 'We run the widget service on Postgres.' },
  });
  expect(item.question.split(/\s+/).length).toBeLessThanOrEqual(10);
  // The first Postgres claim and the Billing claim were never flagged.
  expect(queue.recallableWithoutReview).toBe(2);

  const recall = await h.json(await h.get('/memory/recall'));
  const byValue = Object.fromEntries(
    recall.entries.map((e: any) => [e.value, e]),
  );
  expect(byValue['eu-west-1'].review).toEqual({
    label: 'unreviewed',
    routing: 'uncontested',
    reasons: [],
  });
  expect(byValue['eu-west-1'].text).toMatch(/^\[stated · unreviewed\]/);
  expect(byValue.Postgres.review.label).toBe('unreviewed');
  expect(byValue.Postgres.conflictsWith.map((c: any) => c.claimId)).toEqual([
    byValue.MySQL.claimId,
  ]);
  // A routed claim is still recallable: review never blocks recall.
  expect(byValue.MySQL.review).toMatchObject({
    label: 'in-review',
    routing: 'routed',
    reasons: ['contested-by-accumulation'],
  });
});

test('only a decision by a host-attested human promotes; an agent decision only annotates', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  const base = `/memory/queue/${item.itemId}`;

  const asAgent = await h.json(
    await h.post(`${base}/decision`, { outcome: 'accept' }, h.as('agent')),
  );
  expect(asAgent).toMatchObject({ reviewerKind: 'agent', promoted: false });
  const after = (await h.json(await h.get('/memory/queue'))).items[0];
  expect(after).toMatchObject({
    status: 'pending',
    annotations: 1,
    decision: null,
  });
  const stillUnreviewed = (await h.json(await h.get('/memory/recall?q=mysql')))
    .entries[0];
  // The Kit labels an item with only annotations `in-review`: seen, not promoted.
  expect(stillUnreviewed.review.label).toBe('in-review');

  const asHuman = await h.json(
    await h.post(`${base}/decision`, { outcome: 'accept' }, h.as('human')),
  );
  expect(asHuman).toMatchObject({ reviewerKind: 'human', promoted: true });
  const decided = (await h.json(await h.get('/memory/queue'))).items[0];
  expect(decided).toMatchObject({
    status: 'decided',
    decision: { outcome: 'accept', reviewerKind: 'human' },
  });
  expect(
    (await h.json(await h.get('/memory/recall?q=mysql'))).entries[0].review
      .label,
  ).toBe('confirmed');
});

test('a body cannot name the reviewer or its kind', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  for (const extra of [
    { reviewerKind: 'human' },
    { actor: { id: 'someone' } },
    { reviewer: 'human:owner' },
  ]) {
    const response = await h.post(
      `/memory/queue/${item.itemId}/decision`,
      { outcome: 'accept', ...extra },
      h.as('agent'),
    );
    expect(response.status).toBe(400);
  }
  expect(
    (await h.json(await h.get('/memory/queue'))).items[0].annotations,
  ).toBe(0);
  expect(
    (
      await h.post(
        `/memory/queue/${item.itemId}/decision`,
        { outcome: 'correct' },
        h.as('human'),
      )
    ).status,
  ).toBe(400);
});

test('keeping the existing memory rejects the new claim, withholds it from recall, and settles the old one', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'reject',
    rationale: 'Still on Postgres.',
  });
  const recall = await h.json(await h.get('/memory/recall'));
  expect(recall.entries.map((e: any) => e.value).sort()).toEqual([
    'Postgres',
    'eu-west-1',
  ]);
  expect(recall.withheld).toBe(1);
  const postgresEntry = recall.entries.find((e: any) => e.value === 'Postgres');
  expect(postgresEntry.conflictsWith).toEqual([]);
});

test('a correction is recalled with the reviewer’s value and keeps what was extracted', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'correct',
    correctedValue: 'MariaDB',
  });
  const entry = (await h.json(await h.get('/memory/recall?q=widget+mariadb')))
    .entries[0];
  expect(entry).toMatchObject({
    value: 'MariaDB',
    review: { label: 'corrected' },
  });
});

test('every new route refuses a missing identity, another person and a disabled preview, and runs the delivery guard', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  const routes: [string, string, unknown?][] = [
    ['GET', '/memory/queue'],
    ['POST', `/memory/queue/${item.itemId}/open`],
    ['POST', `/memory/queue/${item.itemId}/decision`, { outcome: 'hold' }],
    ['GET', '/memory/recall'],
    ['GET', '/memory/brief'],
    ['GET', '/memory/measurement'],
  ];
  const call = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) =>
    h.app.request(path, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  for (const [method, path, body] of routes) {
    expect(
      (await call(method, path, h.as(null, null), body)).status,
      `${method} ${path} without identity`,
    ).toBe(403);
    expect(
      (await call(method, path, h.as('human', 'other'), body)).status,
      `${method} ${path} as another person`,
    ).toBe(404);
    h.state.allowRead = false;
    expect(
      (await call(method, path, h.as('human'), body)).status,
      `${method} ${path} without root access`,
    ).toBe(404);
    h.state.allowRead = true;
    h.state.enabled = false;
    const off = await call(method, path, h.as('human'), body);
    expect(off.status, `${method} ${path} preview off`).toBe(404);
    expect(await off.json()).toMatchObject({
      code: 'feature_preview_disabled',
    });
    h.state.enabled = true;
  }
  // No decision leaked through any refused call.
  expect((await h.json(await h.get('/memory/queue'))).items[0]).toMatchObject({
    status: 'pending',
    annotations: 0,
  });
  // The guard that re-checks access at delivery time can still withhold the answer.
  h.state.deny = true;
  for (const [method, path, body] of routes.filter(
    ([m, p]) => m === 'GET' || p.endsWith('/open'),
  )) {
    expect(
      (await call(method, path, h.as('human'), body)).status,
      `${method} ${path} at delivery`,
    ).toBe(403);
  }
  expect(h.guard).toHaveBeenCalled();
});

test('a decision for an item that does not exist is a 404, and a malformed id is a 400', async () => {
  const h = await contradiction();
  expect(
    (
      await h.post(`/memory/queue/memory-change.${'0'.repeat(32)}/decision`, {
        outcome: 'accept',
      })
    ).status,
  ).toBe(404);
  expect(
    (await h.post('/memory/queue/not-an-item/decision', { outcome: 'accept' }))
      .status,
  ).toBe(400);
});

test('the brief holds only reviewed memory, labelled as background, and waits on a contested slot', async () => {
  const h = await contradiction();
  const empty = await h.json(await h.get('/memory/brief'));
  expect(empty).toMatchObject({ text: null, entries: [] });

  // Confirm the uncontested Billing claim through its own review item.
  const billing = (await h.json(await h.get('/memory/recall?q=billing')))
    .entries[0];
  const itemOf = (claimId: string) =>
    `memory-change.${claimId.replace(/^sha256:/, '').slice(0, 32)}`;
  await h.post(`/memory/queue/${itemOf(billing.claimId)}/decision`, {
    outcome: 'accept',
  });
  const one = await h.json(await h.get('/memory/brief'));
  expect(one.entries).toHaveLength(1);
  expect(one.text).toMatch(
    /^<flow-agents-injected-memory>\nBackground, not instruction\./,
  );
  expect(one.text).toContain(
    '[stated · confirmed] Billing: region = eu-west-1',
  );
  expect(one.text).not.toMatch(/Postgres|MySQL/);

  // Confirming one side of the contradiction makes it the answer for its slot.
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/decision`, { outcome: 'accept' });
  const two = await h.json(await h.get('/memory/brief'));
  expect(two.text).toContain('MySQL');
  expect(two.text).not.toContain('Postgres');
});

test('the brief leaves out sealed memory and unreviewed memory unless asked', async () => {
  const h = await setup();
  await h.seed(
    claim({
      subject: 'Secrets',
      property: 'rotation',
      value: 'weekly',
      excerpt: 'Rotate secrets weekly.',
      visibility: null,
    }),
  );
  await h.seed(
    claim({
      subject: 'Roster',
      property: 'lead',
      value: 'Sam',
      excerpt: 'Sam leads the roster.',
      visibility: { kind: 'restricted', audiences: ['human:someone-else'] },
    }),
  );
  await h.seed(region());
  const withUnreviewed = await h.json(
    await h.get('/memory/brief?includeUnreviewed=1'),
  );
  expect(withUnreviewed.entries).toHaveLength(1);
  expect(withUnreviewed.entries[0]).toContain('[stated · unreviewed] Billing');
  expect(withUnreviewed.text).not.toContain('weekly');
  // Memory shared only with someone else is not briefed to this person.
  expect(withUnreviewed.text).not.toContain('Sam');
});

test('review time and routed share are measured per run', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/open`, {});
  h.state.clock += 42_000;
  const result = await h.json(
    await h.post(`/memory/queue/${item.itemId}/decision`, {
      outcome: 'accept',
    }),
  );
  expect(result.reviewSeconds).toBe(42);
  const measurement = await h.json(await h.get('/memory/measurement'));
  expect(measurement).toMatchObject({
    schema: 'station.memory-measurement/1',
    claimsProposed: 3,
    uncontested: 2,
    routed: 1,
    routedShare: 1 / 3,
    routedByRule: { 'contested-by-accumulation': 1 },
    reviewer: { confirmed: 1, pending: 0, defectsCaught: 0 },
    reviewSeconds: 42,
    reviewTimedDecisions: 1,
    reviewMinutes: 0.7,
  });
  const routedRow = measurement.lineages.find((l: any) => l.routed);
  expect(routedRow).toMatchObject({
    outcome: 'accept',
    reviewerKind: 'human',
    reviewSeconds: 42,
  });
  expect(
    measurement.lineages
      .filter((l: any) => !l.routed)
      .every((l: any) => l.outcome === 'not-routed'),
  ).toBe(true);
});

test('an agent note before a human decision does not become the measured review', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(
    `/memory/queue/${item.itemId}/decision`,
    { outcome: 'accept' },
    h.as('agent'),
  );
  h.state.clock += 1_000;
  await h.post(`/memory/queue/${item.itemId}/open`, {});
  h.state.clock += 30_000;
  await h.post(`/memory/queue/${item.itemId}/decision`, { outcome: 'accept' });
  const measurement = await h.json(await h.get('/memory/measurement'));
  const row = measurement.lineages.find((l: any) => l.routed);
  expect(row).toMatchObject({
    outcome: 'accept',
    reviewerKind: 'human',
    reviewSeconds: 30,
  });
  expect(measurement.reviewer).toMatchObject({ confirmed: 1, annotated: 1 });
});

test('an agent opening an item does not lend its time to a human decision', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/open`, {}, h.as('agent'));
  h.state.clock += 90_000;
  const result = await h.json(
    await h.post(`/memory/queue/${item.itemId}/decision`, {
      outcome: 'accept',
    }),
  );
  expect(result.reviewSeconds).toBeNull();
});

test('recall shows supersession history in both directions', async () => {
  const h = await setup();
  const older = claim({
    subject: 'Widget service',
    property: 'owner',
    value: 'Platform team',
    excerpt: 'Platform owns the widget service.',
    observedAt: '2026-10-01T10:00:00.000Z',
  });
  const newer = claim({
    subject: 'Widget service',
    property: 'owner',
    value: 'Billing team',
    excerpt: 'Billing took over the widget service.',
    observedAt: '2026-11-01T10:00:00.000Z',
    supersedes: [
      { claimId: older.id, kind: 'succession', reason: 'Ownership moved.' },
    ],
  });
  await h.seed(older);
  await h.seed(newer);
  const entries = (await h.json(await h.get('/memory/recall?q=widget')))
    .entries;
  const oldEntry = entries.find((e: any) => e.value === 'Platform team');
  const newEntry = entries.find((e: any) => e.value === 'Billing team');
  expect(newEntry.replaces.map((r: any) => r.claimId)).toEqual([older.id]);
  expect(oldEntry.replacedBy.map((r: any) => r.claimId)).toEqual([newer.id]);
  expect(newEntry.replaces[0].text).toContain('Platform team');
});

test('notes that are not structured claims are listed as notes, and a rejected proposal is gone', async () => {
  const h = await setup();
  const id = await h.manager.propose(
    owner,
    h.root,
    () => {},
    {
      type: 'raw',
      title: 'Free-form note about widgets',
      body: 'plain text',
      category: 'memory',
      provenance: { agent: 'test' },
    },
    { agent: 'test', proposal: 'note' },
    'agent:test',
    'note-1',
  );
  const recall = await h.json(await h.get('/memory/recall?q=widgets'));
  expect(recall.notes).toEqual([
    { proposalId: id, title: 'Free-form note about widgets' },
  ]);
  expect(recall.entries).toEqual([]);
  await h.manager.rejectCreate(owner, h.root, () => {}, id, 'not wanted');
  expect((await h.json(await h.get('/memory/recall?q=widgets'))).notes).toEqual(
    [],
  );
});

test('a body that does not verify as a claim is not shown', async () => {
  const h = await setup();
  const real = candidate(region());
  const tampered = JSON.parse(real.body);
  tampered.claim.value = 'us-east-1';
  await h.manager.propose(
    owner,
    h.root,
    () => {},
    { ...real, body: JSON.stringify(tampered) },
    { agent: 'dream', proposal: 'x' },
    'agent:dream',
    'tampered',
  );
  const recall = await h.json(await h.get('/memory/recall'));
  expect(recall.entries).toEqual([]);
  expect(
    (await h.json(await h.get('/memory/queue'))).recallableWithoutReview,
  ).toBe(0);
});

test('a retried decision with the same request key is recorded once', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  const body = { outcome: 'accept', requestKey: 'attempt-1' };
  await h.post(`/memory/queue/${item.itemId}/decision`, body);
  await h.post(`/memory/queue/${item.itemId}/decision`, body);
  const measurement = await h.json(await h.get('/memory/measurement'));
  expect(measurement.reviewer.decisions).toBe(1);
  // A submission without a key is a new decision, but the standing decision for an item still counts once.
  await h.post(`/memory/queue/${item.itemId}/decision`, { outcome: 'accept' });
  expect(
    (await h.json(await h.get('/memory/measurement'))).reviewer.decisions,
  ).toBe(1);
});

const itemOf = (claimId: string) =>
  `memory-change.${claimId.replace(/^sha256:/, '').slice(0, 32)}`;

test('an agent cannot promote a claim no rule flagged: it stays unreviewed and out of the brief', async () => {
  const h = await setup();
  const memory = region();
  await h.seed(memory);
  const result = await h.json(
    await h.post(
      `/memory/queue/${itemOf(memory.id)}/decision`,
      { outcome: 'accept' },
      h.as('agent'),
    ),
  );
  expect(result).toMatchObject({ reviewerKind: 'agent', promoted: false });
  const entry = (await h.json(await h.get('/memory/recall?q=billing')))
    .entries[0];
  expect(entry.review.label).toBe('unreviewed');
  expect((await h.json(await h.get('/memory/brief'))).text).toBeNull();
  const measurement = await h.json(await h.get('/memory/measurement'));
  expect(measurement.reviewer).toMatchObject({ confirmed: 0, annotated: 1 });
  // A human decision on the same claim does promote it.
  await h.post(`/memory/queue/${itemOf(memory.id)}/decision`, {
    outcome: 'accept',
  });
  expect((await h.json(await h.get('/memory/brief'))).entries).toHaveLength(1);
});

test('"Not sure" leaves the item open to decide again', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/decision`, { outcome: 'hold' });
  const held = (await h.json(await h.get('/memory/queue'))).items[0];
  expect(held).toMatchObject({
    status: 'pending',
    decision: { outcome: 'hold' },
  });
  await h.post(`/memory/queue/${item.itemId}/decision`, { outcome: 'accept' });
  expect((await h.json(await h.get('/memory/queue'))).items[0].status).toBe(
    'decided',
  );
});

test('a retried decision returns what was first recorded, not what the retry asked for', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'accept',
    requestKey: 'k',
  });
  const retry = await h.json(
    await h.post(`/memory/queue/${item.itemId}/decision`, {
      outcome: 'reject',
      requestKey: 'k',
    }),
  );
  expect(retry).toMatchObject({
    outcome: 'accept',
    reviewerKind: 'human',
    promoted: true,
  });
  expect(
    (await h.json(await h.get('/memory/recall?q=mysql'))).entries[0].review
      .label,
  ).toBe('confirmed');
});

test('an unreviewed replacement does not remove confirmed memory from the brief, but it is queued', async () => {
  const h = await setup();
  const older = claim({
    subject: 'Widget service',
    property: 'owner',
    value: 'Platform team',
    excerpt: 'Platform owns the widget service.',
    observedAt: '2026-10-01T10:00:00.000Z',
  });
  await h.seed(older);
  await h.post(`/memory/queue/${itemOf(older.id)}/decision`, {
    outcome: 'accept',
  });
  const newer = claim({
    subject: 'Widget service',
    property: 'owner',
    value: 'Billing team',
    excerpt: 'Billing took over the widget service.',
    observedAt: '2026-11-01T10:00:00.000Z',
    supersedes: [
      { claimId: older.id, kind: 'succession', reason: 'Ownership moved.' },
    ],
  });
  await h.seed(newer);
  const brief = await h.json(await h.get('/memory/brief'));
  expect(brief.text).toContain('Platform team');
  expect(brief.text).not.toContain('Billing team');
  const queued = (await h.json(await h.get('/memory/queue'))).items;
  expect(
    queued.map((i: any) => i.reasons.map((r: any) => r.rule)),
  ).toContainEqual(expect.arrayContaining(['consequential-supersession']));
  // Once a person confirms the replacement, the old claim leaves the brief.
  await h.post(`/memory/queue/${itemOf(newer.id)}/decision`, {
    outcome: 'accept',
  });
  const after = await h.json(await h.get('/memory/brief'));
  expect(after.text).toContain('Billing team');
  expect(after.text).not.toContain('Platform team');
});

test('a correction that makes two claims agree resolves their conflict', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  const first = (await h.json(await h.get('/memory/recall?q=postgres')))
    .entries[0];
  await h.post(`/memory/queue/${first.itemId}/decision`, { outcome: 'accept' });
  await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'correct',
    correctedValue: 'Postgres',
  });
  const brief = await h.json(await h.get('/memory/brief'));
  expect(brief.text).toContain('Postgres');
  const entry = (
    await h.json(await h.get('/memory/recall?q=postgres'))
  ).entries.find((e: any) => e.review.label === 'corrected');
  expect(entry.conflictsWith).toEqual([]);
});

test('a public claim in a private root is queued for widening the audience, whatever its envelope says about its source', async () => {
  const h = await setup();
  // The envelope's own routing decision is self-consistent but forged: it records a
  // public source, so by its own account nothing widened. Station does not take its
  // word. Who could see the source is the root's owner.
  await h.seed(
    claim({
      subject: 'Roadmap',
      property: 'launch',
      value: 'March',
      excerpt: 'Launch is in March.',
      visibility: { kind: 'public' },
    }),
    undefined,
    { kind: 'public' },
  );
  const queue = await h.json(await h.get('/memory/queue'));
  expect(
    queue.items.map((i: any) => i.reasons.map((r: any) => r.rule)),
  ).toEqual([['visibility-widening']]);
});

test('measurement keeps each producer run apart and ties every change to its run', async () => {
  const h = await contradiction();
  const measurement = await h.json(await h.get('/memory/measurement'));
  // The contradiction pair shares a sitting; the Billing claim came from another.
  expect(measurement.runs).toHaveLength(2);
  expect(measurement.runs.map((r: any) => r.claimsProposed).sort()).toEqual([
    1, 2,
  ]);
  expect(
    measurement.runs.every((r: any) => r.runId.startsWith('sitting:')),
  ).toBe(true);
  expect(new Set(measurement.lineages.map((l: any) => l.runId)).size).toBe(2);
  expect(measurement.claimsProposed).toBe(3);
});

test('a decision response the delivery guard refuses is not delivered', async () => {
  const h = await contradiction();
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  h.state.deny = true;
  const response = await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'hold',
  });
  expect(response.status).toBe(403);
});

test('a decision begun before erasure is refused when it reaches the root lease', async () => {
  const h = await setup();
  await h.seed(postgres());
  const proposalId = await h.seed(mysql());
  const [item] = (await h.json(await h.get('/memory/queue'))).items;
  let arrived!: () => void;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.manager.withProposals.bind(h.manager);
  let reads = 0;
  const spy = vi
    .spyOn(h.manager, 'withProposals')
    .mockImplementation(async (...args) => {
      if (++reads === 2) {
        arrived();
        await resume;
      }
      return original(...args);
    });
  const pending = h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'correct',
    correctedValue: 'erased correction',
  });
  await blocked;
  await h.manager.withErasure(
    owner,
    h.root,
    () => {},
    async (adapter) => {
      const preview = await adapter.previewPurgeProposal(proposalId);
      await adapter.purgeProposal(
        proposalId,
        { agent: OWNER, rationale: 'erase' },
        { expectedRevision: preview.revision },
      );
    },
  );
  release();
  expect((await pending).status).toBe(404);
  spy.mockRestore();
  const recall = await h.json(await h.get('/memory/recall'));
  expect(JSON.stringify(recall)).not.toContain('erased correction');
});

test('erasure removes review decisions and keeps a re-proposed claim unreviewed', async () => {
  const h = await setup();
  const memory = mysql();
  const proposalId = await h.seed(memory);
  const recall = await h.json(await h.get('/memory/recall'));
  const item = recall.entries[0];
  const decided = await h.post(`/memory/queue/${item.itemId}/decision`, {
    outcome: 'correct',
    correctedValue: 'unique-erased-correction',
    rationale: 'unique-erased-rationale',
  });
  expect(decided.status).toBe(201);
  const index = new SqliteVecIndexProvider({
    dbPath: join(h.home, 'index.db'),
  });
  try {
    const coordinator = new MemoryErasureCoordinator(
      h.home,
      h.store,
      h.manager,
      index,
    );
    const preview = await h.manager.previewErasureTarget(
      owner,
      h.root,
      () => {},
      'proposal',
      proposalId,
    );
    expect(preview?.kind).toBe('proposal');
    await coordinator.erase(
      owner,
      h.root,
      () => {},
      'proposal',
      proposalId,
      preview!.impact.revision,
      'purge-review-test',
    );
    for (const route of [
      '/memory/queue',
      '/memory/recall',
      '/memory/brief',
      '/memory/measurement',
    ]) {
      const response = await h.get(route);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('unique-erased-correction');
    }
    const reviewPath = join(
      h.home,
      'knowledge',
      'memory-review',
      memoryOwnerHash(OWNER),
      'review.json',
    );
    for (const path of [reviewPath, `${reviewPath}.previous`]) {
      if (existsSync(path)) {
        const bytes = readFileSync(path, 'utf8');
        expect(bytes).not.toContain('unique-erased-correction');
        expect(bytes).not.toContain('unique-erased-rationale');
      }
    }
    await h.seed(memory);
    const after = await h.json(await h.get('/memory/recall'));
    expect(after.entries[0].review.label).toBe('unreviewed');
    expect(after.entries[0].value).toBe('MySQL');
  } finally {
    index.close();
  }
});

test('a claim with an erased source is excluded even when another source survives', async () => {
  const h = await setup();
  const createSource = async (key: string) => {
    const proposal = await h.manager.propose(
      owner,
      h.root,
      () => {},
      {
        type: 'raw',
        title: key,
        body: key,
        category: 'source',
        provenance: { agent: 'source' },
      },
      { agent: 'source', proposal: 'evidence' },
      'agent:source',
      key,
    );
    return h.manager.applyCreate(owner, h.root, () => {}, proposal);
  };
  const erasedSource = await createSource('source-a');
  const survivingSource = await createSource('source-b');
  const memory = mysql();
  const envelope = candidate(memory);
  await h.manager.propose(
    owner,
    h.root,
    () => {},
    {
      ...envelope,
      provenance: {
        ...envelope.provenance,
        source_ids: [erasedSource, survivingSource],
      },
    },
    { agent: 'dream', proposal: 'evidence' },
    'agent:dream',
    'supported-claim',
  );
  expect((await h.json(await h.get('/memory/recall'))).entries).toHaveLength(1);
  const index = new SqliteVecIndexProvider({
    dbPath: join(h.home, 'index.db'),
  });
  try {
    const coordinator = new MemoryErasureCoordinator(
      h.home,
      h.store,
      h.manager,
      index,
    );
    const preview = await h.manager.previewErasureTarget(
      owner,
      h.root,
      () => {},
      'record',
      erasedSource,
    );
    expect(preview?.kind).toBe('record');
    await coordinator.erase(
      owner,
      h.root,
      () => {},
      'record',
      erasedSource,
      preview!.impact.revision,
      'purge-source-test',
    );
    for (const route of [
      '/memory/queue',
      '/memory/recall',
      '/memory/brief',
      '/memory/measurement',
    ]) {
      const response = await h.get(route);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(
        'Actually the widget service moved to MySQL.',
      );
    }
    expect((await h.json(await h.get('/memory/recall'))).entries).toHaveLength(
      0,
    );
  } finally {
    index.close();
  }
});

test('interrupted review cleanup blocks reads until journal recovery removes the decision', async () => {
  const h = await setup();
  const proposalId = await h.seed(mysql());
  const item = (await h.json(await h.get('/memory/recall'))).entries[0];
  expect(
    (
      await h.post(`/memory/queue/${item.itemId}/decision`, {
        outcome: 'correct',
        correctedValue: 'interrupted-erased-correction',
      })
    ).status,
  ).toBe(201);
  const index = new SqliteVecIndexProvider({
    dbPath: join(h.home, 'index.db'),
  });
  const spy = vi
    .spyOn(MemoryReviewStore.prototype, 'eraseItems')
    .mockRejectedValueOnce(new Error('cleanup interrupted'));
  try {
    const coordinator = new MemoryErasureCoordinator(
      h.home,
      h.store,
      h.manager,
      index,
    );
    const preview = await h.manager.previewErasureTarget(
      owner,
      h.root,
      () => {},
      'proposal',
      proposalId,
    );
    await expect(
      coordinator.erase(
        owner,
        h.root,
        () => {},
        'proposal',
        proposalId,
        preview!.impact.revision,
        'interrupted-review-test',
      ),
    ).rejects.toThrow('cleanup interrupted');
    expect((await h.get('/memory/recall')).status).toBe(503);
    spy.mockRestore();
    await coordinator.recoverAll();
    await h.seed(mysql());
    const after = await h.json(await h.get('/memory/recall'));
    expect(after.entries[0].review.label).toBe('unreviewed');
    expect(JSON.stringify(after)).not.toContain(
      'interrupted-erased-correction',
    );
  } finally {
    spy.mockRestore();
    index.close();
  }
});
