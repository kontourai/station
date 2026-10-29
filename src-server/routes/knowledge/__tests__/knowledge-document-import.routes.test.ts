import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import {
  KnowledgeDocumentImportError,
  KnowledgeDocumentImportService,
} from '../../../services/knowledge/knowledge-document-import-service.js';
import { createKnowledgeDocumentImportRoutes } from '../knowledge-document-import-routes.js';

const makeTemp = trackTempDirs();
let app: Hono;
let provider: KnowledgeStoreProvider;
let root: KnowledgeStoreRoot;
let operator: boolean;
let canRead: boolean;
let responseCurrent: boolean;
let admittedRequest: Request | undefined;
const original = Buffer.from('\ufeff\n\nSource evidence\r\n');
const path = (requestId: string) =>
  `/roots/${root.id}/document-imports/${requestId}`;
const post = (url: string, value: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
const selection = () => ({
  requestId: randomUUID(),
  expectedRoot: root,
  documents: [
    { filename: 'evidence.md', contentBase64: original.toString('base64') },
  ],
});

beforeEach(async () => {
  const home = makeTemp('document-import-route-');
  vi.stubEnv('STATION_HOME', home);
  mkdirSync(join(home, 'config'), { recursive: true });
  provider = new KnowledgeStoreProvider(new FileStorageAdapter(home));
  root = await provider.createRoot({
    scope: { kind: 'project', projectSlug: 'research' },
    projectId: randomUUID(),
    adapterId: 'kit-default-store',
    storeRoot: join(home, 'store'),
    displayName: 'Research',
  });
  operator = canRead = responseCurrent = true;
  admittedRequest = undefined;
  app = new Hono();
  app.use('*', async (c, next) => {
    admittedRequest = c.req.raw;
    await next();
  });
  app.route(
    '/',
    createKnowledgeDocumentImportRoutes({
      service: new KnowledgeDocumentImportService(home, provider),
      authority: (request) => ({
        actorId: 'human:local:operator',
        assertCurrent: () => {
          if (!operator || request !== admittedRequest)
            throw new KnowledgeDocumentImportError('Operator required.', 403);
        },
      }),
      mayReadRoot: async () => canRead,
      guardReadResponse: async (_request, _roots, response) =>
        responseCurrent ? response : new Response(null, { status: 403 }),
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

test('bounded HTTP upload preserves admitted Request identity and downloads exact original bytes', async () => {
  const input = selection();
  const response = await post('/document-imports', input);
  expect(response.status).toBe(200);
  expect(await readJson(response)).toMatchObject({
    success: true,
    data: { phase: 'imported' },
  });
  const receipt = await app.request(path(input.requestId));
  expect(receipt.status).toBe(200);
  const download = await app.request(`${path(input.requestId)}/originals/0`);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer())).toEqual(original);
  expect(download.headers.get('content-disposition')).toContain('attachment;');
  expect(download.headers.get('cache-control')).toBe('no-store');
});

test('non-operator cannot upload, observe receipts or resume, while permitted Project readers can download originals', async () => {
  const input = selection();
  expect((await post('/document-imports', input)).status).toBe(200);
  operator = false;
  expect((await post('/document-imports', selection())).status).toBe(403);
  expect((await app.request(path(input.requestId))).status).toBe(403);
  expect(
    (
      await post(`${path(input.requestId)}/resume`, {
        expectedRoot: root,
        retryUncertain: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (await app.request(`${path(input.requestId)}/originals/0`)).status,
  ).toBe(200);
  canRead = false;
  expect(
    (await app.request(`${path(input.requestId)}/originals/0`)).status,
  ).toBe(404);
});

test('oversized, malformed and mismatched HTTP requests publish no records', async () => {
  expect(
    (
      await app.request('/document-imports', {
        method: 'POST',
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
      })
    ).status,
  ).toBe(400);
  expect(
    (await app.request('/document-imports', { method: 'POST', body: '{' }))
      .status,
  ).toBe(400);
  expect(
    (
      await post(`${path(randomUUID())}/resume`, {
        expectedRoot: { ...root, id: 'other' },
        retryUncertain: true,
      })
    ).status,
  ).toBe(400);
  expect(await (await provider.adapterFor(root.id)).listByType('raw')).toEqual(
    [],
  );
});

test('receipt and original responses use the final response authority guard', async () => {
  const input = selection();
  expect((await post('/document-imports', input)).status).toBe(200);
  responseCurrent = false;
  expect((await post('/document-imports', selection())).status).toBe(403);
  expect((await app.request(path(input.requestId))).status).toBe(403);
  expect(
    (await app.request(`${path(input.requestId)}/originals/0`)).status,
  ).toBe(403);
});
