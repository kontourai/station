import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CHROME_FOR_TESTING_PIN,
  type ChromeForTestingPin,
  ChromiumAcquisition,
  type ChromiumAcquisitionDeps,
  ChromiumConsentRequiredError,
  chromiumInstallRoot,
  systemBrowserCandidates,
} from '../chromium-acquisition.js';

const ARCHIVE = Buffer.from('pretend-this-is-a-chromium-zip');
const ARCHIVE_MD5 = createHash('md5').update(ARCHIVE).digest('base64');
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE).digest('hex');

function testPin(
  overrides: Partial<{ bytes: number; md5: string; sha256: string }> = {},
) {
  const build = {
    bytes: overrides.bytes ?? ARCHIVE.length,
    md5: overrides.md5 ?? ARCHIVE_MD5,
    sha256: overrides.sha256 ?? ARCHIVE_SHA256,
    executable: ['chrome-mac-arm64', 'Chromium.app', 'chrome'],
  };
  return {
    version: '1.2.3.4',
    baseUrl: 'https://cft.invalid/base',
    builds: {
      'mac-arm64': build,
      'mac-x64': build,
      linux64: build,
      'linux-arm64': build,
      win64: build,
      win32: build,
    },
  } satisfies ChromeForTestingPin;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function harness(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    env?: NodeJS.ProcessEnv;
    installed?: string[];
    pin?: ChromeForTestingPin;
    body?: Buffer;
    contentLength?: string | null;
    status?: number;
    extract?: ChromiumAcquisitionDeps['extract'];
    entries?: string[];
  } = {},
) {
  const stationHome = mkdtempSync(join(tmpdir(), 'station-cft-home-'));
  homes.push(stationHome);
  const installed = new Set(options.installed ?? []);
  const body = options.body ?? ARCHIVE;
  const fetchMock = vi.fn(async (_url: string | URL | Request) => {
    const headers = new Headers();
    const length =
      options.contentLength === undefined
        ? String(body.length)
        : options.contentLength;
    if (length !== null) headers.set('content-length', length);
    return new Response(new Uint8Array(body), {
      status: options.status ?? 200,
      headers,
    });
  });
  const extract =
    options.extract ??
    vi.fn(async (_zip: string, dest: string) => {
      const dir = join(dest, 'chrome-mac-arm64', 'Chromium.app');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'chrome'), '#!/bin/sh\n');
    });
  const deps: ChromiumAcquisitionDeps = {
    platform: options.platform ?? 'darwin',
    arch: options.arch ?? 'arm64',
    env: options.env ?? {},
    homeDir: '/Users/someone',
    // Only the fake installs and files this test's own Station home holds:
    // the host's real browsers must never leak into these decisions.
    isExecutableFile: (path) =>
      installed.has(path) || (path.startsWith(stationHome) && existsSync(path)),
    fetch: fetchMock as unknown as typeof fetch,
    extract,
    listEntries: vi.fn(
      async () =>
        options.entries ?? [
          'chrome-mac-arm64/',
          'chrome-mac-arm64/Chromium.app/chrome',
        ],
    ),
    pin: options.pin ?? testPin(),
  };
  return {
    stationHome,
    acquisition: new ChromiumAcquisition(stationHome, deps),
    fetchMock,
    extract,
  };
}

describe('system browser detection', () => {
  test('macOS prefers installed Google Chrome, then Edge, and never fetches', () => {
    const chrome =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge =
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const both = harness({ installed: [edge, chrome] });
    expect(both.acquisition.status()).toEqual({
      state: 'found-system',
      executablePath: chrome,
      browser: 'google-chrome',
    });
    const edgeOnly = harness({ installed: [edge] });
    expect(edgeOnly.acquisition.status()).toMatchObject({
      state: 'found-system',
      browser: 'microsoft-edge',
    });
    const userApps = harness({
      installed: [
        '/Users/someone/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
    });
    expect(userApps.acquisition.resolveExecutable()).toBe(
      '/Users/someone/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(both.fetchMock).not.toHaveBeenCalled();
  });

  test('Windows checks Program Files and LocalAppData for Chrome and Edge', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    };
    const candidates = systemBrowserCandidates(
      'win32',
      env,
      'C:\\Users\\me',
    ).map((c) => c.path);
    expect(candidates).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
    ]);
    const { acquisition } = harness({
      platform: 'win32',
      arch: 'x64',
      env,
      installed: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    });
    expect(acquisition.status()).toMatchObject({
      state: 'found-system',
      browser: 'microsoft-edge',
    });
  });

  test('Linux searches PATH for Chrome, Edge and Chromium names', () => {
    const { acquisition } = harness({
      platform: 'linux',
      arch: 'x64',
      env: { PATH: '/usr/local/bin:relative/bin:/usr/bin' },
      installed: ['/usr/bin/chromium-browser'],
    });
    expect(acquisition.status()).toEqual({
      state: 'found-system',
      executablePath: '/usr/bin/chromium-browser',
      browser: 'chromium',
    });
    // Relative PATH entries are never trusted.
    expect(
      systemBrowserCandidates('linux', { PATH: 'relative/bin' }, '/h'),
    ).toEqual([]);
  });
});

describe('consent gate', () => {
  test('with nothing installed, status is needs-consent and nothing is fetched', () => {
    const { acquisition, fetchMock, stationHome } = harness();
    expect(acquisition.status()).toEqual({
      state: 'needs-consent',
      version: '1.2.3.4',
      platform: 'mac-arm64',
      downloadBytes: ARCHIVE.length,
      installDir: join(chromiumInstallRoot(stationHome), '1.2.3.4'),
    });
    expect(acquisition.resolveExecutable()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [undefined],
    [{}],
    [{ consent: false }],
    [{ consent: 'true' }],
    [{ consent: 1 }],
  ])('startDownload(%j) is refused before any I/O', (request) => {
    const { acquisition, fetchMock, extract, stationHome } = harness();
    expect(() =>
      acquisition.startDownload(request as unknown as { consent: true }),
    ).toThrow(ChromiumConsentRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(existsSync(chromiumInstallRoot(stationHome))).toBe(false);
    expect(acquisition.status().state).toBe('needs-consent');
  });

  test('an installed browser makes a consented download a no-op', async () => {
    const chrome =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const { acquisition, fetchMock } = harness({ installed: [chrome] });
    const { status, completion } = acquisition.startDownload({ consent: true });
    await completion;
    expect(status.state).toBe('found-system');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('consented download', () => {
  test('fetches the pinned URL, verifies, extracts, and reports downloaded', async () => {
    const { acquisition, fetchMock, stationHome } = harness();
    const { status, completion } = acquisition.startDownload({ consent: true });
    expect(status).toMatchObject({
      state: 'downloading',
      version: '1.2.3.4',
      totalBytes: ARCHIVE.length,
    });
    await completion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://cft.invalid/base/1.2.3.4/mac-arm64/chrome-mac-arm64.zip',
    );
    const installDir = join(chromiumInstallRoot(stationHome), '1.2.3.4');
    expect(acquisition.status()).toEqual({
      state: 'downloaded',
      executablePath: join(
        installDir,
        'chrome-mac-arm64',
        'Chromium.app',
        'chrome',
      ),
      version: '1.2.3.4',
    });
    // Staging is gone; only the versioned install remains.
    expect(readdirSync(chromiumInstallRoot(stationHome))).toEqual(['1.2.3.4']);
    // A fresh instance recognises the install without fetching again.
    const again = new ChromiumAcquisition(stationHome, {
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      homeDir: '/nowhere',
      isExecutableFile: (path) =>
        path.startsWith(stationHome) && existsSync(path),
      fetch: vi.fn() as unknown as typeof fetch,
      extract: vi.fn(),
      listEntries: vi.fn(async () => []),
      pin: testPin(),
    });
    expect(again.status().state).toBe('downloaded');
  });

  test('concurrent consented requests share one download', async () => {
    const { acquisition, fetchMock } = harness();
    const first = acquisition.startDownload({ consent: true });
    const second = acquisition.startDownload({ consent: true });
    expect(second.status.state).toBe('downloading');
    await Promise.all([first.completion, second.completion]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      'a declared length that differs from the pin',
      { contentLength: '999' },
      'size-mismatch',
    ],
    [
      'a stream longer than the pin with no declared length',
      { contentLength: null, body: Buffer.concat([ARCHIVE, Buffer.from('x')]) },
      'size-mismatch',
    ],
    [
      'a truncated stream',
      { contentLength: null, body: ARCHIVE.subarray(0, 5) },
      'size-mismatch',
    ],
    [
      'bytes whose MD5 differs from the pin',
      { body: Buffer.from('X'.repeat(ARCHIVE.length)) },
      'integrity-mismatch',
    ],
    ['an HTTP error', { status: 404 }, 'download-failed'],
  ] as const)('refuses %s', async (_label, options, reason) => {
    const { acquisition, extract, stationHome } = harness(options);
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status()).toMatchObject({
      state: 'failed',
      reason,
      retryable: true,
    });
    expect(extract).not.toHaveBeenCalled();
    expect(readdirSync(chromiumInstallRoot(stationHome))).toEqual([]);
    expect(acquisition.resolveExecutable()).toBeUndefined();
  });

  test('an extraction failure or a missing executable is a typed failure', async () => {
    const throwing = harness({
      extract: async () => {
        throw new Error('ditto exited 1');
      },
    });
    await throwing.acquisition.startDownload({ consent: true }).completion;
    expect(throwing.acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'extract-failed',
    });
    const empty = harness({ extract: async () => {} });
    await empty.acquisition.startDownload({ consent: true }).completion;
    expect(empty.acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'extract-failed',
    });
    expect(readdirSync(chromiumInstallRoot(empty.stationHome))).toEqual([]);
  });

  test('a failed download can be retried with fresh consent', async () => {
    const { acquisition, fetchMock } = harness({ status: 503 });
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status().state).toBe('failed');
    await acquisition.startDownload({ consent: true }).completion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an unsupported platform fails closed and never fetches', async () => {
    const { acquisition, fetchMock } = harness({
      platform: 'win32',
      arch: 'arm64',
    });
    expect(acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'unsupported-platform',
      retryable: false,
    });
    await acquisition.startDownload({ consent: true }).completion;
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('archive trust (review: SHA-256 root, zip-slip, symlinks)', () => {
  test('bytes matching size and MD5 but not the pinned SHA-256 are refused', async () => {
    const { acquisition, extract, stationHome } = harness({
      pin: testPin({ sha256: 'a'.repeat(64) }),
    });
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
    });
    expect(extract).not.toHaveBeenCalled();
    expect(readdirSync(chromiumInstallRoot(stationHome))).toEqual([]);
  });

  test('a malformed or placeholder SHA-256 pin fails closed', async () => {
    const { acquisition, extract } = harness({
      pin: testPin({ sha256: 'TODO' }),
    });
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
    });
    expect(extract).not.toHaveBeenCalled();
  });

  test.each([
    ['../evil'],
    ['chrome-mac-arm64/../../evil'],
    ['/etc/evil'],
    ['C:/evil'],
    ['chrome\\..\\..\\evil'],
  ])(
    'an entry escaping the root (%s) is refused before extraction',
    async (entry) => {
      const { acquisition, extract } = harness({
        entries: ['chrome-mac-arm64/Chromium.app/chrome', entry],
      });
      await acquisition.startDownload({ consent: true }).completion;
      expect(acquisition.status()).toMatchObject({
        state: 'failed',
        reason: 'extract-failed',
      });
      expect(extract).not.toHaveBeenCalled();
    },
  );

  test('an extracted symlink pointing outside the install directory is refused', async () => {
    const { acquisition, stationHome } = harness({
      extract: async (_zip, dest) => {
        const dir = join(dest, 'chrome-mac-arm64', 'Chromium.app');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'chrome'), '#!/bin/sh\n');
        symlinkSync(tmpdir(), join(dir, 'escape'));
      },
    });
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status()).toMatchObject({
      state: 'failed',
      reason: 'extract-failed',
    });
    expect(readdirSync(chromiumInstallRoot(stationHome))).toEqual([]);
  });

  test('a symlink that stays inside (app-bundle style) is accepted', async () => {
    const { acquisition } = harness({
      extract: async (_zip, dest) => {
        const dir = join(dest, 'chrome-mac-arm64', 'Chromium.app');
        mkdirSync(join(dir, 'Versions', '1'), { recursive: true });
        writeFileSync(join(dir, 'chrome'), '#!/bin/sh\n');
        symlinkSync('Versions/1', join(dir, 'Current'));
      },
    });
    await acquisition.startDownload({ consent: true }).completion;
    expect(acquisition.status().state).toBe('downloaded');
  });
});

describe('the production pin', () => {
  test('pins a SHA-256 for every platform', () => {
    for (const build of Object.values(CHROME_FOR_TESTING_PIN.builds)) {
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(CHROME_FOR_TESTING_PIN.builds['mac-arm64'].sha256).toBe(
      '0e6b3439469c1b8b95b2e89c72ea29f7af00fb2c28a8878358a0b6002b6d3a64',
    );
  });

  test('pins every platform with an exact size and a 16-byte MD5', () => {
    expect(CHROME_FOR_TESTING_PIN.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(CHROME_FOR_TESTING_PIN.baseUrl).toBe(
      'https://storage.googleapis.com/chrome-for-testing-public',
    );
    for (const build of Object.values(CHROME_FOR_TESTING_PIN.builds)) {
      expect(build.bytes).toBeGreaterThan(50_000_000);
      expect(Buffer.from(build.md5, 'base64')).toHaveLength(16);
    }
  });
});
