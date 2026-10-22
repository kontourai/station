// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const fchmodShouldFail = vi.hoisted(() => ({ value: false }));
const openShouldFail = vi.hoisted(() => ({ value: false }));
const writeShouldFail = vi.hoisted(() => ({ value: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (openShouldFail.value) throw new Error('EACCES');
      return actual.openSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (writeShouldFail.value) throw new Error('EIO');
      return Reflect.apply(actual.writeSync, actual, args);
    },
    fchmodSync: (fd: number, mode: number) => {
      if (fchmodShouldFail.value) {
        throw new Error('EPERM');
      }
      return actual.fchmodSync(fd, mode);
    },
  };
});

const dirs: string[] = [];
const makeTempDir = trackTempDirs();

afterEach(async () => {
  fchmodShouldFail.value = false;
  writeShouldFail.value = false;
  openShouldFail.value = false;
  const { resetServerLogSinkForTests } = await import('../server-log-store.js');
  resetServerLogSinkForTests();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createServerLogStore — chmod failure does not write secrets', () => {
  it('closes the fd and writes no unredacted bytes when fchmodSync fails', async () => {
    if (process.platform === 'win32') return;
    const { createServerLogStore } = await import('../server-log-store.js');
    const directory = mkdtempSync(join(tmpdir(), 'station-log-store-chmod-'));
    dirs.push(directory);
    const today = new Date().toISOString().split('T')[0];
    const path = join(directory, `server-${today}.ndjson`);
    writeFileSync(path, '', { mode: 0o644 });

    fchmodShouldFail.value = true;
    const store = createServerLogStore({ directory });
    store.writeLine('{"msg":"secret-bearing"}');

    expect(
      readFileSync(path, 'utf8'),
      'unredacted secret written after chmod hardening failed',
    ).not.toContain('secret-bearing');
    expect(store.isOpen()).toBe(false);
  });
});

it('retains a buffered batch through a failed write and failed reopen', async () => {
  const { createServerLogStore } = await import('../server-log-store.js');
  const directory = makeTempDir('station-log-retry-');
  const store = createServerLogStore({ directory });
  try {
    store.writeLine('retained');
    writeShouldFail.value = true;
    store.flushSync();
    expect(store.isOpen()).toBe(false);
    writeShouldFail.value = false;
    openShouldFail.value = true;
    store.flushSync();
    expect(store.isOpen()).toBe(false);
    openShouldFail.value = false;
    store.flushSync();
    expect(
      readFileSync(
        join(
          directory,
          `server-${new Date().toISOString().split('T')[0]}.ndjson`,
        ),
        'utf8',
      ),
    ).toBe('retained\n');
  } finally {
    store.close();
  }
});
