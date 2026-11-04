import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  createGalleryAssetDiagnostics,
  inventoryGalleryAssets,
  readGalleryLifecycle,
} from '../../tests/helpers/gallery-asset-diagnostics';

it('retains only public asset metadata and marks bounded collection incomplete', async () => {
  const collector = createGalleryAssetDiagnostics('http://localhost:5314');
  collector.screen('telemetry-feedback-mobile');
  const request = (url: string) => ({
    url: () => url,
    method: () => 'GET',
    resourceType: () => 'script',
    redirectedFrom: () => null,
    failure: () => ({
      errorText:
        'net::ERR_FAILED http://localhost:5314/private?token=DO_NOT_RETAIN',
    }),
    timing: () => ({
      startTime: 1000,
      domainLookupStart: -1,
      domainLookupEnd: -1,
      connectStart: -1,
      secureConnectionStart: -1,
      connectEnd: -1,
      requestStart: 1,
      responseStart: -1,
      responseEnd: -1,
    }),
  });
  const throwing = createGalleryAssetDiagnostics('http://localhost:5314');
  const broken = {
    ...request('http://localhost:5314/assets/broken.js'),
    url: () => {
      throw new Error('DO_NOT_RETAIN http://private.invalid/?token=secret');
    },
  };
  expect(() => throwing.request(broken)).not.toThrow();
  expect(() =>
    throwing.response({
      request: () => broken,
      status: () => 200,
      headerValue: async () => 'text/javascript',
      fromServiceWorker: () => false,
    }),
  ).not.toThrow();
  expect(() => throwing.finished(broken)).not.toThrow();
  expect(() => throwing.failed(broken)).not.toThrow();
  const badTiming = {
    ...request('http://localhost:5314/assets/timing.js'),
    timing: () => {
      throw new Error('DO_NOT_RETAIN');
    },
  };
  expect(() => throwing.finished(badTiming)).not.toThrow();
  const badFailure = {
    ...request('http://localhost:5314/assets/failure.js'),
    failure: () => {
      throw new Error('DO_NOT_RETAIN');
    },
  };
  expect(() => throwing.failed(badFailure)).not.toThrow();
  const observationErrors = await throwing.finish();
  expect(observationErrors.metadataErrors).toBe(6);
  expect(observationErrors.incomplete).toBe(true);
  expect(JSON.stringify(observationErrors)).not.toContain('DO_NOT_RETAIN');
  collector.request(
    request('http://elsewhere.invalid/assets/private.js?token=DO_NOT_RETAIN'),
  );
  collector.request(
    request('http://localhost:5314/private?token=DO_NOT_RETAIN'),
  );
  const asset = request(
    'http://localhost:5314/assets/PluginRegistryGate-example.js?token=DO_NOT_RETAIN#secret',
  );
  collector.request(asset);
  collector.response({
    request: () => asset,
    status: () => 200,
    headerValue: async () => 'text/javascript; private=DO_NOT_RETAIN',
    fromServiceWorker: () => false,
  });
  collector.failed(asset);
  await Promise.resolve();
  for (let index = 0; index < 600; index++) {
    const next = request(`http://localhost:5314/assets/chunk-${index}.js`);
    collector.request(next);
    collector.finished(next);
  }
  for (let index = 0; index < 2500; index++) collector.finished(asset);
  const result = await collector.finish();
  const json = JSON.stringify(result);
  expect(json).not.toMatch(/DO_NOT_RETAIN|elsewhere|\/private|token=|#secret/);
  expect(result.records).toContainEqual(
    expect.objectContaining({
      event: 'response',
      status: 200,
      mime: 'text/javascript',
      fromServiceWorker: false,
      cache: 'UNKNOWN',
    }),
  );
  expect(result.records).toContainEqual(
    expect.objectContaining({
      event: 'failed',
      failureCode: 'net::ERR_FAILED',
    }),
  );
  expect(result.requests).toBe(512);
  expect(result.dropped).toBeGreaterThan(0);
  expect(result.incomplete).toBe(true);
  expect(result.records.length).toBe(2048);
  expect(Buffer.byteLength(json)).toBeLessThan(2 * 1024 * 1024);

  const root = mkdtempSync(join(tmpdir(), 'gallery-asset-privacy-'));
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(
      join(root, 'index.html'),
      '<script type="module" src="/assets/entry.js"></script>',
    );
    writeFileSync(
      join(root, 'assets/entry.js'),
      'import("./registry.js"); const secret="DO_NOT_RETAIN";',
    );
    writeFileSync(join(root, 'assets/registry.js'), 'export const ready=true;');
    writeFileSync(
      join(root, 'lifecycle.ndjson'),
      JSON.stringify({
        type: 'started',
        timestamp: '2026-11-04T00:00:00.000Z',
        pid: 123,
        sha: 'abcdef1234',
        private: 'DO_NOT_RETAIN',
      }) + '\n',
    );
    const lifecycle = readGalleryLifecycle(join(root, 'lifecycle.ndjson'));
    expect(lifecycle.incomplete).toBe(false);
    expect(lifecycle.events).toContainEqual(
      expect.objectContaining({ type: 'started', pid: 123 }),
    );
    expect(JSON.stringify(lifecycle)).not.toContain('DO_NOT_RETAIN');
    const inventory = inventoryGalleryAssets(root);
    expect(inventory.incomplete).toBe(false);
    expect(inventory.files).toContainEqual(
      expect.objectContaining({
        path: 'assets/registry.js',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(inventory.references).toContainEqual({
      from: 'assets/entry.js',
      target: 'registry.js',
      offset: 7,
    });
    expect(JSON.stringify(inventory)).not.toContain('DO_NOT_RETAIN');
    writeFileSync(join(root, 'assets/oversize.js'), '');
    truncateSync(join(root, 'assets/oversize.js'), 64 * 1024 * 1024 + 1);
    expect(inventoryGalleryAssets(root).incomplete).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
