import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

// Only fd writes are wrapped, so a test can make the launcher's staged
// write fail the way a full disk does: the file already exists, empty.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const { recordServiceActiveVersion } = (await import(
  '../../packaging/portable-server/bin/station-launcher.mjs'
)) as {
  recordServiceActiveVersion: (installRoot: string, version: string) => void;
};

const makeTempDir = trackTempDirs();

function noSpace(): never {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
  });
}

afterEach(() => {
  vi.mocked(fs.writeFileSync).mockRestore();
});

describe('launcher staged writes on a full disk', () => {
  test.each([
    ['the lock record', 1],
    ['the service state', 2],
  ])(
    'a failed write of %s leaves no staging file behind',
    async (_label, nth) => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let fdWrites = 0;
      vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
        if (typeof file === 'number' && ++fdWrites === nth) noSpace();
        return actual.writeFileSync(file, data, options);
      });
      const installRoot = makeTempDir('station-launcher-staged-write-');
      expect(() => recordServiceActiveVersion(installRoot, '1.0.0')).toThrow(
        /ENOSPC/,
      );
      expect(fdWrites).toBeGreaterThanOrEqual(nth);
      const runtime = join(installRoot, 'runtime');
      // Only the lock itself may be left by a failure after it was taken, and
      // the release removes that too; nothing staged survives.
      expect(
        fs.readdirSync(runtime).filter((name) => name !== 'service-state.lock'),
      ).toEqual([]);
      // The lock is not stranded: the next attempt succeeds.
      vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
      recordServiceActiveVersion(installRoot, '1.0.0');
      expect(fs.readdirSync(runtime).sort()).toEqual(['service-state.json']);
    },
  );
});
