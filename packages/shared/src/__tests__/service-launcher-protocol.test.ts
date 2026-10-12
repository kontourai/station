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
