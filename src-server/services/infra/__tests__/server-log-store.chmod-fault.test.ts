// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fchmodShouldFail = vi.hoisted(() => ({ value: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fchmodSync: (fd: number, mode: number) => {
      if (fchmodShouldFail.value) {
        throw new Error('EPERM');
      }
      return actual.fchmodSync(fd, mode);
    },
  };
});

const dirs: string[] = [];

afterEach(async () => {
  fchmodShouldFail.value = false;
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
