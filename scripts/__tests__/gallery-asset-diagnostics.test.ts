import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  createGalleryAssetDiagnostics,
  inventoryGalleryAssets,
  readGalleryLifecycle,
  retainGalleryAssetDiagnostics,
} from '../../tests/helpers/gallery-asset-diagnostics';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const makeTempDir = trackTempDirs();
const origin = 'http://localhost:5314';
const request = (path: string) => ({
  url: () => new URL(path, origin).href,
  method: () => 'GET',
  resourceType: () => 'script',
  redirectedFrom: () => null,
  failure: () => ({
    errorText: 'net::ERR_FAILED http://private.invalid/?token=DO_NOT_RETAIN',
  }),
  timing: () => ({
    startTime: 1000,
    domainLookupStart: -1,
    domainLookupEnd: -1,
    connectStart: -1,
    secureConnectionStart: -1,
    connectEnd: -1,
    requestStart: 1,
    responseStart: 2,
    responseEnd: 3,
  }),
});
type Collector = ReturnType<typeof createGalleryAssetDiagnostics>;
function response(
  collector: Collector,
  asset: ReturnType<typeof request>,
  status = 200,
  headerValue = async () => 'text/javascript; private=DO_NOT_RETAIN',
) {
  collector.response({
    request: () => asset,
    status: () => status,
    headerValue,
    fromServiceWorker: () => false,
  });
}
async function drainMetadata() {
  await Promise.resolve();
  await Promise.resolve();
}

it('observes all 95 screen scopes while keeping detail explicitly sampled and private', async () => {
  const screens = Array.from({ length: 95 }, (_, index) =>
    index === 19 ? 'telemetry-feedback-mobile' : `screen-${index + 1}`,
  );
  const collector = createGalleryAssetDiagnostics(origin, screens);
  for (let screen = 0; screen < screens.length; screen++) {
    collector.screen(screens[screen]);
    collector.request(
      request('http://foreign.invalid/assets/private.js?token=DO_NOT_RETAIN'),
    );
    collector.request(request('/private?token=DO_NOT_RETAIN'));
    for (let index = 0; index < 192; index++) {
      const asset = request(
        index === 191
          ? '/assets/PluginRegistryGate-example.js?token=DO_NOT_RETAIN#secret'
          : `/assets/chunk-${index}.js`,
      );
      collector.request(asset);
      const anomaly = (screen === 19 || screen === 94) && index >= 188;
      response(collector, asset, anomaly ? 503 : 200);
      if (anomaly) collector.failed(asset);
      else collector.finished(asset);
    }
    collector.screenFinished(screens[screen]);
    await drainMetadata();
  }
  const report = await collector.finish();
  expect(report.summary.complete).toBe(true);
  expect(
    report.summary.scopes.reduce((sum, scope) => sum + scope.requested, 0),
  ).toBe(18240);
  expect(
    report.summary.scopes
      .slice(1)
      .map((scope) => [
        scope.name,
        scope.requested,
        scope.responded,
        scope.finished + scope.failed,
        scope.entered,
        scope.ended,
      ]),
  ).toEqual(screens.map((name) => [name, 192, 192, 192, 1, 1]));
  const registry = report.dictionary.assets.findIndex(
    (asset) => asset.path === '/assets/PluginRegistryGate-example.js',
  );
  for (const ordinal of [20, 95]) {
    const scope = report.summary.scopes[ordinal];
    const requested = Buffer.from(scope.requestedAssets, 'base64');
    expect(requested[registry >> 3] & (1 << (registry & 7))).not.toBe(0);
    expect(scope.failed).toBe(4);
    expect(scope.overwritten).toBe(2);
    expect(report.details.rows).toContainEqual(
      expect.objectContaining({
        scope: ordinal,
        status: 503,
        failure: 'net::ERR_FAILED',
      }),
    );
  }
  expect(report.details.mode).toBe('SAMPLED');
  expect(report.details.exhaustive).toBe(false);
  expect(report.details.omitted).toBeGreaterThan(0);
  expect(report.incomplete).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(
    2 * 1024 * 1024,
  );
  expect(JSON.stringify(report)).not.toMatch(
    /DO_NOT_RETAIN|foreign|\/private|token=|#secret/,
  );
});

it('keeps late metadata with its request scope and fails closed on gaps and throwing metadata', async () => {
  const collector = createGalleryAssetDiagnostics(origin, ['first', 'second']);
  collector.screen('first');
  const late = request('/assets/late.js');
  collector.request(late);
  collector.screenFinished('first');
  collector.screen('second');
  response(collector, late);
  collector.finished(late);
  collector.finished(late);
  collector.screenFinished('second');
  const attributed = await collector.finish();
  expect(attributed.summary.complete).toBe(true);
  expect(attributed.summary.scopes[1]).toMatchObject({
    requested: 1,
    responded: 1,
    finished: 1,
    duplicate: 1,
  });
  expect(attributed.summary.scopes[2]).toMatchObject({
    requested: 0,
    responded: 0,
    finished: 0,
    duplicate: 0,
  });

  const throwing = createGalleryAssetDiagnostics(origin, []);
  const broken = {
    ...request('/assets/broken.js'),
    url: () => {
      throw new Error('DO_NOT_RETAIN http://private.invalid/?secret');
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
    ...request('/assets/timing.js'),
    timing: () => {
      throw new Error('DO_NOT_RETAIN');
    },
  };
  throwing.request(badTiming);
  expect(() => throwing.finished(badTiming)).not.toThrow();
  const badFailure = {
    ...request('/assets/failure.js'),
    failure: () => {
      throw new Error('DO_NOT_RETAIN');
    },
  };
  throwing.request(badFailure);
  expect(() => throwing.failed(badFailure)).not.toThrow();
  const errors = await throwing.finish();
  expect(errors.summary.scopes[0].metadataErrors).toBe(6);
  expect(errors.summary.complete).toBe(false);
  expect(JSON.stringify(errors)).not.toContain('DO_NOT_RETAIN');

  for (const mode of [
    'missing-response',
    'missing-terminal',
    'missing-scope',
    'out-of-order',
    'unmatched',
  ] as const) {
    const missing = createGalleryAssetDiagnostics(origin, ['a', 'b']);
    missing.screen(mode === 'out-of-order' ? 'b' : 'a');
    const asset = request('/assets/gap.js');
    if (mode !== 'unmatched') missing.request(asset);
    if (mode !== 'missing-response') response(missing, asset);
    if (mode !== 'missing-terminal') missing.finished(asset);
    missing.screenFinished(mode === 'out-of-order' ? 'b' : 'a');
    if (mode !== 'missing-scope') {
      missing.screen(mode === 'out-of-order' ? 'a' : 'b');
      missing.screenFinished(mode === 'out-of-order' ? 'a' : 'b');
    }
    expect((await missing.finish()).summary.complete, mode).toBe(false);
  }
  const crowded = createGalleryAssetDiagnostics(origin, []);
  for (let index = 0; index < 1025; index++)
    crowded.request(request(`/assets/active-${index}.js`));
  const crowdedReport = await crowded.finish();
  expect(crowdedReport.summary.activeOverflows).toBe(1);
  expect(crowdedReport.summary.complete).toBe(false);

  const dictionary = createGalleryAssetDiagnostics(origin, []);
  for (let index = 0; index < 4097; index++) {
    const asset = request(`/assets/dictionary-${index}.js`);
    dictionary.request(asset);
    response(dictionary, asset);
    dictionary.finished(asset);
    await drainMetadata();
  }
  const dictionaryReport = await dictionary.finish();
  expect(dictionaryReport.summary.dictionaryOverflows).toBe(1);
  expect(dictionaryReport.summary.complete).toBe(false);

  let release: (value: string) => void = () => {
    throw new Error('Header resolver not registered');
  };
  const header = new Promise<string>((resolve) => {
    release = resolve;
  });
  const pending = createGalleryAssetDiagnostics(origin, []);
  const asset = request('/assets/pending.js');
  pending.request(asset);
  response(pending, asset, 200, () => header);
  pending.finished(asset);
  const pendingReport = await pending.finish();
  expect(pendingReport.summary.pending).toBe(1);
  expect(pendingReport.summary.complete).toBe(false);
  release('text/javascript');
  await drainMetadata();
});

it('deduplicates literal references without claiming a full graph or an unbounded identity scan', () => {
  const root = makeTempDir('gallery-asset-privacy-');
  try {
    mkdirSync(join(root, 'assets'));
    writeFileSync(
      join(root, 'index.html'),
      '<script type="module" src="/assets/entry.js"></script>',
    );
    writeFileSync(
      join(root, 'assets/entry.js'),
      'import("./registry.js");'.repeat(5000) + 'const secret="DO_NOT_RETAIN";',
    );
    writeFileSync(join(root, 'assets/registry.js'), 'export const ready=true;');
    const before = inventoryGalleryAssets(root);
    expect(before.fileInventoryComplete).toBe(true);
    expect(before.referenceProjectionComplete).toBe(true);
    expect(before.occurrences).toBe(5001);
    expect(before.references).toHaveLength(2);
    expect(before.references).toContainEqual(
      expect.objectContaining({
        from: 'assets/entry.js',
        target: 'assets/registry.js',
        count: 5000,
        firstOffset: 7,
      }),
    );
    expect(JSON.stringify(before)).not.toContain('DO_NOT_RETAIN');
    writeFileSync(
      join(root, 'assets/registry.js'),
      'export const ready= true;',
    );
    expect(inventoryGalleryAssets(root).identity).not.toBe(before.identity);
    for (let from = 0; from < 100; from++)
      writeFileSync(
        join(root, `assets/a${from}.js`),
        Array.from(
          { length: 100 },
          (_, target) => `import("./a${target}.js");`,
        ).join(''),
      );
    const edges = inventoryGalleryAssets(root);
    expect(edges.fileInventoryComplete).toBe(true);
    expect(edges.referenceProjectionComplete).toBe(false);
    expect(edges.occurrences).toBe(15001);
    expect(edges.omittedEdgeObservations).toBeGreaterThan(0);
    writeFileSync(join(root, 'assets/oversize.js'), '');
    truncateSync(join(root, 'assets/oversize.js'), 64 * 1024 * 1024 + 1);
    expect(inventoryGalleryAssets(root).fileInventoryComplete).toBe(false);
    writeFileSync(
      join(root, 'lifecycle.ndjson'),
      `${JSON.stringify({ type: 'started', timestamp: '2026-11-04T00:00:00.000Z', pid: 123, sha: 'abcdef1234', private: 'DO_NOT_RETAIN' })}\n`,
    );
    const lifecycle = readGalleryLifecycle(join(root, 'lifecycle.ndjson'));
    expect(lifecycle.incomplete).toBe(false);
    expect(JSON.stringify(lifecycle)).not.toContain('DO_NOT_RETAIN');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('accounts fresh owned JSON once and preserves evidence on folder, provenance or writer failure', async () => {
  const root = makeTempDir('gallery-diagnostic-budget-');
  const emitted = makeTempDir('gallery-emitted-budget-');
  mkdirSync(join(emitted, 'assets'));
  writeFileSync(
    join(emitted, 'index.html'),
    '<script src="/assets/entry.js"></script>',
  );
  writeFileSync(join(emitted, 'assets/entry.js'), 'export const ready=true;');
  const inventory = inventoryGalleryAssets(emitted);
  const network = await createGalleryAssetDiagnostics(origin, []).finish();
  for (let index = 0; index < 7; index++)
    writeFileSync(
      join(root, `retained-${index}.png`),
      Buffer.alloc(index === 0 ? 621707 - 6 * 80000 : 80000),
    );
  const result = retainGalleryAssetDiagnostics(
    root,
    network,
    inventory,
    inventory,
    { complete: true, checkout: { sha: 'a'.repeat(40), dirty: false } },
  );
  const actual = readdirSync(root).reduce(
    (sum, file) => sum + readFileSync(join(root, file)).length,
    0,
  );
  expect(result.retention).toBe('RETAINED');
  expect(result.totalBytes).toBe(actual);
  expect(actual).toBeLessThanOrEqual(4 * 1024 * 1024);
  const output = readFileSync(join(root, 'asset-network-v2.json'));
  expect(output.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(JSON.parse(output.toString()).emittedAfter.files).toEqual([]);
  expect(
    retainGalleryAssetDiagnostics(root, network, inventory, inventory, {
      complete: true,
    }).retention,
  ).toBe('INCOMPLETE');
  expect(readFileSync(join(root, 'asset-network-v2.json'))).toEqual(output);

  for (const error of ['DIRTY_CHECKOUT', 'GIT_IDENTITY_READ_FAILED']) {
    const folder = makeTempDir('gallery-provenance-negative-');
    const retained = retainGalleryAssetDiagnostics(
      folder,
      network,
      inventory,
      inventory,
      { complete: false, checkout: { error } },
    );
    expect(retained.incomplete).toBe(true);
    expect(
      JSON.parse(readFileSync(join(folder, 'asset-network-v2.json'), 'utf8'))
        .incomplete,
    ).toBe(true);
  }
  const full = makeTempDir('gallery-over-budget-');
  const evidence = join(full, 'preserved.png');
  writeFileSync(evidence, Buffer.alloc(4 * 1024 * 1024 + 1));
  const tooLarge = retainGalleryAssetDiagnostics(
    full,
    network,
    inventory,
    inventory,
    { complete: true },
  );
  expect(tooLarge.retention).toBe('INCOMPLETE');
  expect(readdirSync(full)).toEqual(['preserved.png']);
  expect(readFileSync(evidence).length).toBe(4 * 1024 * 1024 + 1);
  const obstructed = makeTempDir('gallery-write-failure-');
  mkdirSync(join(obstructed, 'asset-network-v2.json'));
  expect(
    retainGalleryAssetDiagnostics(obstructed, network, inventory, inventory, {
      complete: true,
    }).retention,
  ).toBe('INCOMPLETE');
});

it('reserves late-scope metadata anomalies after a good normal receipt without leaking exceptions', async () => {
  const names = Array.from(
    { length: 95 },
    (_, index) => `metadata-screen-${index + 1}`,
  );
  for (const kind of [
    'status',
    'service-worker',
    'header',
    'timing',
  ] as const) {
    const collector = createGalleryAssetDiagnostics(origin, names);
    for (let index = 0; index < names.length; index++) {
      collector.screen(names[index]);
      const good = request('/assets/good.js');
      collector.request(good);
      response(collector, good);
      collector.finished(good);
      if (index === 19 || index === 94) {
        const bad = {
          ...request('/assets/late-metadata.js'),
          timing:
            kind === 'timing'
              ? () => {
                  throw new Error(
                    'DO_NOT_RETAIN http://private.invalid/?token=secret',
                  );
                }
              : good.timing,
        };
        collector.request(bad);
        collector.response({
          request: () => bad,
          status: () => {
            if (kind === 'status') throw new Error('DO_NOT_RETAIN');
            return 200;
          },
          fromServiceWorker: () => {
            if (kind === 'service-worker') throw new Error('DO_NOT_RETAIN');
            return false;
          },
          headerValue: async () => {
            if (kind === 'header') throw new Error('DO_NOT_RETAIN');
            return 'text/javascript';
          },
        });
        collector.finished(bad);
      }
      collector.screenFinished(names[index]);
      await drainMetadata();
    }
    const report = await collector.finish();
    expect(report.summary.complete).toBe(false);
    expect(
      report.summary.scopes.reduce(
        (sum, scope) => sum + scope.metadataErrors,
        0,
      ),
    ).toBe(2);
    for (const ordinal of [20, 95]) {
      expect(report.summary.scopes[ordinal]).toMatchObject({
        metadataErrors: 1,
        anomalies: 1,
      });
      expect(report.details.rows).toContainEqual(
        expect.objectContaining({
          scope: ordinal,
          metadataError:
            kind === 'header'
              ? 'HEADER_METADATA'
              : kind === 'timing'
                ? 'TIMING_METADATA'
                : 'RESPONSE_METADATA',
        }),
      );
    }
    expect(JSON.stringify(report)).not.toMatch(
      /DO_NOT_RETAIN|private.invalid|token=/,
    );
  }
});

it('rejects removed, replaced, growing or symlinked owned diagnostics through the existing filesystem boundary', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const emitted = makeTempDir('gallery-stable-emitted-');
  mkdirSync(join(emitted, 'assets'));
  writeFileSync(
    join(emitted, 'index.html'),
    '<script src="/assets/entry.js"></script>',
  );
  writeFileSync(join(emitted, 'assets/entry.js'), 'export const ready=true;');
  const inventory = inventoryGalleryAssets(emitted);
  const network = await createGalleryAssetDiagnostics(origin, []).finish();
  try {
    for (const mode of ['missing', 'changed'] as const) {
      const folder = makeTempDir('gallery-owned-output-negative-');
      const sentinel = join(folder, 'preserved.png');
      const output = join(folder, 'asset-network-v2.json');
      writeFileSync(sentinel, 'preserve exactly');
      vi.mocked(writeFileSync).mockImplementationOnce(
        (...args: Parameters<typeof writeFileSync>) => {
          actual.writeFileSync(...args);
          if (mode === 'missing') actual.rmSync(output);
          else
            actual.writeFileSync(
              output,
              Buffer.alloc(actual.statSync(output).size, 65),
            );
        },
      );
      const result = retainGalleryAssetDiagnostics(
        folder,
        network,
        inventory,
        inventory,
        { complete: true },
      );
      expect(result).toMatchObject({
        retention: 'INCOMPLETE',
        postWriteComplete: false,
      });
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve exactly');
      vi.mocked(writeFileSync)
        .mockReset()
        .mockImplementation(actual.writeFileSync);
    }
    const growing = makeTempDir('gallery-growing-inspection-');
    const evidence = join(growing, 'preserved.png');
    writeFileSync(evidence, Buffer.alloc(128, 65));
    vi.mocked(readSync).mockImplementationOnce(
      (...args: Parameters<typeof readSync>) => {
        const count = actual.readSync(...args);
        actual.appendFileSync(evidence, Buffer.alloc(16 * 1024 * 1024));
        return count;
      },
    );
    const growth = retainGalleryAssetDiagnostics(
      growing,
      network,
      inventory,
      inventory,
      { complete: true },
    );
    expect(growth).toMatchObject({
      retention: 'INCOMPLETE',
      reason: 'UNSAFE_OR_UNSTABLE_INSPECTION',
      totalBytes: null,
      inspectedBytes: 128,
    });
    expect(existsSync(join(growing, 'asset-network-v2.json'))).toBe(false);
    expect(actual.statSync(evidence).size).toBe(128 + 16 * 1024 * 1024);
    vi.mocked(readSync).mockReset().mockImplementation(actual.readSync);

    const linkParent = makeTempDir('gallery-root-link-');
    const target = makeTempDir('gallery-preserved-link-target-');
    writeFileSync(join(target, 'sentinel.txt'), 'target unchanged');
    const link = join(linkParent, 'root-link');
    try {
      symlinkSync(
        target,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      throw new Error(
        'BLOCKED: host cannot create the diagnostic root symlink control; this is not a passing refusal test.',
        { cause: error },
      );
    }
    vi.mocked(readSync).mockClear();
    expect(
      retainGalleryAssetDiagnostics(link, network, inventory, inventory, {
        complete: true,
      }).retention,
    ).toBe('INCOMPLETE');
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
    expect(existsSync(join(target, 'asset-network-v2.json'))).toBe(false);
    expect(readFileSync(join(target, 'sentinel.txt'), 'utf8')).toBe(
      'target unchanged',
    );
    const descendant = makeTempDir('gallery-descendant-link-');
    try {
      symlinkSync(
        target,
        join(descendant, 'child-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      throw new Error(
        'BLOCKED: host cannot create the diagnostic descendant symlink control; no refusal pass is inferred.',
        { cause: error },
      );
    }
    expect(
      retainGalleryAssetDiagnostics(descendant, network, inventory, inventory, {
        complete: true,
      }).retention,
    ).toBe('INCOMPLETE');
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
    expect(existsSync(join(descendant, 'asset-network-v2.json'))).toBe(false);
  } finally {
    vi.mocked(readSync).mockReset().mockImplementation(actual.readSync);
    vi.mocked(writeFileSync)
      .mockReset()
      .mockImplementation(actual.writeFileSync);
  }
});
