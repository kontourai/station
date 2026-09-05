import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { knowledgeRootIncarnationKey } from '@kontourai/station-shared/knowledge-root-identity';
import { afterEach, expect, test, vi } from 'vitest';
import { createLearningSourceFixture } from '../../../__test-utils__/learning-source-test-harness';
import * as transactions from '../../../knowledge-store/adapters/shared/file-transactions';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token';

const owned: Array<Awaited<ReturnType<typeof createLearningSourceFixture>>> =
  [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fixture of owned.splice(0).reverse()) fixture.close();
});
async function fixture(tenantFixture = false) {
  const value = await createLearningSourceFixture(
    mkdtempSync(join(tmpdir(), 'station-source-route-')),
    tenantFixture,
  );
  owned.push(value);
  return value;
}
function fingerprint(root: string) {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      if (statSync(entry).isDirectory()) walk(entry);
      else
        result[relative(root, entry)] = readFileSync(entry).toString('base64');
    }
  };
  walk(root);
  return result;
}
test('production constructor and authenticated route observe an owner-produced source without repair or writes', async () => {
  const f = await fixture();
  const before = fingerprint(f.fixture);
  const ordinary = vi.spyOn(f.provider, 'adapterFor').mockImplementation(() => {
    throw new Error('ordinary read forbidden');
  });
  const response = await f.app.request(f.path, { headers: f.headers() });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  const result = (await response.json()) as any;
  expect(result.data).toMatchObject({
    state: 'observed',
    kind: 'source-only',
    source: {
      rootId: f.root.id,
      recordId: f.recordId,
      type: 'raw',
      title: 'Keep verification evidence visible',
    },
    observation: {
      ownerRevision: 'unknown',
      consistency: 'non-atomic',
      transactionState: 'unknown',
    },
  });
  expect(result.data).not.toHaveProperty('activation');
  expect(ordinary).not.toHaveBeenCalled();
  expect(fingerprint(f.fixture)).toEqual(before);
});
test.each(['remote-fixture', 'operator-fixture', 'invalid'])(
  'credential %s cannot turn headers or loopback into source authority',
  async (credential) => {
    const f = await fixture();
    const read = vi.spyOn(f.persistence, 'observeKnowledgeStoreRoots');
    const response = await f.app.request(f.path, {
      headers: {
        ...f.headers(credential),
        'X-Station-Local': 'true',
        'X-Station-Operator': 'true',
      },
    });
    const text = await response.text();
    expect(text).not.toContain(f.recordId);
    expect(text).not.toContain('Keep verification evidence visible');
    expect(read).not.toHaveBeenCalled();
  },
);
test('project roots and replacement personal registrations are restricted before source open', async () => {
  const f = await fixture();
  const open = vi.spyOn(transactions, 'observeExactKnowledgeRecordFile');
  await f.persistence.saveKnowledgeStoreRoot({
    ...f.root,
    scope: { kind: 'project', projectSlug: 'private-project' },
  });
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'restricted' });
  await f.persistence.saveKnowledgeStoreRoot({
    ...f.root,
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'restricted' });
  expect(open).not.toHaveBeenCalled();
});
test.each(['revoke', 'narrowScope', 'revokeLocality'] as const)(
  '%s after owner read withholds every source field',
  async (method) => {
    const f = await fixture();
    const original = transactions.observeExactKnowledgeRecordFile;
    vi.spyOn(
      transactions,
      'observeExactKnowledgeRecordFile',
    ).mockImplementation((...args) => {
      const observed = original(...args);
      f[method]();
      return observed;
    });
    const result = (await (
      await f.app.request(f.path, { headers: f.headers() })
    ).json()) as any;
    expect(result.data).toEqual({ state: 'restricted' });
  },
);
test('Unicode registration identity is a bounded header precondition and CORS allows it', async () => {
  const f = await fixture();
  const root = { ...f.root, displayName: 'Mémoire 🧠' };
  await f.persistence.saveKnowledgeStoreRoot(root);
  expect(
    (
      (await (
        await f.app.request(f.path, {
          headers: f.headers(
            'local-fixture',
            knowledgeRootIncarnationKey(root),
          ),
        })
      ).json()) as any
    ).data.state,
  ).toBe('observed');
  const response = await f.app.request(f.path, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-station-knowledge-root-identity',
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain(
    'x-station-knowledge-root-identity',
  );
});
test('oversized source is unavailable without repair', async () => {
  const f = await fixture();
  const path = join(f.rootPath, 'records', `${f.recordId}.md`);
  writeFileSync(path, 'x'.repeat(256 * 1024 + 1));
  const before = fingerprint(f.fixture);
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'over-budget' });
  expect(fingerprint(f.fixture)).toEqual(before);
});

test('constructor policy cannot reuse an authenticated request for another exact record', async () => {
  const f = await fixture();
  const original = f.provider.observeExactRecord.bind(f.provider);
  const open = vi.spyOn(transactions, 'observeExactKnowledgeRecordFile');
  vi.spyOn(f.provider, 'observeExactRecord').mockImplementation(
    (rootId, _recordId, authority) =>
      original(rootId, 'another-source-record', authority),
  );
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'restricted' });
  expect(open).not.toHaveBeenCalled();
});

test('hosted construction never grants personal source access, even after its environment flag is removed', async () => {
  vi.stubEnv(
    'STATION_HOSTED_TENANT_REGISTRY_FILE',
    '/unopened-hosted-registry',
  );
  const f = await fixture();
  delete process.env.STATION_HOSTED_TENANT_REGISTRY_FILE;
  const read = vi.spyOn(f.persistence, 'observeKnowledgeStoreRoots');
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'restricted' });
  expect(read).not.toHaveBeenCalled();
});
test('personal construction refuses a later hosted mode', async () => {
  const f = await fixture();
  vi.stubEnv(
    'STATION_HOSTED_TENANT_REGISTRY_FILE',
    '/unopened-hosted-registry',
  );
  const read = vi.spyOn(f.persistence, 'observeKnowledgeStoreRoots');
  expect(
    (
      (await (
        await f.app.request(f.path, { headers: f.headers() })
      ).json()) as any
    ).data,
  ).toEqual({ state: 'restricted' });
  expect(read).not.toHaveBeenCalled();
});
test('verified tenant ingress cannot inherit internal local personal-store access', async () => {
  const f = await fixture(true);
  const read = vi.spyOn(f.persistence, 'observeKnowledgeStoreRoots');
  const response = await f.app.request(
    f.path,
    {
      headers: {
        ...f.headers(),
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_TENANT_HEADER]: 'alpha',
      },
    },
    { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
  );
  expect(response.status).toBe(200);
  expect(f.tenantContexts).toEqual(['alpha']);
  expect(((await response.json()) as any).data).toEqual({
    state: 'restricted',
  });
  expect(read).not.toHaveBeenCalled();
});
