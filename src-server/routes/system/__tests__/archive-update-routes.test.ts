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
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { serviceUpdatePaths } from '@kontourai/station-shared/service-launcher-protocol';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  systemOps: { add: vi.fn() },
}));

const { createSystemUpdateRoutes } = await import('../system-update-routes.js');

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
  } = {},
) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const deps = { getAppConfig: () => ({}), eventBus: { emit: vi.fn() } };
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

    expect(
      await json(await app.request('/core-update/service-update')),
    ).toEqual({ state: 'queued', requestId });
    // The GET reports it too, so a client never offers a second apply.
    expect(
      (await json(await app.request('/core-update'))).serviceUpdate,
    ).toEqual({ state: 'queued', requestId });

    const again = await app.request('/core-update', { method: 'POST' });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toMatch(/already in progress/);
    expect(JSON.parse(readFileSync(paths.request, 'utf8')).id).toBe(requestId);
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
    ).toEqual({ state: 'staging', requestId: REQUEST_ID });

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
