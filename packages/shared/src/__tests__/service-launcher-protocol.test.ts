import * as fs from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

// `existsSync` is wrapped so a test can model a request that another writer
// publishes after the up-front check has passed; `writeFileSync` so one can
// model a full disk.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

const {
  parseServiceUpdateRequest,
  readServiceUpdateProgress,
  ServiceUpdateAlreadyRequestedError,
  serviceUpdatePaths,
  writeJsonAtomically,
  writeServiceUpdateRequest,
} = await import('../service-launcher-protocol.js');

const makeTempDir = trackTempDirs();
const { writeFileSync: actualWriteFileSync } =
  await vi.importActual<typeof import('node:fs')>('node:fs');

describe('writeServiceUpdateRequest', () => {
  test('never replaces a request another writer published after the check', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const paths = serviceUpdatePaths(installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    const theirs = `${JSON.stringify({ id: 'theirs', requestedAt: 'x' })}\n`;
    writeFileSync(paths.request, theirs);
    // The up-front check misses it, as it would in the race.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    try {
      expect(() => writeServiceUpdateRequest(installRoot)).toThrow(
        ServiceUpdateAlreadyRequestedError,
      );
    } finally {
      vi.mocked(fs.existsSync).mockRestore();
    }
    expect(readFileSync(paths.request, 'utf8')).toBe(theirs);
    // And it leaves no temporary file behind.
    expect(fs.readdirSync(paths.runtime)).toEqual(['update-request.json']);
  });

  test('refuses a target that is not an exact version', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    expect(() => writeServiceUpdateRequest(installRoot, '../1.0.0')).toThrow(
      /Not an exact Station version/,
    );
  });
});

describe('staged writes on a full disk', () => {
  // A queued failure the code under test never consumed must not leak into
  // the next test.
  afterEach(() => {
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockImplementation(actualWriteFileSync);
  });
  /** The real write creates the file empty, then the disk refuses the bytes. */
  function failNextPathWrite() {
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      fs.closeSync(fs.openSync(file as string, 'wx'));
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    });
  }

  test('a failed update request write leaves no temporary file', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const paths = serviceUpdatePaths(installRoot);
    failNextPathWrite();
    expect(() => writeServiceUpdateRequest(installRoot)).toThrow(/ENOSPC/);
    expect(fs.readdirSync(paths.runtime)).toEqual([]);
  });

  test('a failed atomic JSON write leaves no temporary file', () => {
    const dir = makeTempDir('station-launcher-protocol-');
    failNextPathWrite();
    expect(() => writeJsonAtomically(join(dir, 'state.json'), {})).toThrow(
      /ENOSPC/,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('a failed rename leaves no temporary file', () => {
    const dir = makeTempDir('station-launcher-protocol-');
    // A non-empty directory where the file should go refuses the rename.
    const target = join(dir, 'state.json');
    mkdirSync(join(target, 'occupied'), { recursive: true });
    expect(() => writeJsonAtomically(target, {})).toThrow();
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });
});

describe('stage and apply in the runtime files (#3851)', () => {
  const REQUEST = '00000000-0000-4000-8000-000000000001';
  function stagedInstall(version = '1.1.0') {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const paths = serviceUpdatePaths(installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    const dir = join(installRoot, 'versions', version);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'station.mjs'), '');
    writeFileSync(join(dir, '.station-install-complete'), 'abc\n');
    writeFileSync(
      paths.result,
      JSON.stringify({
        requestId: REQUEST,
        status: 'staged',
        version,
        at: '2026-10-19T10:00:00.000Z',
      }),
    );
    return { installRoot, paths, dir };
  }

  test('a staged version reads as staged', () => {
    const { installRoot } = stagedInstall();
    expect(readServiceUpdateProgress(installRoot)).toEqual({
      state: 'staged',
      requestId: REQUEST,
      version: '1.1.0',
      stagedAt: '2026-10-19T10:00:00.000Z',
    });
  });

  test('staged is a fact about the disk: a removed version is not staged', () => {
    const { installRoot, dir } = stagedInstall();
    fs.rmSync(join(dir, '.station-install-complete'));
    expect(readServiceUpdateProgress(installRoot)).toEqual({ state: 'idle' });
  });

  test('the version the service now runs is not staged', () => {
    const { installRoot, paths } = stagedInstall();
    writeFileSync(
      paths.state,
      JSON.stringify({ protocol: 1, activeVersion: '1.1.0' }),
    );
    expect(readServiceUpdateProgress(installRoot)).toEqual({ state: 'idle' });
  });

  test('queued and staging requests carry their intent; a request without a mode is an update', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const stage = writeServiceUpdateRequest(installRoot, undefined, {
      mode: 'stage',
    });
    expect(readServiceUpdateProgress(installRoot)).toEqual({
      state: 'queued',
      requestId: stage.id,
      intent: 'stage',
    });
    const paths = serviceUpdatePaths(installRoot);
    fs.rmSync(paths.request);
    writeServiceUpdateRequest(installRoot);
    expect(readServiceUpdateProgress(installRoot)).toMatchObject({
      state: 'queued',
      intent: 'update',
    });
  });

  test('stage progress belongs to its request and never exceeds the signed size', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const request = writeServiceUpdateRequest(installRoot, undefined, {
      mode: 'stage',
    });
    const paths = serviceUpdatePaths(installRoot);
    fs.renameSync(paths.request, paths.processing);
    const progress = (value: object) =>
      writeFileSync(paths.stageProgress, JSON.stringify(value));
    progress({
      requestId: request.id,
      phase: 'downloading',
      downloadedBytes: 5000,
      totalBytes: 1000,
      at: 'x',
    });
    expect(readServiceUpdateProgress(installRoot)).toMatchObject({
      stagePhase: 'downloading',
      downloadedBytes: 1000,
      totalBytes: 1000,
    });
    // Another request's record says nothing about this one.
    progress({ requestId: REQUEST, phase: 'verifying', at: 'x' });
    expect(readServiceUpdateProgress(installRoot)).toEqual({
      state: 'staging',
      requestId: request.id,
      intent: 'stage',
    });
  });

  test('refuses an apply without a version and an unknown mode', () => {
    const base = { id: REQUEST, requestedAt: 'x' };
    expect(
      parseServiceUpdateRequest(JSON.stringify({ ...base, mode: 'apply' })),
    ).toBeNull();
    expect(
      parseServiceUpdateRequest(JSON.stringify({ ...base, mode: 'later' })),
    ).toBeNull();
    expect(
      parseServiceUpdateRequest(
        JSON.stringify({ ...base, mode: 'apply', targetVersion: '1.1.0' }),
      ),
    ).toMatchObject({ mode: 'apply' });
  });
});

describe('staged after an earlier committed update (#3851 review F1)', () => {
  const STAGE_REQUEST = '00000000-0000-4000-8000-000000000002';
  /** service-state.json as station-launcher.mjs `onPrepared` persists it. */
  function committedInstall(finishedAt: string) {
    const installRoot = makeTempDir('station-launcher-protocol-');
    const paths = serviceUpdatePaths(installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(
      paths.state,
      `${JSON.stringify(
        {
          protocol: 1,
          activeVersion: '1.1.0',
          update: {
            id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            fromVersion: '1.0.0',
            targetVersion: '1.1.0',
            requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            status: 'committed',
            attempts: 1,
            finishedAt,
          },
        },
        null,
        2,
      )}\n`,
    );
    const dir = join(installRoot, 'versions', '1.2.0');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'station.mjs'), '');
    writeFileSync(join(dir, '.station-install-complete'), 'abc\n');
    const stage = (at: string) =>
      writeFileSync(
        paths.result,
        JSON.stringify({
          requestId: STAGE_REQUEST,
          status: 'staged',
          version: '1.2.0',
          at,
        }),
      );
    return { installRoot, stage };
  }

  test('a stage made after the launcher committed an update reads staged', () => {
    const { installRoot, stage } = committedInstall('2026-10-18T10:00:00.000Z');
    stage('2026-10-19T10:00:00.000Z');
    expect(readServiceUpdateProgress(installRoot)).toMatchObject({
      state: 'staged',
      version: '1.2.0',
    });
  });

  test('a stage older than the committed update reads committed', () => {
    const { installRoot, stage } = committedInstall('2026-10-19T12:00:00.000Z');
    stage('2026-10-19T10:00:00.000Z');
    expect(readServiceUpdateProgress(installRoot)).toMatchObject({
      state: 'committed',
      targetVersion: '1.1.0',
    });
  });

  test('a reader older than #3851 does not see a download under way (review F13)', () => {
    const installRoot = makeTempDir('station-launcher-protocol-');
    writeServiceUpdateRequest(installRoot, '1.2.0', { mode: 'stage' });
    expect(
      readServiceUpdateProgress(installRoot, { includeStaged: false }),
    ).toEqual({ state: 'idle' });
    const paths = serviceUpdatePaths(installRoot);
    fs.rmSync(paths.request);
    const update = writeServiceUpdateRequest(installRoot);
    expect(
      readServiceUpdateProgress(installRoot, { includeStaged: false }),
    ).toMatchObject({ state: 'queued', requestId: update.id });
  });
});
