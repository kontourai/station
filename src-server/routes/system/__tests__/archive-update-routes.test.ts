/**
 * The update routes for a prebuilt release archive (#2675 slice D3), driven
 * through the real handlers: the real install resolver reads a fixture
 * install tree, the real verifier checks a manifest signed here, and the
 * request and progress go through the real runtime files the service's
 * launcher and child use. Only the network fetch and the pinned-key table
 * are injected.
 */
import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  parseServiceUpdateRequest,
  serviceUpdatePaths,
} from '@kontourai/station-shared/service-launcher-protocol';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  systemOps: { add: vi.fn() },
}));

const { createSystemUpdateRoutes } = await import('../system-update-routes.js');
const {
  MAX_TIMER_MS,
  ServerUpdateCoordinator,
  SERVER_UPDATE_DOWNLOAD_DELAY_MS,
} = await import(
  '../../../services/server-update/server-update-coordinator.js'
);
const { resolveInstallProvenance } = await import('../install-provenance.js');

const makeTempDir = trackTempDirs();

const RUNNING = '0.8.0-preview.1';
const NEWER = '0.8.0-preview.2';
const MANIFEST_URL = 'https://releases.example.test/station/preview.json';
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Written independently of the verifier under test. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

function releasePayload(
  version: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const artifact = (os: string, arch: string, format: string, n: number) => ({
    os,
    arch,
    name: `station-server-${os}-${arch}.${format}`,
    url: `https://github.com/kontourai/station/releases/download/v${version}/station-server-${os}-${arch}.${format}`,
    sha256: String(n).repeat(64),
    size: 100_000_000 + n,
    format,
  });
  return {
    schemaVersion: 2,
    channel: 'preview',
    version,
    releaseTag: `v${version}`,
    sourceSha: SHA,
    publishedAt: '2026-09-25T00:00:00.000Z',
    nodeVersion: '24.21.0',
    launcherProtocol: { min: 1, max: 1 },
    artifacts: [
      artifact('darwin', 'arm64', 'tar.gz', 1),
      artifact('darwin', 'x64', 'tar.gz', 2),
      artifact('linux', 'arm64', 'tar.gz', 3),
      artifact('linux', 'x64', 'tar.gz', 4),
      artifact('win32', 'x64', 'zip', 5),
    ],
    ...overrides,
  };
}

const keys = generateKeyPairSync('ed25519');
const KEY_ID = 'station-test-preview';
const TEST_KEYS = {
  keys: [
    {
      keyId: KEY_ID,
      algorithm: 'ed25519',
      publicKeySpkiPem: keys.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      channels: ['preview', 'nightly'],
    },
  ],
};

function signedManifest(
  payload: unknown,
  privateKey: KeyObject = keys.privateKey,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId: KEY_ID,
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString('base64'),
  });
}

interface Install {
  installRoot: string;
  versionRoot: string;
  moduleDir: string;
}

/**
 * An install.sh install of a prebuilt archive, in the shape install.sh and
 * the archive builder write: the root's marker and install state, and the
 * version directory's builder marker and release manifest.
 */
function makeInstall({
  installerOwned = true,
  manifestUrl = MANIFEST_URL as string | null,
  stateSchema = 4,
}: {
  installerOwned?: boolean;
  manifestUrl?: string | null;
  stateSchema?: 3 | 4;
} = {}): Install {
  const installRoot = makeTempDir('station-archive-install-');
  if (installerOwned) {
    writeFileSync(
      join(installRoot, '.station-portable-install-root'),
      'station-portable-install-root-v1\n',
    );
  }
  const common = {
    channel: 'beta',
    releaseChannel: 'preview',
    installRoot,
    stationRoot: join(installRoot, 'root'),
    stationHome: join(installRoot, 'root', 'instances', 'beta'),
    serverPort: 29141,
    uiPort: 29000,
  };
  writeFileSync(
    join(installRoot, '.station-release-state.json'),
    `${JSON.stringify(
      stateSchema === 4
        ? { schemaVersion: 4, ...common, manifestUrl }
        : { schemaVersion: 3, ...common },
    )}\n`,
  );
  const versionRoot = join(installRoot, 'versions', RUNNING);
  const moduleDir = join(versionRoot, 'dist-server');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    join(versionRoot, '.station-prebuilt-archive'),
    'station-prebuilt-archive-v1\n',
  );
  writeFileSync(
    join(versionRoot, '.station-release.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      sha: SHA,
      ref: `v${RUNNING}`,
      createdAt: '2026-09-20T00:00:00.000Z',
      channel: 'beta',
      releaseChannel: 'preview',
      prerelease: true,
    })}\n`,
  );
  return { installRoot, versionRoot, moduleDir };
}

function launcherEnv(
  install: Install,
  overrides: Record<string, unknown> = {},
): NodeJS.ProcessEnv {
  return {
    STATION_SERVICE_LAUNCHER: JSON.stringify({
      protocol: 1,
      installRoot: install.installRoot,
      version: RUNNING,
      role: 'active',
      ...overrides,
    }),
  };
}

let fetchFn: ReturnType<typeof vi.fn>;
function serveManifest(body: string, status = 200) {
  fetchFn.mockImplementation(async () => new Response(body, { status }));
}

function createApp(
  install: Install,
  options: {
    env?: NodeJS.ProcessEnv;
    pinnedKeys?: unknown;
    platform?: string;
    arch?: string;
    extraDeps?: Record<string, unknown>;
  } = {},
) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const deps = {
    getAppConfig: () => ({}),
    eventBus: { emit: vi.fn() },
    ...options.extraDeps,
  };
  return createSystemUpdateRoutes(deps as never, logger, undefined, {
    moduleDir: install.moduleDir,
    env: options.env ?? launcherEnv(install),
    fetchFn: fetchFn as unknown as typeof fetch,
    pinnedKeys: 'pinnedKeys' in options ? options.pinnedKeys : TEST_KEYS,
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
  });
}

beforeEach(() => {
  fetchFn = vi.fn();
  serveManifest(signedManifest(releasePayload(NEWER)));
});

describe('GET /core-update on a launcher-run archive', () => {
  test('verifies the signed manifest and reports the newer release as applicable', async () => {
    const install = makeInstall();
    const body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      installKind: 'archive-service',
      applyMethod: 'service-update',
      channel: 'preview',
      currentVersion: RUNNING,
      latestVersion: NEWER,
      releaseCheck: 'verified',
      updateAvailable: true,
      selfUpdateUnavailableReason: null,
      selfUpdateUnavailableCode: null,
      provenanceIssue: null,
      serviceUpdate: { state: 'idle' },
    });
    expect(body).not.toHaveProperty('error');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(MANIFEST_URL);
  });

  test('the running release is up to date, and an older signed manifest is not an update', async () => {
    const install = makeInstall();
    serveManifest(signedManifest(releasePayload(RUNNING)));
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({ latestVersion: RUNNING, updateAvailable: false });
    serveManifest(signedManifest(releasePayload('0.7.9-preview.4')));
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({
      latestVersion: '0.7.9-preview.4',
      updateAvailable: false,
    });
  });

  test('verifies against the pinned keys by default: a key the table does not pin is refused', async () => {
    const install = makeInstall();
    const body = await json(
      await createApp(install, { pinnedKeys: undefined }).request(
        '/core-update',
      ),
    );
    expect(body).toMatchObject({
      releaseCheck: 'unverified',
      updateAvailable: false,
    });
    expect(body.latestVersion).toBeUndefined();
    expect(body.technicalDetail).toMatch(/station-test-preview is not pinned/);
  });

  test('refuses a manifest with a bad signature or another channel', async () => {
    const install = makeInstall();
    const other = generateKeyPairSync('ed25519');
    serveManifest(signedManifest(releasePayload(NEWER), other.privateKey));
    let body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      releaseCheck: 'unverified',
      updateAvailable: false,
      technicalDetail: 'manifest signature did not verify',
    });

    serveManifest(
      signedManifest(releasePayload('0.9.0-nightly.3', { channel: 'nightly' })),
    );
    body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({ releaseCheck: 'unverified' });
    expect(body.technicalDetail).toMatch(
      /channel nightly does not match the expected channel preview/,
    );
  });

  test('an unreachable or oversized manifest is a disclosed failed check, never an error', async () => {
    const install = makeInstall();
    fetchFn.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    let body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      releaseCheck: 'unreachable',
      remoteUnreachable: true,
      updateAvailable: false,
      technicalDetail: 'getaddrinfo ENOTFOUND',
    });
    expect(body).not.toHaveProperty('error');

    serveManifest('x'.repeat(1024 * 1024 + 1));
    body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({ releaseCheck: 'unreachable' });
    expect(body.technicalDetail).toMatch(/exceeds 1048576 bytes/);

    serveManifest('not found', 404);
    body = await json(await createApp(install).request('/core-update'));
    expect(body.technicalDetail).toMatch(/HTTP 404/);
  });

  test('a release this host or this launcher cannot run is reported, not offered', async () => {
    const install = makeInstall();
    let body = await json(
      await createApp(install, { platform: 'freebsd', arch: 'x64' }).request(
        '/core-update',
      ),
    );
    expect(body).toMatchObject({ updateAvailable: true });
    expect(body.selfUpdateUnavailableReason).toMatch(
      /publishes no server archive for freebsd-x64/,
    );

    serveManifest(
      signedManifest(
        releasePayload(NEWER, { launcherProtocol: { min: 2, max: 2 } }),
      ),
    );
    body = await json(await createApp(install).request('/core-update'));
    expect(body.selfUpdateUnavailableReason).toMatch(
      /needs a newer service launcher/,
    );
  });

  test('an install that records no public manifest checks nothing and says so', async () => {
    for (const install of [
      makeInstall({ manifestUrl: null }),
      makeInstall({ stateSchema: 3 }),
    ]) {
      const body = await json(await createApp(install).request('/core-update'));
      expect(body).toMatchObject({
        installKind: 'archive-service',
        releaseCheck: 'not-recorded',
        updateAvailable: false,
      });
      expect(body.selfUpdateUnavailableReason).toMatch(/station upgrade/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('a manifest older than a release this install already accepted (#187)', () => {
  /** The mark exactly as install.sh and the Windows installer core write it. */
  function acceptRelease(install: Install, text: string) {
    // Owner-only, as the installers write it (a group- or world-readable
    // mark is not trusted).
    writeFileSync(
      join(install.installRoot, '.station-release-accepted.json'),
      text,
      { mode: 0o600 },
    );
  }
  const mark = (version: string) =>
    `${JSON.stringify({ schemaVersion: 1, releaseChannel: 'preview', version })}\n`;

  test('is not offered, and an apply is refused, even though it is newer than the running release', async () => {
    // The service rolled back from preview.5 to preview.1; a replayed,
    // validly signed preview.3 manifest is newer than what runs.
    const install = makeInstall();
    acceptRelease(install, mark('0.8.0-preview.5'));
    serveManifest(signedManifest(releasePayload('0.8.0-preview.3')));
    const body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      releaseCheck: 'unverified',
      updateAvailable: false,
    });
    expect(body.latestVersion).toBeUndefined();
    const record = join(install.installRoot, '.station-release-accepted.json');
    expect(body.message).toBe(
      'The preview release manifest offers 0.8.0-preview.3, older than 0.8.0-preview.5 which this install already accepted, so it is not offered.',
    );
    expect(body.technicalDetail).toBe(
      `the manifest is stale or replayed (accepted release recorded in ${record})`,
    );
    const post = await createApp(install).request('/core-update', {
      method: 'POST',
    });
    expect(post.status).toBe(409);
    expect(existsSync(serviceUpdatePaths(install.installRoot).request)).toBe(
      false,
    );
  });

  test('the accepted release itself, or a newer one, is still offered', async () => {
    const install = makeInstall();
    acceptRelease(install, mark(NEWER));
    for (const version of [NEWER, '0.8.0-preview.9']) {
      serveManifest(signedManifest(releasePayload(version)));
      expect(
        await json(await createApp(install).request('/core-update')),
      ).toMatchObject({
        releaseCheck: 'verified',
        latestVersion: version,
        updateAvailable: true,
        selfUpdateUnavailableReason: null,
      });
    }
  });

  test('an unreadable, foreign-ring or group-readable record offers nothing, and says how to recover', async () => {
    for (const [text, mode] of [
      ['not json', 0o600],
      [
        `${JSON.stringify({ schemaVersion: 1, releaseChannel: 'nightly', version: '0.8.0-nightly.1' })}\n`,
        0o600,
      ],
      [mark('0.8.0-preview.1'), 0o644],
    ] as const) {
      const install = makeInstall();
      acceptRelease(install, text);
      chmodSync(
        join(install.installRoot, '.station-release-accepted.json'),
        mode,
      );
      const body = await json(await createApp(install).request('/core-update'));
      expect(body).toMatchObject({
        releaseCheck: 'unverified',
        updateAvailable: false,
      });
      // Not the stale-manifest wording: the record is the problem.
      expect(body.message).toBe(
        "This install's record of the newest release it accepted is unreadable, so no update is offered. On the host, fix its owner and permissions or remove it, then check again.",
      );
      expect(body.technicalDetail).toBe(
        `${join(install.installRoot, '.station-release-accepted.json')} is not a private file of this user holding a preview release record`,
      );
    }
  });
});

describe('who may apply', () => {
  test('an archive no launcher runs, or another install’s or version’s launcher, is not the service', async () => {
    const install = makeInstall();
    const other = makeInstall();
    for (const env of [
      {},
      launcherEnv(install, { installRoot: other.installRoot }),
      launcherEnv(install, { version: NEWER }),
      { STATION_SERVICE_LAUNCHER: '{"protocol":2}' },
    ]) {
      const body = await json(
        await createApp(install, { env }).request('/core-update'),
      );
      expect(body).toMatchObject({
        installKind: 'archive',
        applyMethod: 'station-upgrade',
        latestVersion: NEWER,
        updateAvailable: true,
      });
      expect(body).not.toHaveProperty('serviceUpdate');
      expect(body.selfUpdateUnavailableReason).toMatch(
        /not run by the Station service's launcher.*"station upgrade"/,
      );
      const post = await createApp(install, { env }).request('/core-update', {
        method: 'POST',
      });
      expect(post.status).toBe(409);
      expect(existsSync(serviceUpdatePaths(install.installRoot).request)).toBe(
        false,
      );
    }
  });

  test('an archive the installer does not own can only be reinstalled', async () => {
    const install = makeInstall({ installerOwned: false });
    const body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      installKind: 'archive',
      applyMethod: 'reinstall',
      releaseCheck: 'not-recorded',
    });
    expect(body.selfUpdateUnavailableReason).toMatch(/reinstall it/);
  });
});

describe('POST /core-update on a launcher-run archive', () => {
  test('queues one owner-only request the service picks up, and its progress reads queued', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const res = await app.request('/core-update', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({ success: true });
    const requestId = body.serviceUpdate.requestId as string;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const paths = serviceUpdatePaths(install.installRoot);
    const request = JSON.parse(readFileSync(paths.request, 'utf8'));
    expect(request).toEqual({
      id: requestId,
      requestedAt: expect.any(String),
    });
    if (process.platform !== 'win32') {
      expect(statSync(paths.request).mode & 0o777).toBe(0o600);
    }

    // `intent` is additive (#3851): a request without a mode is an update.
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({ state: 'queued', requestId, intent: 'update' });
    // The GET reports it too, so a client never offers a second apply.
    expect(
      (await json(await app.request('/core-update'))).serviceUpdate,
    ).toEqual({ state: 'queued', requestId, intent: 'update' });

    const again = await app.request('/core-update', { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatch(/already in progress/);
    expect(JSON.parse(readFileSync(paths.request, 'utf8')).id).toBe(requestId);
  });

  test('under the Windows service, the desktop’s apply reaches the launcher the same way (#2675 W3)', async () => {
    // The environment `service run` hands the server on Windows: the Task
    // Scheduler wrapper's service marker, the supervisor's pid and the
    // launcher's context. The service marker refuses a source checkout's
    // in-place update; it must not refuse an archive the launcher runs.
    const install = makeInstall();
    const app = createApp(install, {
      platform: 'win32',
      arch: 'x64',
      env: {
        ...launcherEnv(install),
        STATION_SERVICE_MANAGED: '1',
        STATION_SUPERVISOR_PID: '4242',
      },
    });
    expect(await json(await app.request('/core-update'))).toMatchObject({
      installKind: 'archive-service',
      applyMethod: 'service-update',
      latestVersion: NEWER,
      updateAvailable: true,
      selfUpdateUnavailableReason: null,
    });

    const res = await app.request('/core-update', { method: 'POST' });
    expect(res.status).toBe(202);
    const requestId = (await json(res)).serviceUpdate.requestId as string;
    // The request the launcher's child claims: no version, so it stages the
    // newest one with the version's own installer (install.ps1 on Windows).
    expect(
      parseServiceUpdateRequest(
        readFileSync(serviceUpdatePaths(install.installRoot).request, 'utf8'),
      ),
    ).toEqual({ id: requestId, requestedAt: expect.any(String) });
  });

  test('refuses, writing nothing, when the same verified check finds nothing to apply', async () => {
    const cases: Array<[string, () => void, Record<string, string>, RegExp]> = [
      [
        'up to date',
        () => serveManifest(signedManifest(releasePayload(RUNNING))),
        {},
        /nothing to update/,
      ],
      [
        'no archive for this host',
        () => serveManifest(signedManifest(releasePayload(NEWER))),
        { platform: 'freebsd' },
        /publishes no server archive for freebsd-x64/,
      ],
      [
        'a launcher protocol this service lacks',
        () =>
          serveManifest(
            signedManifest(
              releasePayload(NEWER, { launcherProtocol: { min: 2, max: 2 } }),
            ),
          ),
        {},
        /needs a newer service launcher/,
      ],
      [
        'an unverified manifest',
        () =>
          serveManifest(
            signedManifest(
              releasePayload(NEWER),
              generateKeyPairSync('ed25519').privateKey,
            ),
          ),
        {},
        /did not verify[\s\S]*"station upgrade"/,
      ],
      [
        'an unreachable manifest',
        () => fetchFn.mockRejectedValue(new Error('getaddrinfo ENOTFOUND')),
        {},
        /Could not reach[\s\S]*network access[\s\S]*"station upgrade"/,
      ],
    ];
    for (const [, arrange, overrides, error] of cases) {
      const install = makeInstall();
      arrange();
      const res = await createApp(install, overrides).request('/core-update', {
        method: 'POST',
      });
      expect(res.status).toBe(409);
      expect((await json(res)).error).toMatch(error);
      expect(existsSync(serviceUpdatePaths(install.installRoot).request)).toBe(
        false,
      );
    }
  });

  // GitHub answers every release-asset URL with a redirect to its asset host
  // (a 302 to release-assets.githubusercontent.com), so these are the shape a
  // real check always takes, not an edge case.
  function serveRedirects(hops: string[], body: string) {
    fetchFn.mockImplementation(async (url: string, init?: RequestInit) => {
      const index = url === MANIFEST_URL ? 0 : hops.indexOf(url) + 1;
      // As undici does: a redirect under `redirect: 'error'` is a network
      // error, which is exactly what the real check reported.
      if (index < hops.length && init?.redirect === 'error')
        throw new TypeError('fetch failed');
      if (index < hops.length)
        return new Response(null, {
          status: 302,
          headers: { location: hops[index] },
        });
      return new Response(body, { status: 200 });
    });
  }
  const assetHop = (n: number) =>
    `https://release-assets.example.test/asset-${n}.json`;

  test('follows the https redirects GitHub serves release assets through', async () => {
    const install = makeInstall();
    serveRedirects([assetHop(1)], signedManifest(releasePayload(NEWER)));
    const body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      releaseCheck: 'verified',
      latestVersion: NEWER,
      updateAvailable: true,
    });
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      MANIFEST_URL,
      assetHop(1),
    ]);
    // Each hop is followed by hand, so each one is checked before it is used.
    for (const call of fetchFn.mock.calls)
      expect(call[1]).toMatchObject({ redirect: 'manual' });
  });

  test('refuses a redirect that leaves https, without following it', async () => {
    const install = makeInstall();
    serveRedirects(
      ['http://release-assets.example.test/asset.json'],
      signedManifest(releasePayload(NEWER)),
    );
    const body = await json(await createApp(install).request('/core-update'));
    expect(body).toMatchObject({
      releaseCheck: 'unverified',
      updateAvailable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('follows at most 5 redirects and refuses the sixth', async () => {
    const install = makeInstall();
    const manifest = signedManifest(releasePayload(NEWER));
    serveRedirects([1, 2, 3, 4, 5].map(assetHop), manifest);
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({ releaseCheck: 'verified' });
    expect(fetchFn).toHaveBeenCalledTimes(6);

    fetchFn.mockClear();
    serveRedirects([1, 2, 3, 4, 5, 6].map(assetHop), manifest);
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({ releaseCheck: 'unreachable', updateAvailable: false });
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  test('resolves a relative redirect against the URL that sent it', async () => {
    const install = makeInstall();
    const resolved = new URL('/relative/asset.json', MANIFEST_URL).href;
    fetchFn.mockImplementation(async (url: string) =>
      url === MANIFEST_URL
        ? new Response(null, {
            status: 302,
            headers: { location: '/relative/asset.json' },
          })
        : new Response(signedManifest(releasePayload(NEWER)), { status: 200 }),
    );
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({ releaseCheck: 'verified' });
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([
      MANIFEST_URL,
      resolved,
    ]);
  });

  test('a redirect with no location is a failed check', async () => {
    const install = makeInstall();
    fetchFn.mockImplementation(async () => new Response(null, { status: 302 }));
    expect(
      await json(await createApp(install).request('/core-update')),
    ).toMatchObject({ releaseCheck: 'unreachable', updateAvailable: false });
  });

  test('refuses while the launcher has an update pending, and without a manifest to update from', async () => {
    const install = makeInstall();
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({
        protocol: 1,
        activeVersion: RUNNING,
        update: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          fromVersion: RUNNING,
          targetVersion: NEWER,
          status: 'pending',
          phase: 'trial',
          attempts: 1,
          startedAt: '2026-09-27T12:00:00.000Z',
        },
      }),
    );
    const pending = await createApp(install).request('/core-update', {
      method: 'POST',
    });
    expect(pending.status).toBe(409);
    expect(existsSync(paths.request)).toBe(false);

    const unrecorded = makeInstall({ manifestUrl: null });
    const refused = await createApp(unrecorded).request('/core-update', {
      method: 'POST',
    });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatch(/no public release manifest/);
    expect(existsSync(serviceUpdatePaths(unrecorded.installRoot).request)).toBe(
      false,
    );
  });
});

describe('GET /core-update/service-update', () => {
  const UPDATE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  function writeState(install: Install, update: Record<string, unknown>) {
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({ protocol: 1, activeVersion: RUNNING, update }),
    );
  }

  test('reads staging, the launcher’s phases and its rollback outcome from the runtime files', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.processing,
      JSON.stringify({ id: REQUEST_ID, requestedAt: '2026-09-27T12:00:00Z' }),
    );
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({ state: 'staging', requestId: REQUEST_ID, intent: 'update' });

    rmSync(paths.processing);
    writeState(install, {
      id: UPDATE_ID,
      fromVersion: RUNNING,
      targetVersion: NEWER,
      requestId: REQUEST_ID,
      status: 'pending',
      phase: 'restoring',
      reason: 'prepared-timeout',
      attempts: 2,
      startedAt: '2026-09-27T12:00:00.000Z',
    });
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({
      state: 'updating',
      requestId: REQUEST_ID,
      phase: 'restoring',
      fromVersion: RUNNING,
      targetVersion: NEWER,
      attempts: 2,
    });

    writeState(install, {
      id: UPDATE_ID,
      fromVersion: RUNNING,
      targetVersion: NEWER,
      requestId: REQUEST_ID,
      status: 'rolled-back',
      reason: 'prepared-timeout',
      attempts: 2,
      finishedAt: '2026-09-27T12:10:00.000Z',
    });
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({
      state: 'rolled-back',
      requestId: REQUEST_ID,
      fromVersion: RUNNING,
      targetVersion: NEWER,
      reason: 'prepared-timeout',
      finishedAt: '2026-09-27T12:10:00.000Z',
    });
  });

  test('the newer of the launcher’s outcome and a request’s own result answers', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const paths = serviceUpdatePaths(install.installRoot);
    writeState(install, {
      id: UPDATE_ID,
      fromVersion: '0.8.0-preview.0',
      targetVersion: RUNNING,
      status: 'committed',
      attempts: 1,
      finishedAt: '2026-09-27T12:00:00.000Z',
    });
    writeFileSync(
      paths.result,
      JSON.stringify({
        requestId: REQUEST_ID,
        status: 'failed',
        reason: 'manifest signature did not verify',
        at: '2026-09-27T13:00:00.000Z',
      }),
    );
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({
      state: 'staging-failed',
      requestId: REQUEST_ID,
      reason: 'manifest signature did not verify',
      finishedAt: '2026-09-27T13:00:00.000Z',
    });
    writeFileSync(
      paths.result,
      JSON.stringify({
        requestId: REQUEST_ID,
        status: 'up-to-date',
        version: RUNNING,
        at: '2026-09-27T11:00:00.000Z',
      }),
    );
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toMatchObject({ state: 'committed', requestId: null });
  });

  test('an update the launcher could not roll back needs an operator, and blocks another apply', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const paths = serviceUpdatePaths(install.installRoot);
    // The launcher's own record after its last failed restore.
    writeState(install, {
      id: UPDATE_ID,
      fromVersion: RUNNING,
      targetVersion: NEWER,
      requestId: REQUEST_ID,
      status: 'needs-operator',
      reason: 'prepared-timeout',
      attempts: 2,
      restoreAttempts: 3,
      finishedAt: '2026-09-27T12:10:00.000Z',
    });
    // A later request result does not hide it.
    writeFileSync(
      paths.result,
      JSON.stringify({
        requestId: '11111111-2222-4333-8444-555555555555',
        status: 'failed',
        reason: 'x',
        at: '2026-09-27T13:00:00.000Z',
      }),
    );
    const progress = {
      state: 'needs-operator',
      requestId: REQUEST_ID,
      fromVersion: RUNNING,
      targetVersion: NEWER,
      reason: 'prepared-timeout',
      restoreAttempts: 3,
      finishedAt: '2026-09-27T12:10:00.000Z',
    };
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual(progress);
    expect(
      (await json(await app.request('/core-update'))).serviceUpdate,
    ).toEqual(progress);
    const post = await app.request('/core-update', { method: 'POST' });
    expect(post.status).toBe(409);
    expect((await json(post)).error).toMatch(/needs an operator/);
    expect(existsSync(paths.request)).toBe(false);
  });

  test('an unreadable state, or a server that is not the launcher’s, reads unavailable', async () => {
    const install = makeInstall();
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(paths.state, '{"protocol":1,');
    expect(
      await json(
        await createApp(install).request('/core-update/service-update'),
      ),
    ).toEqual({ state: 'unavailable' });
    expect(
      await json(
        await createApp(makeInstall(), { env: {} }).request(
          '/core-update/service-update',
        ),
      ),
    ).toEqual({ state: 'unavailable' });
  });
});

/** `install`'s version directory for `version`, complete as install.sh seals it. */
function stageOnDisk(install: Install, version: string, requestId: string) {
  const dir = join(install.installRoot, 'versions', version);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'station.mjs'), '');
  writeFileSync(join(dir, '.station-install-complete'), `${'a'.repeat(64)}\n`);
  const paths = serviceUpdatePaths(install.installRoot);
  mkdirSync(paths.runtime, { recursive: true });
  writeFileSync(
    paths.result,
    JSON.stringify({
      requestId,
      status: 'staged',
      version,
      at: '2026-10-19T09:00:00.000Z',
    }),
  );
}

const STAGE_REQUEST = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

describe('stage and apply as separate requests (#3851)', () => {
  test('a stage request writes a stage request for the verified version; nothing restarts', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const res = await app.request('/core-update', {
      method: 'POST',
      body: JSON.stringify({ action: 'stage' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.serviceUpdate).toEqual({
      requestId: expect.any(String),
      intent: 'stage',
    });
    const request = parseServiceUpdateRequest(
      readFileSync(serviceUpdatePaths(install.installRoot).request, 'utf8'),
    );
    expect(request).toMatchObject({ mode: 'stage', targetVersion: NEWER });
    expect(
      await json(await app.request('/core-update/service-update?staged=1')),
    ).toEqual({
      state: 'queued',
      requestId: body.serviceUpdate.requestId,
      intent: 'stage',
    });
  });

  test('an apply is refused, writing nothing, until a stage left that version staged', async () => {
    const install = makeInstall();
    const app = createApp(install);
    const post = (body: unknown) =>
      app.request('/core-update', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    const paths = serviceUpdatePaths(install.installRoot);
    const notStaged = await post({ action: 'apply', version: NEWER });
    expect(notStaged.status).toBe(409);
    expect((await json(notStaged)).error).toMatch(/download the update first/);
    expect(existsSync(paths.request)).toBe(false);

    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const otherVersion = await post({
      action: 'apply',
      version: '0.8.0-preview.3',
    });
    expect(otherVersion.status).toBe(409);
    expect((await json(otherVersion)).error).toMatch(
      /downloaded update is 0\.8\.0-preview\.2/,
    );
    expect(existsSync(paths.request)).toBe(false);

    const applied = await post({ action: 'apply', version: NEWER });
    expect(applied.status).toBe(202);
    expect(
      parseServiceUpdateRequest(readFileSync(paths.request, 'utf8')),
    ).toMatchObject({ mode: 'apply', targetVersion: NEWER });
  });

  test('refuses an unknown action, an apply that names no version, and a malformed version', async () => {
    const install = makeInstall();
    const app = createApp(install);
    for (const body of [
      { action: 'restart' },
      { action: 'apply' },
      { action: 'apply', version: '../x' },
    ]) {
      const res = await app.request('/core-update', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(serviceUpdatePaths(install.installRoot).request)).toBe(
      false,
    );
  });

  test('staged is reported only to a client that asks for it; an older client reads what it did before', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const app = createApp(install);
    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({ state: 'idle' });
    expect(
      await json(await app.request('/core-update/service-update?staged=1')),
    ).toEqual({
      state: 'staged',
      requestId: STAGE_REQUEST,
      version: NEWER,
      stagedAt: '2026-10-19T09:00:00.000Z',
    });
    const legacy = await json(await app.request('/core-update'));
    expect(legacy).toMatchObject({
      stagedUpdates: true,
      serviceUpdate: { state: 'idle' },
    });
    expect(
      (await json(await app.request('/core-update?staged=1'))).serviceUpdate,
    ).toMatchObject({ state: 'staged', version: NEWER });
  });

  test('a one-click update (no body) of a staged version still requests the combined update', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const res = await createApp(install).request('/core-update', {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    const request = parseServiceUpdateRequest(
      readFileSync(serviceUpdatePaths(install.installRoot).request, 'utf8'),
    );
    expect(request).not.toHaveProperty('mode');
  });
});

/** Timers the test fires by hand, recording when each was due. */
function manualTimers(clock: { now: number }) {
  const pending: Array<{ due: number; callback: () => void; live: boolean }> =
    [];
  return {
    setTimer: (callback: () => void, ms: number) => {
      const timer = { due: clock.now + ms, callback, live: true };
      pending.push(timer);
      return {
        cancel: () => {
          timer.live = false;
        },
      };
    },
    live: () => pending.filter((timer) => timer.live),
    /** Fires every live timer due by now. */
    async fireDue() {
      for (const timer of pending.filter(
        (entry) => entry.live && entry.due <= clock.now,
      )) {
        timer.live = false;
        timer.callback();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function coordinatorFor(
  install: Install,
  options: {
    policy?: string;
    running?: () =>
      | Array<{ sessionId: string }>
      | Promise<Array<{ sessionId: string }>>;
    clock?: { now: number };
  } = {},
) {
  const clock = options.clock ?? { now: Date.parse('2026-10-19T10:00:00Z') };
  const timers = manualTimers(clock);
  const published: Array<Record<string, unknown>> = [];
  let busListener:
    | ((message: { event: string; data?: Record<string, unknown> }) => void)
    | undefined;
  let policy = options.policy;
  let provenanceCalls = 0;
  const coordinator = new ServerUpdateCoordinator({
    provenance: () => {
      provenanceCalls += 1;
      return resolveInstallProvenance(install.moduleDir);
    },
    options: {
      env: launcherEnv(install),
      fetchFn: fetchFn as unknown as typeof fetch,
      pinnedKeys: TEST_KEYS,
      platform: 'linux',
      arch: 'x64',
    },
    readDownloadPolicy: async () => policy,
    listRunningTurns: async () => (await options.running?.()) ?? [],
    subscribe: (listener) => {
      busListener = listener;
      return () => {
        busListener = undefined;
      };
    },
    publish: (state) => published.push(state as never),
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => clock.now,
    setTimer: timers.setTimer,
    bootCheckDelayMs: 60_000,
    idleDebounceMs: 2_000,
  });
  return {
    coordinator,
    clock,
    timers,
    published,
    provenanceCalls: () => provenanceCalls,
    /** Fires timers in due order until `ms` from now has passed. */
    advance: async (ms: number) => {
      const target = clock.now + ms;
      for (let step = 0; ; step += 1) {
        if (step > 200)
          throw new Error(
            `timers did not settle: ${JSON.stringify(timers.live().map((timer) => timer.due - clock.now))}`,
          );
        const next = Math.min(...timers.live().map((timer) => timer.due));
        if (!Number.isFinite(next) || next > target) break;
        clock.now = Math.max(clock.now, next);
        await timers.fireDue();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      clock.now = target;
    },
    setPolicy: (next: string) => {
      policy = next;
    },
    turnEnded: (method = 'turn.completed') =>
      busListener?.({
        event: 'orchestration:event',
        data: { event: { method } },
      }),
    request: () => {
      const path = serviceUpdatePaths(install.installRoot).request;
      return existsSync(path)
        ? parseServiceUpdateRequest(readFileSync(path, 'utf8'))
        : null;
    },
  };
}

describe('the server update coordinator (#3851)', () => {
  test('checks once after the boot delay, not before, and a repeated trigger within the TTL does not refetch', async () => {
    const install = makeInstall();
    const { coordinator, clock, timers, published } = coordinatorFor(install, {
      policy: 'never',
    });
    coordinator.start();
    await timers.fireDue();
    expect(fetchFn).not.toHaveBeenCalled();
    clock.now += 60_000;
    await timers.fireDue();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({
        supported: true,
        currentVersion: RUNNING,
        availability: {
          latestVersion: NEWER,
          updateAvailable: true,
          releaseCheck: 'verified',
        },
        downloadPolicy: 'never',
        autoDownloadAt: null,
      }),
    );
    await coordinator.check('again');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await coordinator.check('forced', { force: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  test('a client newer than the server triggers a check; an equal or older one does not', async () => {
    const install = makeInstall();
    const { coordinator } = coordinatorFor(install, { policy: 'never' });
    coordinator.noteClientBuild(`${RUNNING}+abcdef0`);
    coordinator.noteClientBuild('0.7.9');
    coordinator.noteClientBuild(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchFn).not.toHaveBeenCalled();
    coordinator.noteClientBuild('0.8.1+abcdef0');
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  });

  test('policy immediately stages the available version as soon as a check finds it', async () => {
    const install = makeInstall();
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER });
  });

  test('policy never downloads nothing by itself', async () => {
    const install = makeInstall();
    const { coordinator, request, timers } = coordinatorFor(install, {
      policy: 'never',
    });
    await coordinator.check('boot');
    expect(request()).toBeNull();
    expect(timers.live()).toHaveLength(0);
  });

  test('after-24h (the default) waits 24 hours from the first check that saw the version, across a restart', async () => {
    const install = makeInstall();
    const first = coordinatorFor(install);
    await first.coordinator.check('boot');
    expect(first.request()).toBeNull();
    const state = await first.coordinator.state();
    expect(state.downloadPolicy).toBe('after-24h');
    const seen = Date.parse(state.availability?.availableSince ?? '');
    expect(seen).toBe(first.clock.now);
    expect(state.autoDownloadAt).toBe(
      new Date(seen + SERVER_UPDATE_DOWNLOAD_DELAY_MS).toISOString(),
    );
    // One timer, toward that moment: at most MAX_TIMER_MS ahead (review F3).
    expect(first.timers.live().map((timer) => timer.due)).toEqual([
      Math.min(seen + SERVER_UPDATE_DOWNLOAD_DELAY_MS, seen + MAX_TIMER_MS),
    ]);
    first.coordinator.stop();

    // The server restarted 23 hours later: still not due, and the clock
    // still counts from the first sighting.
    const clock = { now: seen + 23 * 60 * 60_000 };
    const second = coordinatorFor(install, { clock });
    await second.coordinator.check('boot');
    expect(second.request()).toBeNull();
    expect(second.timers.live().map((timer) => timer.due)).toEqual([
      seen + SERVER_UPDATE_DOWNLOAD_DELAY_MS,
    ]);
    clock.now = seen + SERVER_UPDATE_DOWNLOAD_DELAY_MS;
    await second.timers.fireDue();
    await vi.waitFor(() =>
      expect(second.request()).toMatchObject({
        mode: 'stage',
        targetVersion: NEWER,
      }),
    );
  });

  test('changing the policy re-evaluates the last check at once', async () => {
    const install = makeInstall();
    const { coordinator, request, setPolicy } = coordinatorFor(install, {
      policy: 'never',
    });
    await coordinator.check('boot');
    expect(request()).toBeNull();
    setPolicy('immediately');
    await coordinator.settingsChanged();
    expect(request()).toMatchObject({ mode: 'stage' });
  });

  test('a staged version is not downloaded again', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    expect(request()).toBeNull();
    expect((await coordinator.state()).progress).toMatchObject({
      state: 'staged',
      version: NEWER,
    });
  });

  test('apply-when-idle waits while a turn runs and applies once the last one ends', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    let running = [{ sessionId: 's-1' }];
    const { coordinator, timers, clock, turnEnded, request } = coordinatorFor(
      install,
      { policy: 'never', running: () => running },
    );
    coordinator.start();
    coordinator.markReady();
    const set = await coordinator.setApplyWhenIdle(NEWER);
    expect(set).toMatchObject({
      ok: true,
      state: { applyWhenIdle: { version: NEWER } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request()).toBeNull();

    // A turn ends while another still runs: nothing.
    turnEnded();
    clock.now += 2_000;
    await timers.fireDue();
    expect(request()).toBeNull();

    running = [];
    turnEnded();
    clock.now += 2_000;
    await timers.fireDue();
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'apply', targetVersion: NEWER }),
    );
    expect((await coordinator.state()).applyWhenIdle).toBeNull();
    coordinator.stop();
  });

  test('apply-when-idle with nothing running applies at once; a cancelled intent never applies', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    let running = [{ sessionId: 's-1' }];
    const { coordinator, timers, clock, turnEnded, request } = coordinatorFor(
      install,
      { policy: 'never', running: () => running },
    );
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    await coordinator.cancelApplyWhenIdle();
    running = [];
    turnEnded();
    clock.now += 2_000;
    await timers.fireDue();
    expect(request()).toBeNull();
    expect((await coordinator.state()).applyWhenIdle).toBeNull();

    await coordinator.setApplyWhenIdle(NEWER);
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'apply', targetVersion: NEWER }),
    );
    coordinator.stop();
  });

  test('apply-when-idle needs the staged version it names', async () => {
    const install = makeInstall();
    const { coordinator } = coordinatorFor(install);
    expect(await coordinator.setApplyWhenIdle(NEWER)).toMatchObject({
      ok: false,
      status: 409,
    });
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    expect(await coordinator.setApplyWhenIdle('0.8.0-preview.3')).toMatchObject(
      { ok: false, status: 409 },
    );
  });

  test('pushes each change of a stage’s progress while it is queued or staging, then stops reading', async () => {
    const install = makeInstall();
    const { coordinator, timers, clock, published } = coordinatorFor(install, {
      policy: 'never',
    });
    coordinator.start();
    const stage = await coordinator.stage();
    expect(stage.ok).toBe(true);
    const requestId = (stage.ok && stage.requestId) || '';
    expect(published.at(-1)).toMatchObject({
      progress: { state: 'queued', intent: 'stage' },
    });
    // The child claims it and reports bytes.
    const paths = serviceUpdatePaths(install.installRoot);
    const { renameSync } = await import('node:fs');
    renameSync(paths.request, paths.processing);
    writeFileSync(
      paths.stageProgress,
      JSON.stringify({
        requestId,
        phase: 'downloading',
        downloadedBytes: 10,
        totalBytes: 100,
        at: 'x',
      }),
    );
    clock.now += 1_000;
    await timers.fireDue();
    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({
        progress: {
          state: 'staging',
          stagePhase: 'downloading',
          downloadedBytes: 10,
          totalBytes: 100,
        },
      }),
    );
    const count = published.length;
    clock.now += 1_000;
    await timers.fireDue();
    // Unchanged: nothing pushed.
    expect(published).toHaveLength(count);

    // Staged: pushed, and the follow ends.
    rmSync(paths.processing);
    rmSync(paths.stageProgress);
    stageOnDisk(install, NEWER, requestId);
    clock.now += 1_000;
    await timers.fireDue();
    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({
        progress: { state: 'staged', version: NEWER },
      }),
    );
    expect(timers.live()).toHaveLength(1); // only the boot check is left
    coordinator.stop();
  });

  test('after the update commits, the new server drops the intent for the version it now runs', async () => {
    const install = makeInstall();
    const runtime = serviceUpdatePaths(install.installRoot).runtime;
    mkdirSync(runtime, { recursive: true });
    writeFileSync(
      join(runtime, 'server-update.json'),
      JSON.stringify({
        applyWhenIdle: {
          version: RUNNING,
          requestedAt: '2026-10-18T00:00:00Z',
        },
        availableSince: { version: RUNNING, at: '2026-10-18T00:00:00Z' },
      }),
    );
    const { coordinator } = coordinatorFor(install, { policy: 'never' });
    coordinator.start();
    expect(existsSync(join(runtime, 'server-update.json'))).toBe(false);
    coordinator.stop();
  });

  test('an install the launcher does not run is unsupported and does nothing', async () => {
    const install = makeInstall();
    const coordinator = new ServerUpdateCoordinator({
      provenance: () => resolveInstallProvenance(install.moduleDir),
      options: { env: {} },
      readDownloadPolicy: async () => 'immediately',
      listRunningTurns: async () => [],
      publish: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(coordinator.supported()).toBe(false);
    coordinator.start();
    expect(await coordinator.check('boot')).toBeNull();
    expect((await coordinator.state()).supported).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('the update state, apply-when-idle and running-turns routes (#3851)', () => {
  test('serve the coordinator’s state, set and cancel the intent, and list running turns', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator } = coordinatorFor(install, {
      policy: 'never',
      running: () => [{ sessionId: 's-1' }],
    });
    const listRunningTurnsFor = vi.fn(async () => ({
      turns: [
        {
          sessionId: 's-1',
          conversationId: 'c-1',
          title: 'Fix the build',
          engine: 'codex',
          startedAt: null,
        },
      ],
      hiddenCount: 1,
    }));
    const app = createApp(install, {
      extraDeps: { serverUpdate: coordinator, listRunningTurnsFor },
    });
    expect(await json(await app.request('/core-update/state'))).toMatchObject({
      supported: true,
      progress: { state: 'staged', version: NEWER },
      applyWhenIdle: null,
    });
    const bad = await app.request('/core-update/apply-when-idle', {
      method: 'PUT',
      body: JSON.stringify({ version: 'not a version' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    const set = await app.request('/core-update/apply-when-idle', {
      method: 'PUT',
      body: JSON.stringify({ version: NEWER }),
      headers: { 'content-type': 'application/json' },
    });
    expect(set.status).toBe(200);
    expect((await json(set)).state.applyWhenIdle).toMatchObject({
      version: NEWER,
    });
    const cancelled = await app.request('/core-update/apply-when-idle', {
      method: 'DELETE',
    });
    expect((await json(cancelled)).state.applyWhenIdle).toBeNull();
    expect(await json(await app.request('/core-update/running-turns'))).toEqual(
      {
        turns: [expect.objectContaining({ title: 'Fix the build' })],
        hiddenCount: 1,
      },
    );
  });

  test('without a coordinator the state reads unsupported and the intent is refused', async () => {
    const install = makeInstall();
    const app = createApp(install);
    expect(await json(await app.request('/core-update/state'))).toMatchObject({
      supported: false,
    });
    const set = await app.request('/core-update/apply-when-idle', {
      method: 'PUT',
      body: JSON.stringify({ version: NEWER }),
      headers: { 'content-type': 'application/json' },
    });
    expect(set.status).toBe(409);
  });
});

/** What a request file asks, and that the request is gone (the child took it). */
function settleRequest(install: Install, result: Record<string, unknown>) {
  const paths = serviceUpdatePaths(install.installRoot);
  const request = parseServiceUpdateRequest(
    readFileSync(paths.request, 'utf8'),
  );
  rmSync(paths.request);
  writeFileSync(
    paths.result,
    JSON.stringify({
      requestId: request?.id,
      at: '2026-10-19T10:30:00.000Z',
      ...result,
    }),
  );
  return request;
}

describe('the coordinator after review (#3851 F2-F8, F12)', () => {
  test('F2: a cancel while the idle check waits on the running turns restarts nothing', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    let answer: (turns: Array<{ sessionId: string }>) => void = () => undefined;
    let asked = false;
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'never',
      running: () =>
        new Promise((resolve) => {
          asked = true;
          answer = resolve;
        }),
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    // The evaluation has asked for the running turns and is waiting on them.
    await vi.waitFor(() => expect(asked).toBe(true));
    // The evaluation is waiting; the person cancels.
    expect(await coordinator.cancelApplyWhenIdle()).toMatchObject({ ok: true });
    answer([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request()).toBeNull();
    coordinator.stop();
  });

  test('F2: a cancel after the restart was requested says so instead of claiming it', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'never',
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    await vi.waitFor(() => expect(request()).toMatchObject({ mode: 'apply' }));
    expect(await coordinator.cancelApplyWhenIdle()).toMatchObject({
      ok: false,
      status: 409,
    });
    coordinator.stop();
  });

  test('F3: a first sighting in the future counts from now, and no timer exceeds the cap', async () => {
    const install = makeInstall();
    const runtime = serviceUpdatePaths(install.installRoot).runtime;
    mkdirSync(runtime, { recursive: true });
    const clock = { now: Date.parse('2026-10-19T10:00:00Z') };
    writeFileSync(
      join(runtime, 'server-update.json'),
      JSON.stringify({
        availableSince: {
          version: NEWER,
          at: new Date(clock.now + 60 * 24 * 60 * 60_000).toISOString(),
        },
      }),
    );
    const { coordinator, timers } = coordinatorFor(install, { clock });
    await coordinator.check('boot');
    const state = await coordinator.state();
    expect(state.availability?.availableSince).toBe(
      new Date(clock.now).toISOString(),
    );
    for (const timer of timers.live())
      expect(timer.due - clock.now).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(timers.live()).toHaveLength(1);
  });

  test('F3: a deadline past the cap is reached by re-arming, not by a 1 ms timer', async () => {
    const install = makeInstall();
    const { coordinator, timers, clock, request } = coordinatorFor(install);
    await coordinator.check('boot');
    const [first] = timers.live();
    expect(first?.due).toBe(clock.now + MAX_TIMER_MS);
    clock.now += MAX_TIMER_MS;
    await timers.fireDue();
    await vi.waitFor(() => expect(timers.live()).toHaveLength(1));
    expect(request()).toBeNull();
  });

  test('F4: the policy downloads a version once; a failed download waits for a person or a newer release', async () => {
    const install = makeInstall();
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER });
    settleRequest(install, { status: 'failed', reason: 'curl: (22) 404' });
    await coordinator.check('newer-client', { force: true });
    expect(request()).toBeNull();
    // Not again at once: it is retried after the first backoff (round 2).
    expect((await coordinator.state()).autoDownloadPausedReason).toBe(
      'download-failed',
    );
    // A person's Download still works.
    expect(await coordinator.stage()).toMatchObject({ ok: true });
    settleRequest(install, { status: 'failed', reason: 'again' });
    // A newer release is downloaded by the policy again.
    serveManifest(signedManifest(releasePayload('0.8.0-preview.3')));
    await coordinator.check('newer-client', { force: true });
    expect(request()).toMatchObject({
      mode: 'stage',
      targetVersion: '0.8.0-preview.3',
    });
  });

  test('F4: a version whose update rolled back is not downloaded again by the policy', async () => {
    const install = makeInstall();
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({
        protocol: 1,
        activeVersion: RUNNING,
        update: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          fromVersion: RUNNING,
          targetVersion: NEWER,
          status: 'rolled-back',
          reason: 'prepared-timeout',
          attempts: 2,
          finishedAt: '2026-10-19T09:00:00.000Z',
        },
      }),
    );
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    expect(request()).toBeNull();
  });

  test('F4: a client’s check (GET /core-update) never runs the policy', async () => {
    const install = makeInstall();
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    const app = createApp(install, {
      extraDeps: { serverUpdate: coordinator },
    });
    expect((await app.request('/core-update')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request()).toBeNull();
    // It still refreshed what the state reports.
    expect((await coordinator.state()).availability).toMatchObject({
      latestVersion: NEWER,
    });
  });

  test('F4: saving another setting re-runs nothing; changing the policy does', async () => {
    const install = makeInstall();
    const { coordinator, request, setPolicy } = coordinatorFor(install, {
      policy: 'immediately',
    });
    coordinator.start();
    // A client's check fills the cache without running the policy, so a
    // policy run would download now: only a policy change may run it.
    const app = createApp(install, {
      extraDeps: { serverUpdate: coordinator },
    });
    expect((await app.request('/core-update')).status).toBe(200);
    await vi.waitFor(async () =>
      expect((await coordinator.state()).availability).not.toBeNull(),
    );
    await coordinator.settingsChanged();
    expect(request()).toBeNull();
    setPolicy('never');
    await coordinator.settingsChanged();
    setPolicy('immediately');
    await coordinator.settingsChanged();
    expect(request()).toMatchObject({ mode: 'stage' });
    coordinator.stop();
  });

  test('F5: any runtime event re-evaluates apply-when-idle, a runtime error included', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    let running = [{ sessionId: 'webhook' }];
    const { coordinator, timers, clock, turnEnded, request } = coordinatorFor(
      install,
      { policy: 'never', running: () => running },
    );
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request()).toBeNull();
    running = [];
    turnEnded('runtime.error');
    clock.now += 2_000;
    await timers.fireDue();
    await vi.waitFor(() => expect(request()).toMatchObject({ mode: 'apply' }));
    coordinator.stop();
  });

  test('F6: the policy does not download a newer release while an apply-when-idle waits', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
      running: () => [{ sessionId: 's-1' }],
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    serveManifest(signedManifest(releasePayload('0.8.0-preview.3')));
    await coordinator.check('newer-client', { force: true });
    expect(request()).toBeNull();
    expect((await coordinator.state()).applyWhenIdle).toMatchObject({
      version: NEWER,
    });
    coordinator.stop();
  });

  test('F8: a persisted apply-when-idle waits for the server to be ready', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const runtime = serviceUpdatePaths(install.installRoot).runtime;
    writeFileSync(
      join(runtime, 'server-update.json'),
      JSON.stringify({
        applyWhenIdle: { version: NEWER, requestedAt: '2026-10-19T09:00:00Z' },
      }),
    );
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'never',
    });
    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(request()).toBeNull();
    coordinator.markReady();
    await vi.waitFor(() => expect(request()).toMatchObject({ mode: 'apply' }));
    coordinator.stop();
  });

  test('F12: the broadcast withholds a failed download’s detail; the state route keeps it', async () => {
    const install = makeInstall();
    const { coordinator, published } = coordinatorFor(install, {
      policy: 'never',
    });
    await coordinator.stage();
    settleRequest(install, {
      status: 'failed',
      reason: 'could not download /home/me/.station/tmp/x.tgz',
    });
    await coordinator.publish();
    expect(published.at(-1)).toMatchObject({
      progress: { state: 'staging-failed', reason: 'withheld' },
    });
    expect((await coordinator.state()).progress).toMatchObject({
      reason: 'could not download /home/me/.station/tmp/x.tgz',
    });
  });
});

describe('stage and apply on an install that has updated before (#3851 review F1)', () => {
  /** service-state.json as station-launcher.mjs `onPrepared` leaves it. */
  function committedEarlier(install: Install) {
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      `${JSON.stringify(
        {
          protocol: 1,
          activeVersion: RUNNING,
          update: {
            id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            fromVersion: '0.8.0-preview.0',
            targetVersion: RUNNING,
            requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            status: 'committed',
            attempts: 1,
            finishedAt: '2026-10-18T09:00:00.000Z',
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  test('a later stage reads staged and can be applied, past the old committed record', async () => {
    const install = makeInstall();
    committedEarlier(install);
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const app = createApp(install);
    expect(
      await json(await app.request('/core-update/service-update?staged=1')),
    ).toMatchObject({ state: 'staged', version: NEWER });
    const applied = await app.request('/core-update', {
      method: 'POST',
      body: JSON.stringify({ action: 'apply', version: NEWER }),
      headers: { 'content-type': 'application/json' },
    });
    expect(applied.status).toBe(202);
  });

  test('the policy does not stage again what is staged past an old committed record', async () => {
    const install = makeInstall();
    committedEarlier(install);
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    expect(request()).toBeNull();
  });
});

describe('the coordinator, review round 2 (#3851)', () => {
  test('item 1: with no apply-when-idle pending, runtime events resolve nothing and arm nothing', async () => {
    const install = makeInstall();
    const { coordinator, turnEnded, timers, provenanceCalls } = coordinatorFor(
      install,
      { policy: 'never' },
    );
    coordinator.start();
    coordinator.markReady();
    const before = provenanceCalls();
    const armed = timers.live().length;
    for (let event = 0; event < 100; event += 1)
      turnEnded('content.text-delta');
    expect(provenanceCalls()).toBe(before);
    expect(timers.live()).toHaveLength(armed);
    // And the resolution happened once for the whole life of the coordinator.
    await coordinator.state();
    await coordinator.state();
    expect(provenanceCalls()).toBe(1);
    coordinator.stop();
  });

  test('item 2: an early timer re-arms without fetching; the deadline check runs once', async () => {
    const install = makeInstall();
    const { coordinator, advance, request } = coordinatorFor(install);
    await coordinator.check('boot');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await advance(23 * 60 * 60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(request()).toBeNull();
    await advance(60 * 60_000);
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER }),
    );
  });

  test('item 2: a deadline check that fails is retried after a backoff, not dropped', async () => {
    const install = makeInstall();
    const { coordinator, advance, request } = coordinatorFor(install);
    await coordinator.check('boot');
    fetchFn.mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));
    await advance(24 * 60 * 60_000);
    expect(request()).toBeNull();
    // The first retry waits one backoff step (1 h).
    await advance(60 * 60_000);
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER }),
    );
  });

  test('item 2: a deadline check that does not verify is retried after a backoff', async () => {
    const install = makeInstall();
    const { coordinator, advance, request } = coordinatorFor(install);
    await coordinator.check('boot');
    const other = generateKeyPairSync('ed25519');
    serveManifest(signedManifest(releasePayload(NEWER), other.privateKey));
    await advance(24 * 60 * 60_000);
    expect(request()).toBeNull();
    serveManifest(signedManifest(releasePayload(NEWER)));
    await advance(60 * 60_000);
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER }),
    );
  });

  test('item 5: a failed policy download is retried after a backoff and says why it paused', async () => {
    const install = makeInstall();
    const { coordinator, advance, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    const first = settleRequest(install, {
      status: 'failed',
      reason: 'curl: (56) connection reset',
    });
    expect(first).toMatchObject({ mode: 'stage' });
    await coordinator.check('newer-client', { force: true });
    expect(request()).toBeNull();
    const paused = await coordinator.state();
    expect(paused.autoDownloadPausedReason).toBe('download-failed');
    expect(paused.autoDownloadAt).not.toBeNull();
    await advance(60 * 60_000);
    await vi.waitFor(() =>
      expect(request()).toMatchObject({ mode: 'stage', targetVersion: NEWER }),
    );
  });

  test('item 5: a rolled-back update stays paused, and says so', async () => {
    const install = makeInstall();
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({
        protocol: 1,
        activeVersion: RUNNING,
        update: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          fromVersion: RUNNING,
          targetVersion: NEWER,
          status: 'rolled-back',
          reason: 'prepared-timeout',
          attempts: 2,
          finishedAt: '2026-10-19T09:00:00.000Z',
        },
      }),
    );
    const { coordinator, advance, request } = coordinatorFor(install, {
      policy: 'immediately',
    });
    await coordinator.check('boot');
    const state = await coordinator.state();
    expect(state.autoDownloadPausedReason).toBe('update-failed');
    expect(state.autoDownloadAt).toBeNull();
    await advance(48 * 60 * 60_000);
    expect(request()).toBeNull();
  });

  test('item 7: a download while an update when idle waits is refused', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, request } = coordinatorFor(install, {
      policy: 'never',
      running: () => [{ sessionId: 's-1' }],
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    serveManifest(signedManifest(releasePayload('0.8.0-preview.3')));
    const app = createApp(install, {
      extraDeps: { serverUpdate: coordinator },
    });
    const res = await app.request('/core-update', {
      method: 'POST',
      body: JSON.stringify({ action: 'stage' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/cancel it before downloading/);
    expect(request()).toBeNull();
    expect((await coordinator.state()).applyWhenIdle).toMatchObject({
      version: NEWER,
    });
    coordinator.stop();
  });

  test('item 8: the state says how many running turns an update when idle waits for', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator } = coordinatorFor(install, {
      policy: 'never',
      running: () => [{ sessionId: 's-1' }, { sessionId: 'webhook' }],
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    await vi.waitFor(async () =>
      expect((await coordinator.state()).applyWhenIdle).toMatchObject({
        version: NEWER,
        waitingForTurns: 2,
      }),
    );
    coordinator.stop();
  });

  test('item 9: a new server keeps the policy download record for a still-newer version', async () => {
    const install = makeInstall();
    const runtime = serviceUpdatePaths(install.installRoot).runtime;
    mkdirSync(runtime, { recursive: true });
    const file = join(runtime, 'server-update.json');
    writeFileSync(
      file,
      JSON.stringify({
        availableSince: { version: RUNNING, at: '2026-10-18T00:00:00Z' },
        autoStaged: {
          version: NEWER,
          at: '2026-10-18T00:00:00Z',
          attempts: 1,
          refused: true,
        },
      }),
    );
    const { coordinator } = coordinatorFor(install, { policy: 'never' });
    coordinator.start();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      autoStaged: {
        version: NEWER,
        at: '2026-10-18T00:00:00Z',
        attempts: 1,
        refused: true,
      },
    });
    coordinator.stop();
  });

  test('item 9: cancelling while the launcher is updating says nothing was cancelled', async () => {
    const install = makeInstall();
    const paths = serviceUpdatePaths(install.installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      JSON.stringify({
        protocol: 1,
        activeVersion: RUNNING,
        update: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          fromVersion: RUNNING,
          targetVersion: NEWER,
          status: 'pending',
          phase: 'trial',
          attempts: 1,
        },
      }),
    );
    const { coordinator } = coordinatorFor(install, { policy: 'never' });
    expect(await coordinator.cancelApplyWhenIdle()).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('the coordinator, review round 3 (#3851)', () => {
  /** A fetch that waits until the test rejects it. */
  function heldFetch() {
    let reject: (error: Error) => void = () => undefined;
    fetchFn.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    return (error: Error) => reject(error);
  }

  test('item 1: saving never while the deadline check runs leaves nothing to retry', async () => {
    const install = makeInstall();
    const { coordinator, advance, setPolicy, request } =
      coordinatorFor(install);
    coordinator.start();
    await coordinator.check('boot');
    const fail = heldFetch();
    await advance(24 * 60 * 60_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    // The person turns the download off while the check is in flight.
    setPolicy('never');
    await coordinator.settingsChanged();
    fail(new Error('getaddrinfo EAI_AGAIN'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fetches = fetchFn.mock.calls.length;
    await advance(31 * 60 * 60_000);
    expect(fetchFn.mock.calls.length).toBe(fetches);
    expect(request()).toBeNull();
    coordinator.stop();
  });

  test('item 2: a stop while the deadline check runs arms nothing afterwards', async () => {
    const install = makeInstall();
    const { coordinator, advance, timers } = coordinatorFor(install);
    await coordinator.check('boot');
    const fail = heldFetch();
    await advance(24 * 60 * 60_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    coordinator.stop();
    fail(new Error('getaddrinfo EAI_AGAIN'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(timers.live()).toEqual([]);
  });

  test('item 7: any verified check resets the deadline failure backoff', async () => {
    const install = makeInstall();
    const { coordinator, advance, timers, clock } = coordinatorFor(install);
    await coordinator.check('boot');
    fetchFn.mockRejectedValueOnce(new Error('EAI_AGAIN'));
    await advance(24 * 60 * 60_000);
    // First failure: the retry is 1 h out.
    await vi.waitFor(() =>
      expect(timers.live().map((timer) => timer.due - clock.now)).toEqual([
        60 * 60_000,
      ]),
    );
    // A client's check verifies meanwhile; it runs no policy.
    const app = createApp(install, {
      extraDeps: { serverUpdate: coordinator },
    });
    expect((await app.request('/core-update')).status).toBe(200);
    fetchFn.mockRejectedValueOnce(new Error('EAI_AGAIN'));
    await advance(60 * 60_000);
    // The second failure counts from the reset: 1 h again, not 6 h.
    await vi.waitFor(() =>
      expect(timers.live().map((timer) => timer.due - clock.now)).toEqual([
        60 * 60_000,
      ]),
    );
    coordinator.stop();
  });

  test('item 8: an unreadable intent file does not clear the pending update when idle', async () => {
    const install = makeInstall();
    stageOnDisk(install, NEWER, STAGE_REQUEST);
    const { coordinator, turnEnded, timers } = coordinatorFor(install, {
      policy: 'never',
      running: () => [{ sessionId: 's-1' }],
    });
    coordinator.start();
    coordinator.markReady();
    await coordinator.setApplyWhenIdle(NEWER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const file = join(
      serviceUpdatePaths(install.installRoot).runtime,
      'server-update.json',
    );
    chmodSync(file, 0o000);
    try {
      await coordinator.state();
      const before = timers.live().length;
      turnEnded();
      // Still pending in memory: the event arms the idle re-evaluation.
      expect(timers.live().length).toBe(before + 1);
    } finally {
      chmodSync(file, 0o600);
      coordinator.stop();
    }
  });
});
