import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LocalPortScanner,
  type PortScannerDeps,
  parseLsofListeners,
  parseWindowsListeners,
  suggestLocalTargets,
} from '../local-port-scanner.js';
import { deriveStationListeners } from '../station-listeners.js';

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
        deps({ run: vi.fn(async () => ({ code: 2, stdout: '' })) }),
      ).scan(),
    ).toMatchObject({ state: 'unavailable' });
    expect(
      await new LocalPortScanner(
        deps({ run: vi.fn(async () => ({ code: 1, stdout: '' })) }),
      ).scan(),
    ).toMatchObject({ state: 'ok', ports: [] });
  });

  test('unsupported platforms and a failing Windows query are unavailable', async () => {
    expect(
      await new LocalPortScanner(deps({ platform: 'freebsd' })).scan(),
    ).toMatchObject({
      state: 'unavailable',
    });
    expect(
      await new LocalPortScanner(
        deps({
          platform: 'win32',
          run: vi.fn(async () => ({ code: 1, stdout: '' })),
        }),
      ).scan(),
    ).toMatchObject({ state: 'unavailable' });
  });

  test('Windows lists ports but reports attribution unavailable', async () => {
    const result = await new LocalPortScanner(
      deps({
        platform: 'win32',
        run: vi.fn(async () => ({ code: 0, stdout: '127.0.0.1|5173|55\r\n' })),
      }),
    ).scan();
    expect(result).toMatchObject({ state: 'ok', attribution: 'unavailable' });
  });

  test('scans are on demand, single-flight and briefly cached', async () => {
    const d = deps();
    const scanner = new LocalPortScanner(d);
    await Promise.all([scanner.scan(), scanner.scan()]);
    await scanner.scan();
    expect(d.run).toHaveBeenCalledTimes(1);
  });
});

describe('suggestLocalTargets', () => {
  test('web listeners whose process runs inside the workspace, minus Station and registered ports', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'station-browser-ws-'));
    roots.push(workspace);
    mkdirSync(join(workspace, 'app'));
    const outside = mkdtempSync(join(tmpdir(), 'station-browser-other-'));
    roots.push(outside);
    const cwd: Record<number, string> = {
      100: join(workspace, 'app'),
      200: outside,
      300: workspace,
    };
    const scanner = new LocalPortScanner(
      deps({
        readCwd: vi.fn(async (pid: number) => cwd[pid] ?? null),
        probe: vi.fn(async (port: number) => port !== 8000),
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
        { host: 'localhost', port: 5173, label: 'node :5173', pid: 100 },
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
