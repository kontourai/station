import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  systemOps: { add: vi.fn() },
}));
const spawnMock = vi.fn();
const execFileMock = vi.fn((...args: unknown[]) => {
  const optsOrCb = args[2];
  const cb = args[3] as ((error: unknown, result: unknown) => void) | undefined;
  const callback =
    typeof optsOrCb === 'function'
      ? (optsOrCb as (error: unknown, result: unknown) => void)
      : cb;
  callback?.(null, { stdout: '', stderr: '' });
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
vi.mock('../install-provenance.js', () => ({
  resolveInstallProvenance: vi.fn(),
  fetchChannelLatestSha: vi.fn(),
  resolveSelfUpdateEligibility: vi.fn(),
}));
vi.mock('../../../utils/git-exec.js', () => ({
  execGit: vi.fn(),
}));

const { createSystemUpdateRoutes, performGitPullRestart } = await import(
  '../system-update-routes.js'
);
const {
  resolveInstallProvenance,
  fetchChannelLatestSha,
  resolveSelfUpdateEligibility,
} = await import('../install-provenance.js');
const { execGit } = await import('../../../utils/git-exec.js');
const {
  readSelfUpdateRestartRecord,
  restartStateFilePath,
  writeSelfUpdateRestartRecord,
} = await import('../self-update-restart-state.js');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const bundleProvenance = {
  installKind: 'desktop-bundle' as const,
  stampPath: '/bundle/Resources/station-nightly-source.json',
  channel: 'nightly',
  ref: 'origin/main',
  sha: SHA,
  repository: 'https://github.com/kontourai/station.git',
  createdAt: '2026-08-02T00:00:00Z',
  sourceCheckout: null,
};

function createApp(
  // The full `Logger` surface this route uses. `createSystemUpdateRoutes`
  // takes `logger: any`, so a stub missing a level is not a type error — it
  // is a `logger.<level> is not a function` throw inside the route's own
  // catch block, which turns a diagnostic into a changed response body.
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  restartStateWriter?: typeof writeSelfUpdateRestartRecord,
) {
  const deps = { getAppConfig: () => ({}), eventBus: { emit: vi.fn() } };
  return createSystemUpdateRoutes(deps as never, logger, restartStateWriter);
}

beforeEach(() => {
  // Bundles are ineligible for self-update unless a test opts in (archive#1624).
  vi.mocked(resolveSelfUpdateEligibility).mockResolvedValue({
    eligible: false,
    reason: 'no source checkout recorded',
  });
  // The GET diagnostics read the REAL process env for the server identity;
  // scrub it so `serverIdentity` is deterministically null unless a test
  // explicitly arms it.
  for (const key of [
    'STATION_BUILD_SHA',
    'STATION_BUILD_BRANCH',
    'STATION_BUILD_BUILT_AT',
    'STATION_INSTANCE_ID',
    'STATION_BOOT_ID',
  ]) {
    delete process.env[key];
  }
});

describe('GET /core-update on a desktop bundle', () => {
  test('reports channel provenance and update availability, never an error field (AC1)', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(fetchChannelLatestSha).mockResolvedValue(OTHER_SHA);

    const res = await createApp().request('/core-update');
    const body = await json(res);
    expect(body).toEqual({
      installKind: 'desktop-bundle',
      applyMethod: 'reinstall',
      channel: 'nightly',
      branch: 'main',
      currentHash: SHA.slice(0, 7),
      remoteHash: OTHER_SHA.slice(0, 7),
      updateAvailable: true,
      serverIdentity: null,
      provenanceIssue: null,
      technicalDetail: null,
      // The beforeEach default refusal reason surfaces as a diagnostic —
      // this is what lets the UI say WHY apply is unavailable.
      selfUpdateUnavailableReason: 'no source checkout recorded',
    });
    expect(body.error).toBeUndefined();
  });

  test('carries the server identity triple when the process has one', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(fetchChannelLatestSha).mockResolvedValue(SHA);
    process.env.STATION_BUILD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    process.env.STATION_INSTANCE_ID = 'desktop';
    process.env.STATION_BOOT_ID = '22222222-2222-4222-8222-222222222222';
    try {
      const body = await json(await createApp().request('/core-update'));
      expect(body.serverIdentity).toEqual({
        instanceId: 'desktop',
        bootId: '22222222-2222-4222-8222-222222222222',
        // Env-only sha: labeled as checkout-derived, never build-stamp.
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        shaSource: 'checkout',
      });
    } finally {
      delete process.env.STATION_BUILD_SHA;
      delete process.env.STATION_INSTANCE_ID;
      delete process.env.STATION_BOOT_ID;
    }
  });

  test('an up-to-date bundle reports updateAvailable false', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(fetchChannelLatestSha).mockResolvedValue(SHA);

    const body = await json(await createApp().request('/core-update'));
    expect(body.updateAvailable).toBe(false);
    expect(body.remoteHash).toBe(SHA.slice(0, 7));
    expect(body.selfUpdateUnavailableReason).toBe(
      'no source checkout recorded',
    );
  });

  test('remote failure is a disclosed warning, not an error the SDK throws on (AC2)', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(fetchChannelLatestSha).mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND github.com'),
    );

    const body = await json(await createApp().request('/core-update'));
    expect(body.updateAvailable).toBe(false);
    expect(body.remoteUnreachable).toBe(true);
    expect(body.message).toContain('nightly');
    expect(body.error).toBeUndefined();
    // Provenance still reported even though the remote was unreachable.
    expect(body.channel).toBe('nightly');
    expect(body.currentHash).toBe(SHA.slice(0, 7));
    // The caught comparison diagnostic lands in technicalDetail; the
    // user-facing message stays the summarized sentence.
    expect(body.technicalDetail).toContain('ENOTFOUND');
    expect(body.message).not.toContain('ENOTFOUND');
  });
});

describe('GET /core-update on an unknown install', () => {
  test('states what is missing instead of "Not a git repository" (AC1/AC6)', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'unknown',
      detail: 'no git checkout and no station-nightly-source.json build stamp',
      reason: 'missing',
    });

    const body = await json(await createApp().request('/core-update'));
    expect(body.installKind).toBe('unknown');
    expect(body.updateAvailable).toBe(false);
    // The user-facing message carries NO filesystem paths — the resolver
    // detail with the paths lives in technicalDetail only.
    expect(body.message).toBe(
      'This install carries no update provenance, so updates cannot be checked from here.',
    );
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Not a git repository');
    // Missing-provenance diagnostics: the reason comes from the resolver's
    // typed code, the detail (with its filesystem paths) from the field.
    expect(body.provenanceIssue).toBe('missing');
    expect(body.technicalDetail).toBe(
      'no git checkout and no station-nightly-source.json build stamp',
    );
    expect(body.message).not.toContain('station-nightly-source.json');
    expect(body.serverIdentity).toBeNull();
    expect(body.selfUpdateUnavailableReason).toBeNull();
  });

  test('an invalid stamp names the invalidity, never absence (update-ux PR2)', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'unknown',
      detail:
        'a build stamp exists at /bundle/station-nightly-source.json but is malformed',
      reason: 'invalid-stamp',
    });

    const body = await json(await createApp().request('/core-update'));
    expect(body.updateAvailable).toBe(false);
    expect(body.applyMethod).toBeUndefined();
    expect(body.provenanceIssue).toBe('invalid-stamp');
    // Exact bytes, paths-free: the malformed-stamp path (with the stamp
    // location) must stay in technicalDetail, never in the message.
    expect(body.message).toBe(
      "This server's update provenance is invalid. Station cannot determine whether a server update is available, so updates cannot be checked from here.",
    );
    expect(body.technicalDetail).toContain('malformed');
    expect(body.error).toBeUndefined();
  });
});

describe('GET /core-update on a source checkout (AC4)', () => {
  test('keeps the git compare shape and gains additive install fields', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot: '/repo',
      branch: 'main',
      sha: 'abc1234',
    });
    vi.mocked(execGit).mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('@{u}')) {
        return { stdout: `${OTHER_SHA}\n`, stderr: '' } as never;
      }
      if (args[0] === 'rev-list' && args[1] === 'HEAD..@{u}') {
        return { stdout: '3\n', stderr: '' } as never;
      }
      if (args[0] === 'rev-list' && args[1] === '@{u}..HEAD') {
        return { stdout: '0\n', stderr: '' } as never;
      }
      return { stdout: '', stderr: '' } as never;
    });

    const body = await json(await createApp().request('/core-update'));
    expect(body).toMatchObject({
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      currentHash: 'abc1234',
      remoteHash: OTHER_SHA.slice(0, 7),
      branch: 'main',
      behind: 3,
      ahead: 0,
      updateAvailable: true,
      // A healthy checkout comparison carries the diagnostics too — null
      // where nothing is wrong (update-ux PR2).
      serverIdentity: null,
      provenanceIssue: null,
      technicalDetail: null,
      selfUpdateUnavailableReason: null,
    });
  });

  test('a failed comparison keeps its identity and discloses the caught diagnostic', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot: '/repo',
      branch: 'main',
      sha: 'abc1234',
    });
    process.env.STATION_BUILD_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
    process.env.STATION_INSTANCE_ID = 'desktop';
    process.env.STATION_BOOT_ID = '22222222-2222-4222-8222-222222222222';
    // Upstream EXISTS (first rev-parse succeeds), then the fetch that
    // follows fails — that is what reaches the route's outer catch, unlike
    // an upstream-less checkout which takes the disclosed noUpstream branch.
    let gitCall = 0;
    vi.mocked(execGit).mockImplementation(async () => {
      gitCall += 1;
      if (gitCall === 1)
        return { stdout: 'origin/main\n', stderr: '' } as never;
      throw new Error('git fetch timed out');
    });
    try {
      const body = await json(await createApp().request('/core-update'));
      expect(body.updateAvailable).toBe(false);
      // The SDK throws on `error`, but the identity of the process that
      // failed was still captured BEFORE the comparison — it must survive.
      expect(body.error).toContain('git fetch timed out');
      expect(body.serverIdentity).toMatchObject({ instanceId: 'desktop' });
      expect(body.technicalDetail).toContain('git fetch timed out');
      expect(body.provenanceIssue).toBeNull();
      expect(body.selfUpdateUnavailableReason).toBeNull();
    } finally {
      delete process.env.STATION_BUILD_SHA;
      delete process.env.STATION_INSTANCE_ID;
      delete process.env.STATION_BOOT_ID;
    }
  });

  test('a checkout without an upstream keeps noUpstream and gains the additive fields', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot: '/repo',
      branch: 'main',
      sha: 'abc1234',
    });
    // Every git call fails: no upstream, no origin to auto-configure one.
    vi.mocked(execGit).mockRejectedValue(new Error('no upstream configured'));

    const body = await json(await createApp().request('/core-update'));
    expect(body).toMatchObject({
      installKind: 'source-checkout',
      applyMethod: 'git-pull',
      currentHash: 'abc1234',
      branch: 'main',
      behind: 0,
      ahead: 0,
      updateAvailable: false,
      noUpstream: true,
      serverIdentity: null,
      provenanceIssue: null,
      technicalDetail: null,
      selfUpdateUnavailableReason: null,
    });
    expect(body.error).toBeUndefined();
  });
});

describe('POST /core-update apply guard (AC3)', () => {
  test('a desktop bundle gets a clean 409 naming the reinstall path', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(execGit).mockClear();

    const res = await createApp().request('/core-update', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain('nightly');
    expect(body.error).toContain('reinstall');
    // The guard fires before any git mutation is attempted.
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
  });

  test('an unknown install gets a 409 without a git attempt', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'unknown',
      detail: 'nothing found',
      reason: 'missing',
    });
    vi.mocked(execGit).mockClear();

    const res = await createApp().request('/core-update', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(vi.mocked(execGit)).not.toHaveBeenCalled();
  });
});

describe('git-based self-update (#1624)', () => {
  const eligible = {
    eligible: true as const,
    checkoutPath: '/Users/dev/station',
    installerPath: '/Users/dev/station/ops/nightly/install-macos.zsh',
  };

  test('an eligible bundle reports applyMethod self-update on GET', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      ...bundleProvenance,
      sourceCheckout: '/Users/dev/station',
    });
    vi.mocked(resolveSelfUpdateEligibility).mockResolvedValue(eligible);
    vi.mocked(fetchChannelLatestSha).mockResolvedValue(OTHER_SHA);

    const body = await json(await createApp().request('/core-update'));
    expect(body.applyMethod).toBe('self-update');
    expect(body.updateAvailable).toBe(true);
    // Eligible means no unavailable reason to disclose.
    expect(body.selfUpdateUnavailableReason).toBeNull();
    expect(body.error).toBeUndefined();
  });

  test('an ineligible bundle keeps applyMethod reinstall and the reason lands in the POST 409', async () => {
    vi.mocked(resolveInstallProvenance).mockReturnValue(bundleProvenance);
    vi.mocked(fetchChannelLatestSha).mockResolvedValue(OTHER_SHA);

    const get = await json(await createApp().request('/core-update'));
    expect(get.applyMethod).toBe('reinstall');

    const res = await createApp().request('/core-update', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toContain('no source checkout recorded');
  });
});

describe('POST self-update apply (#1624)', () => {
  const eligible = {
    eligible: true as const,
    checkoutPath: '/Users/dev/station',
    installerPath: '/Users/dev/station/ops/nightly/install-macos.zsh',
  };

  test('spawns the verified installer detached with --relaunch and answers 202', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const home = mkdtempSync(joinPath(tmpdir(), 'self-update-home-'));
    const stationHome = mkdtempSync(joinPath(tmpdir(), 'self-update-station-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('STATION_HOME', stationHome);
    try {
      vi.mocked(resolveInstallProvenance).mockReturnValue({
        ...bundleProvenance,
        sourceCheckout: '/Users/dev/station',
      });
      vi.mocked(resolveSelfUpdateEligibility).mockResolvedValue(eligible);
      spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

      const res = await createApp().request('/core-update', {
        method: 'POST',
      });
      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body).toMatchObject({ success: true, updating: true });
      expect(String(body.logPath)).toContain(stationHome);
      // The executed file is ALWAYS the verified checkout's own installer,
      // detached so the server's exit cannot kill the swap.
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        [eligible.installerPath, '--relaunch'],
        expect.objectContaining({
          cwd: eligible.checkoutPath,
          detached: true,
          env: expect.objectContaining({ STATION_ROOT: expect.any(String) }),
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('refuses while the installer lock dir exists', async () => {
    const { mkdtempSync, mkdirSync: mkdir } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    // The lock lives under the root THIS runtime actually uses, which is
    // derived from STATION_HOME. A decoy `$HOME/.station` holds no lock: the
    // route used to re-derive `~/.station` by hand, ignoring STATION_HOME, so
    // it read the decoy and let a second installer start on top of a running
    // one for every instance whose home is not the ambient default.
    const decoyHome = mkdtempSync(joinPath(tmpdir(), 'self-update-decoy-'));
    mkdir(joinPath(decoyHome, '.station'), { recursive: true });
    const stationHome = mkdtempSync(joinPath(tmpdir(), 'self-update-lock-'));
    mkdir(joinPath(stationHome, 'cache', 'nightly', 'install.lock'), {
      recursive: true,
    });
    vi.stubEnv('HOME', decoyHome);
    vi.stubEnv('STATION_ROOT', '');
    vi.stubEnv('STATION_HOME', stationHome);
    try {
      vi.mocked(resolveInstallProvenance).mockReturnValue({
        ...bundleProvenance,
        sourceCheckout: '/Users/dev/station',
      });
      vi.mocked(resolveSelfUpdateEligibility).mockResolvedValue(eligible);
      spawnMock.mockClear();

      const res = await createApp().request('/core-update', {
        method: 'POST',
      });
      expect(res.status).toBe(409);
      expect((await json(res)).error).toContain('already in progress');
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('POST /core-update git-pull restart (station#1903)', () => {
  let tmpDirs: string[] = [];
  function tmpGitRoot(): string {
    const dir = mkdtempSync(joinPath(tmpdir(), 'core-update-git-pull-'));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockClear();
    // The route schedules a REAL 500ms setTimeout that ends by calling
    // process.exit(0). Left as a real timer, it survives past the end of
    // whichever test schedules it and fires later in this worker process's
    // life — against whatever test happens to be running at that moment.
    // Fake timers make it inert unless a test explicitly advances past it.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Env stubs (e.g. the supervisor-marker scrub test) must not leak into
    // later tests in this worker (delta-review note); idempotent otherwise.
    vi.unstubAllEnvs();
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  test.each(['pending', 'verified', 'failed'] as const)(
    'GET restart-status reports the durable watchdog %s verdict with its correlation',
    async (status) => {
      const gitRoot = tmpGitRoot();
      const startedAt = '2026-08-09T12:00:00.000Z';
      vi.mocked(resolveInstallProvenance).mockReturnValue({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      });
      const base = {
        instanceId: 'instance-1',
        hash: 'bbbbbbb',
        pid: 7777,
        port: 3141,
        startedAt,
      };
      writeSelfUpdateRestartRecord(
        restartStateFilePath(gitRoot),
        status === 'pending'
          ? { ...base, pid: 0, status }
          : status === 'verified'
            ? {
                ...base,
                status,
                resolvedAt: '2026-08-09T12:00:12.000Z',
              }
            : {
                ...base,
                status,
                resolvedAt: '2026-08-09T12:00:12.000Z',
                failureCode: 'health-unreachable',
              },
      );

      expect(
        await json(await createApp().request('/core-update/restart-status')),
      ).toEqual({
        status,
        expectedHash: 'bbbbbbb',
        expectedInstanceId: 'instance-1',
        // The server's deadline includes the explicit launch hand-off grace,
        // so the client does not time out before the watchdog can write.
        deadlineAt: '2026-08-09T12:01:35.000Z',
        ...(status === 'pending'
          ? {}
          : { resolvedAt: '2026-08-09T12:00:12.000Z' }),
      });
    },
  );

  test('GET restart-status fails closed when no durable watchdog record is readable', async () => {
    const gitRoot = tmpGitRoot();
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot,
      branch: 'main',
      sha: 'abc1234',
    });

    expect(
      await json(await createApp().request('/core-update/restart-status')),
    ).toEqual({ status: 'unavailable' });
  });

  test('GET restart-status fails closed for a corrupt durable watchdog record', async () => {
    const gitRoot = tmpGitRoot();
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot,
      branch: 'main',
      sha: 'abc1234',
    });
    const path = restartStateFilePath(gitRoot);
    writeSelfUpdateRestartRecord(path, {
      instanceId: 'instance-1',
      hash: 'bbbbbbb',
      pid: 0,
      port: 3141,
      startedAt: '2026-08-09T12:00:00.000Z',
      status: 'pending',
    });
    writeFileSync(path, '{bad json');

    expect(
      await json(await createApp().request('/core-update/restart-status')),
    ).toEqual({ status: 'unavailable' });
  });

  test('builds, writes a pending restart-state record, and never claims the update itself succeeded (AC: stop returning unverified success)', async () => {
    const gitRoot = tmpGitRoot();
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot,
      branch: 'main',
      sha: 'abc1234',
    });
    vi.mocked(execGit).mockImplementation(async (args: string[]) => {
      if (args[0] === 'pull') return { stdout: '', stderr: '' } as never;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${SHA}\n`, stderr: '' } as never;
      }
      return { stdout: '', stderr: '' } as never;
    });
    spawnMock.mockReturnValue({ pid: 7777, unref: vi.fn() });

    const res = await createApp().request('/core-update', { method: 'POST' });
    const body = await json(res);

    expect(body.success).toBe(true);
    expect(body.restarting).toBe(true);
    expect(body.restart).toMatchObject({
      expectedHash: SHA.slice(0, 7),
      expectedInstanceId: 'default',
    });
    // The build succeeding and the restart being initiated are both true and
    // may be said plainly — but nothing here may claim the UPDATE (i.e. the
    // new server) succeeded; that is unknown until the watchdog verifies it.
    expect(body.message).not.toMatch(/^Updated to/);
    expect(body.message).toContain(SHA.slice(0, 7));

    // A durable pending record exists synchronously, before the 500ms
    // restart timer even fires — so a crash right here still leaves a trail.
    const record = readSelfUpdateRestartRecord(restartStateFilePath(gitRoot));
    expect(record).toMatchObject({
      status: 'pending',
      hash: SHA.slice(0, 7),
    });
  });

  test('keeps a committed pending update accepted and scheduled when its warning sink throws', async () => {
    const gitRoot = tmpGitRoot();
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot,
      branch: 'main',
      sha: 'abc1234',
    });
    vi.mocked(execGit).mockImplementation(async (args: string[]) => {
      if (args[0] === 'pull') return { stdout: '', stderr: '' } as never;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${SHA}\n`, stderr: '' } as never;
      }
      return { stdout: '', stderr: '' } as never;
    });
    const writer = vi.fn((path, record) => {
      writeSelfUpdateRestartRecord(path, record);
      return {
        committed: true as const,
        durability: 'uncertain' as const,
        warning: 'directory fsync interrupted',
      };
    });
    const logger = {
      // Only `warn` throws: this test is named for the WARNING sink, and the
      // route's other levels must stay ordinary so a failure here can only be
      // the warning path. `debug` is present because `createApp`'s stub now
      // carries every level the route calls.
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('log sink unavailable');
      }),
      error: vi.fn(),
    };

    const response = await createApp(logger, writer).request('/core-update', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect((await json(response)).restarting).toBe(true);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  test('the real restart timer, once it fires, spawns the child carrying the identity env the watchdog needs (end-to-end, AC: review finding 1)', async () => {
    const gitRoot = tmpGitRoot();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    try {
      vi.mocked(resolveInstallProvenance).mockReturnValue({
        installKind: 'source-checkout',
        gitRoot,
        branch: 'main',
        sha: 'abc1234',
      });
      vi.mocked(execGit).mockImplementation(async (args: string[]) => {
        if (args[0] === 'pull') return { stdout: '', stderr: '' } as never;
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: `${SHA}\n`, stderr: '' } as never;
        }
        return { stdout: '', stderr: '' } as never;
      });
      spawnMock.mockReturnValue({ pid: 8888, unref: vi.fn() });

      const res = await createApp().request('/core-update', { method: 'POST' });
      expect(res.status).toBe(200);

      await vi.advanceTimersByTimeAsync(500);

      expect(spawnMock).toHaveBeenCalled();
      const [, , childOpts] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env?: Record<string, string> },
      ];
      // The FULL sha (not the truncated display hash) must reach the
      // child's env, matching what /api/system/status's build.shortSha will
      // report — this is what lets the watchdog's identity check verify a
      // genuinely successful restart instead of forever mismatching.
      expect(childOpts.env?.STATION_BUILD_SHA).toBe(SHA);
      expect(childOpts.env?.STATION_INSTANCE_ID).toBe('default');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('an execFile build failure never schedules a restart or writes a restart-state record', async () => {
    const gitRoot = tmpGitRoot();
    vi.mocked(resolveInstallProvenance).mockReturnValue({
      installKind: 'source-checkout',
      gitRoot,
      branch: 'main',
      sha: 'abc1234',
    });
    vi.mocked(execGit).mockResolvedValue({ stdout: '', stderr: '' } as never);
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const optsOrCb = args[2];
      const cb = args[3] as
        | ((error: unknown, result: unknown) => void)
        | undefined;
      const callback =
        typeof optsOrCb === 'function'
          ? (optsOrCb as (error: unknown, result: unknown) => void)
          : cb;
      callback?.(new Error('build failed'), { stdout: '', stderr: '' });
    });

    const res = await createApp().request('/core-update', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.success).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(
      readSelfUpdateRestartRecord(restartStateFilePath(gitRoot)),
    ).toBeNull();
  });
});

describe('performGitPullRestart (station#1903)', () => {
  test('spawns the new server, then spawns a DETACHED watchdog carrying the health-check target, and exits', () => {
    const childHandle = { pid: 5555, unref: vi.fn() };
    const watchdogHandle = { pid: 6666, unref: vi.fn() };
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(childHandle)
      .mockReturnValueOnce(watchdogHandle);
    const exitFn = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.stubEnv('STATION_SUPERVISOR_PID', 'old-supervisor');

    performGitPullRestart({
      gitRoot: '/repo',
      port: '3141',
      newHash: 'def5678',
      newHashFull: 'def5678'.padEnd(40, '0'),
      instanceId: 'default',
      restartStatePath: '/repo/.station/self-update-restart.json',
      startedAt: '2026-08-02T03:28:43.483Z',
      moduleDir: '/repo/dist-server',
      logger,
      spawnFn,
      exitFn,
    });

    expect(spawnFn).toHaveBeenNthCalledWith(
      1,
      'node',
      ['dist-server/command-station.js'],
      expect.objectContaining({
        cwd: '/repo',
        detached: true,
        env: expect.objectContaining({
          // The new server must report ITS OWN identity via
          // /api/system/status — inheriting the parent's env unchanged
          // would leave it reporting the OLD build's sha/instanceId, and
          // the watchdog's identity check would never verify a genuinely
          // successful restart (archive#1903 review finding 1).
          STATION_BUILD_SHA: 'def5678'.padEnd(40, '0'),
          STATION_INSTANCE_ID: 'default',
        }),
      }),
    );
    expect(spawnFn.mock.calls[0][2].env).not.toHaveProperty(
      'STATION_SUPERVISOR_PID',
    );
    expect(childHandle.unref).toHaveBeenCalled();

    const [watchdogCmd, watchdogArgs, watchdogOpts] = spawnFn.mock.calls[1] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(watchdogCmd).toBe(process.execPath);
    expect(watchdogArgs[0]).toBe('/repo/dist-server/self-update-watchdog.js');
    expect(JSON.parse(watchdogArgs[1])).toMatchObject({
      pid: 5555,
      port: 3141,
      hash: 'def5678',
      instanceId: 'default',
      gitRoot: '/repo',
    });
    expect(watchdogOpts).toMatchObject({ cwd: '/repo', detached: true });
    expect(watchdogHandle.unref).toHaveBeenCalled();

    // The parent MUST still exit even though it can no longer verify
    // anything itself — exiting is what frees the port for the child.
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  test('a watchdog spawn failure is logged but the parent still exits (the port must still be freed)', () => {
    const childHandle = { pid: 5555, unref: vi.fn() };
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce(childHandle)
      .mockImplementationOnce(() => {
        throw new Error('ENOENT: self-update-watchdog.js not found');
      });
    const exitFn = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    performGitPullRestart({
      gitRoot: '/repo',
      port: '3141',
      newHash: 'def5678',
      newHashFull: 'def5678'.padEnd(40, '0'),
      instanceId: 'default',
      restartStatePath: '/repo/.station/self-update-restart.json',
      startedAt: '2026-08-02T03:28:43.483Z',
      moduleDir: '/repo/dist-server',
      logger,
      spawnFn,
      exitFn,
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('health-verification watchdog'),
      expect.anything(),
    );
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  test('no pid from the child spawn logs an error and still exits, spawning no watchdog', () => {
    const spawnFn = vi
      .fn()
      .mockReturnValueOnce({ pid: undefined, unref: vi.fn() });
    const exitFn = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    performGitPullRestart({
      gitRoot: '/repo',
      port: '3141',
      newHash: 'def5678',
      newHashFull: 'def5678'.padEnd(40, '0'),
      instanceId: 'default',
      restartStatePath: '/repo/.station/self-update-restart.json',
      startedAt: '2026-08-02T03:28:43.483Z',
      moduleDir: '/repo/dist-server',
      logger,
      spawnFn,
      exitFn,
    });

    expect(spawnFn).toHaveBeenCalledTimes(1); // only the child attempt
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no pid'),
    );
    expect(exitFn).toHaveBeenCalledWith(0);
  });
});
