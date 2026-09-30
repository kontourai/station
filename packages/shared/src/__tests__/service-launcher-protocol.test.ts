import * as fs from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

// Only `existsSync` is wrapped, so a test can model a request that another
// writer publishes after the up-front check has passed.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const {
  ServiceUpdateAlreadyRequestedError,
  serviceUpdatePaths,
  writeServiceUpdateRequest,
} = await import('../service-launcher-protocol.js');

const makeTempDir = trackTempDirs();

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
