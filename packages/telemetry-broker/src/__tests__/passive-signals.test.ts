import { createServer } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

test('passive report follows release and asset pagination and refuses partial counts', async () => {
  let fail = false;
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/downloads/')) {
      res.end(
        JSON.stringify({
          package: '@kontourai/station-cli',
          start: '2026-10-01',
          end: '2026-10-07',
          downloads: 7,
        }),
      );
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname.endsWith('/releases')) {
      if (url.searchParams.get('page') === '1')
        res.setHeader('Link', '<https://api.github.com/ignored>; rel="next"');
      res.end(
        JSON.stringify([
          { id: url.searchParams.get('page') === '1' ? 1 : 2, tag_name: 'v1' },
        ]),
      );
      return;
    }
    if (url.searchParams.get('page') === '1')
      res.setHeader('Link', '<https://api.github.com/ignored>; rel="next"');
    res.end(
      JSON.stringify([{ name: 'station.zip', download_count: fail ? -1 : 3 }]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('fixture listener missing');
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input));
    expect(['api.github.com', 'api.npmjs.org']).toContain(url.hostname);
    return originalFetch(
      `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
      init,
    );
  });
  try {
    // @ts-expect-error The report is a Node ESM tool, consumed directly without a TS declaration.
    const { collectPassiveSignals } = await import('../../passive-signals.mjs');
    const report = await collectPassiveSignals();
    expect(report.npm.map((n: { downloads: number }) => n.downloads)).toEqual([
      7, 7, 7,
    ]);
    expect(report.totalAssetDownloads).toBe(12);
    expect(report.releases).toHaveLength(2);
    expect(paths).toContain(
      '/repos/kontourai/station/releases/2/assets?per_page=100&page=2',
    );
    fail = true;
    await expect(collectPassiveSignals()).rejects.toThrow(
      'Invalid public download count',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
