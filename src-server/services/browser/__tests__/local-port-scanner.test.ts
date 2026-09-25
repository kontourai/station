import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LocalPortScanner,
  maskCommandLine,
  type PortScannerDeps,
  parseLsofListeners,
  parseWindowsListeners,
  suggestionWarnings,
  suggestLocalTargets,
} from '../local-port-scanner.js';
import { deriveStationListeners } from '../station-listeners.js';

// Fixture workspaces live under the HOST temp dir, not the vitest run root:
// the run root nests under `<tmp>/station/`, and a `/station/` path segment
// is exactly what `STATION_PROCESS` flags, so every cwd under it would carry
// a spurious 'station-process' warning (station#2623). These suites remove
// their own roots in afterEach.
const fixtureTmp = (): string =>
  process.env.STATION_VITEST_HOST_TMPDIR ?? tmpdir();

const LSOF = [
  'p100',
  'cnode',
  'n*:5173',
  'n[::1]:5173',
  'p200',
  'cpython3',
  'n127.0.0.1:8000',
  'n192.168.1.20:9000',
  'p300',
  'cstation',
  'n127.0.0.1:4100',
  '',
].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function deps(overrides: Partial<PortScannerDeps> = {}): PortScannerDeps {
  return {
    platform: 'darwin',
    run: vi.fn(async () => ({ code: 0, stdout: LSOF })),
    readCwd: vi.fn(async () => null),
    readCommandLine: vi.fn(async () => null),
    probe: vi.fn(async () => true),
    now: () => new Date('2026-09-22T00:00:00Z'),
    ...overrides,
  };
}

describe('parsers', () => {
  test('lsof: loopback-reachable listeners only, one per port', () => {
    expect(parseLsofListeners(LSOF)).toEqual([
      { port: 4100, pid: 300, processName: 'station' },
      { port: 5173, pid: 100, processName: 'node' },
      { port: 8000, pid: 200, processName: 'python3' },
    ]);
  });

  test('Windows listener lines', () => {
    expect(
      parseWindowsListeners(
        '0.0.0.0|3000|44\r\n::|5173|55\r\n10.0.0.2|9000|66\r\n127.0.0.1|x|1\r\n',
      ),
    ).toEqual([
      { port: 3000, pid: 44, processName: null },
      { port: 5173, pid: 55, processName: null },
    ]);
  });
});

describe('LocalPortScanner', () => {
  test('a missing lsof is a typed unavailable, never an empty success', async () => {
    const scanner = new LocalPortScanner(
      () => [],

      deps({
        run: vi.fn(async () => ({ code: null, stdout: '', missing: true })),
      }),
    );
    expect(await scanner.scan()).toEqual({
      state: 'unavailable',
      reason: 'lsof is not installed',
    });
  });

  test('an lsof failure is unavailable; "no matches" (exit 1, no output) is an empty ok', async () => {
    expect(
      await new LocalPortScanner(
        () => [],

        deps({ run: vi.fn(async () => ({ code: 2, stdout: '' })) }),
      ).scan(),
    ).toMatchObject({ state: 'unavailable' });
    expect(
      await new LocalPortScanner(
        () => [],

        deps({ run: vi.fn(async () => ({ code: 1, stdout: '' })) }),
      ).scan(),
    ).toMatchObject({ state: 'ok', ports: [] });
  });

  test('unsupported platforms and a failing Windows query are unavailable', async () => {
    expect(
      await new LocalPortScanner(
        () => [],
        deps({ platform: 'freebsd' }),
      ).scan(),
    ).toMatchObject({
      state: 'unavailable',
    });
    expect(
      await new LocalPortScanner(
        () => [],

        deps({
          platform: 'win32',
          run: vi.fn(async () => ({ code: 1, stdout: '' })),
        }),
      ).scan(),
    ).toMatchObject({ state: 'unavailable' });
  });

  test('Windows lists ports but reports attribution unavailable', async () => {
    const result = await new LocalPortScanner(
      () => [],

      deps({
        platform: 'win32',
        run: vi.fn(async () => ({ code: 0, stdout: '127.0.0.1|5173|55\r\n' })),
      }),
    ).scan();
    expect(result).toMatchObject({ state: 'ok', attribution: 'unavailable' });
  });

  test('scans are on demand, single-flight and briefly cached', async () => {
    const d = deps();
    const scanner = new LocalPortScanner(() => [], d);
    await Promise.all([scanner.scan(), scanner.scan()]);
    await scanner.scan();
    expect(d.run).toHaveBeenCalledTimes(1);
  });
});

describe('suggestLocalTargets', () => {
  test('web listeners whose process runs inside the workspace, minus Station and registered ports', async () => {
    const workspace = mkdtempSync(join(fixtureTmp(), 'station-browser-ws-'));
    roots.push(workspace);
    mkdirSync(join(workspace, 'app'));
    const outside = mkdtempSync(join(fixtureTmp(), 'station-browser-other-'));
    roots.push(outside);
    const cwd: Record<number, string> = {
      100: join(workspace, 'app'),
      200: outside,
      300: workspace,
    };
    const scanner = new LocalPortScanner(
      () => [],

      deps({
        readCwd: vi.fn(async (pid: number) => cwd[pid] ?? null),
        // Every listener answers as a web server, so the OUTSIDE process
        // (pid 200, port 8000) is excluded only by the workspace check.
        probe: vi.fn(async () => true),
      }),
    );
    const listeners = deriveStationListeners({
      serverPort: 4100,
      configuredOrigins: [],
    });
    const scan = await scanner.scan();
    expect(
      await suggestLocalTargets(
        scan,
        { workspaceRoot: workspace, registered: [] },
        listeners,
      ),
    ).toEqual({
      state: 'ok',
      suggestions: [
        {
          host: 'localhost',
          port: 5173,
          label: 'node :5173',
          pid: 100,
          processName: 'node',
          commandLine: null,
          cwd: join(workspace, 'app'),
          selected: false,
          warnings: [],
        },
      ],
    });
    expect(
      await suggestLocalTargets(
        scan,
        {
          workspaceRoot: workspace,
          registered: [{ host: 'localhost', port: 5173 }],
        },
        listeners,
      ),
    ).toEqual({ state: 'ok', suggestions: [] });
  });

  test('no attribution or no workspace is unavailable, not an empty list', async () => {
    const listeners = deriveStationListeners({
      serverPort: 4100,
      configuredOrigins: [],
    });
    expect(
      await suggestLocalTargets(
        { state: 'ok', ports: [], attribution: 'unavailable', scannedAt: 'x' },
        { workspaceRoot: '/w', registered: [] },
        listeners,
      ),
    ).toMatchObject({ state: 'unavailable' });
    expect(
      await suggestLocalTargets(
        { state: 'ok', ports: [], attribution: 'cwd', scannedAt: 'x' },
        { workspaceRoot: undefined, registered: [] },
        listeners,
      ),
    ).toMatchObject({ state: 'unavailable' });
  });
});

describe('Project attribution by working directory', () => {
  test('a sibling directory sharing the workspace prefix is outside it', async () => {
    const root = mkdtempSync(join(fixtureTmp(), 'station-browser-prefix-'));
    roots.push(root);
    mkdirSync(join(root, 'proj'));
    mkdirSync(join(root, 'proj-2'));
    mkdirSync(join(root, 'proj', 'sub'));
    const cwd: Record<number, string> = {
      100: join(root, 'proj-2'),
      200: join(root, 'proj', 'sub'),
    };
    const scanner = new LocalPortScanner(
      () => [],
      deps({
        run: vi.fn(async () => ({
          code: 0,
          stdout: [
            'p100',
            'cnode',
            'n*:5173',
            'p200',
            'cnode',
            'n*:5174',
            '',
          ].join('\n'),
        })),
        readCwd: vi.fn(async (pid: number) => cwd[pid] ?? null),
        probe: vi.fn(async () => true),
      }),
    );
    const result = await suggestLocalTargets(
      await scanner.scan(),
      { workspaceRoot: join(root, 'proj'), registered: [] },
      deriveStationListeners({ serverPort: 4100, configuredOrigins: [] }),
    );
    expect(
      result.state === 'ok' && result.suggestions.map((s) => s.pid),
    ).toEqual([200]);
  });
});

describe('round 2: suggestion safety', () => {
  test('Station listener ports are dropped BEFORE any probe or process read', async () => {
    const d = deps();
    const scanner = new LocalPortScanner(() => [4100], d);
    const result = await scanner.scan();
    expect(result.state === 'ok' && result.ports.map((p) => p.port)).toEqual([
      5173, 8000,
    ]);
    expect(
      (d.probe as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual([5173, 8000]);
    expect(
      (d.readCwd as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual([100, 200]);
  });

  test('each suggestion carries pid, command line and cwd, is unselected, and warns on transitive reach', async () => {
    const workspace = mkdtempSync(join(fixtureTmp(), 'station-browser-ws-'));
    roots.push(workspace);
    const scanner = new LocalPortScanner(
      () => [],
      deps({
        readCwd: vi.fn(async () => workspace),
        readCommandLine: vi.fn(async (pid: number) =>
          pid === 100
            ? 'node /repo/node_modules/.bin/vite --port 5173'
            : 'python3 -m http.server 8000',
        ),
      }),
    );
    const result = await suggestLocalTargets(
      await scanner.scan(),
      { workspaceRoot: workspace, registered: [] },
      deriveStationListeners({ serverPort: 4100, configuredOrigins: [] }),
    );
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    const vite = result.suggestions.find((s) => s.port === 5173);
    expect(vite).toMatchObject({
      pid: 100,
      commandLine: 'node /repo/node_modules/.bin/vite --port 5173',
      cwd: workspace,
      selected: false,
      warnings: ['may-proxy'],
    });
    expect(result.suggestions.every((s) => s.selected === false)).toBe(true);
  });

  test.each([
    [
      {
        processName: 'node',
        commandLine: 'node /Users/me/dev/kontourai/station/dist/server.js',
        cwd: null,
      },
      ['station-process'],
    ],
    [
      { processName: 'station', commandLine: null, cwd: null },
      ['station-process'],
    ],
    [
      {
        processName: 'node',
        commandLine: 'npx @kontourai/station start',
        cwd: null,
      },
      ['station-process'],
    ],
    [
      {
        processName: 'node',
        commandLine: 'node vite',
        cwd: '/x/kontourai/station/src-ui',
      },
      ['station-process', 'may-proxy'],
    ],
    [
      {
        processName: 'node',
        commandLine: 'node vite',
        cwd: '/Users/me/dev/kontourai/station-worktrees/lane/src-ui',
      },
      ['station-process', 'may-proxy'],
    ],
    [
      {
        processName: 'node',
        commandLine: 'node server.js',
        cwd: '/tmp/station-browser-ws-1',
      },
      [],
    ],
    [
      { processName: 'nginx', commandLine: 'nginx -g daemon off;', cwd: null },
      ['may-proxy'],
    ],
    [
      {
        processName: 'python3',
        commandLine: 'python3 -m http.server',
        cwd: '/w',
      },
      [],
    ],
  ])('warnings for %j', (port, expected) => {
    expect(suggestionWarnings(port)).toEqual(expected);
  });
});

describe('nit: secrets are masked in suggestion command lines', () => {
  test.each([
    [
      'node server.js --api-key=sk_live_abc --port 5173',
      'node server.js --api-key=*** --port 5173',
    ],
    [
      'node server.js --token abc123 --port 5173',
      'node server.js --token *** --port 5173',
    ],
    [
      'env PASSWORD=hunter2 DB_AUTH=x node app.js',
      'env PASSWORD=*** DB_AUTH=*** node app.js',
    ],
    ['app --client-secret s3cr3t', 'app --client-secret ***'],
    ['app ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4', 'app ***'],
    ['app --url=eyJhbGciOiJIUzI1NiJ9xAbc123DEF456', 'app --url=***'],
    [
      'node /Users/me/dev/project/node_modules/.bin/vite --port 5173',
      'node /Users/me/dev/project/node_modules/.bin/vite --port 5173',
    ],
    ['app --token --verbose', 'app --token --verbose'],
  ])('%s', (input, expected) => {
    expect(maskCommandLine(input)).toBe(expected);
  });

  test('the suggestion payload carries the masked command line', async () => {
    const workspace = mkdtempSync(join(fixtureTmp(), 'station-browser-ws-'));
    roots.push(workspace);
    const scanner = new LocalPortScanner(
      () => [],
      deps({
        readCwd: vi.fn(async () => workspace),
        readCommandLine: vi.fn(
          async () => 'node dev.js --auth-token=supersecret',
        ),
      }),
    );
    const result = await suggestLocalTargets(
      await scanner.scan(),
      { workspaceRoot: workspace, registered: [] },
      deriveStationListeners({ serverPort: 4100, configuredOrigins: [] }),
    );
    expect(result.state === 'ok' && result.suggestions.length).toBeGreaterThan(
      0,
    );
    expect(
      result.state === 'ok' &&
        result.suggestions.every(
          (s) => s.commandLine === 'node dev.js --auth-token=***',
        ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('supersecret');
  });
});
