import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Only `rename` is faked; every other filesystem call is the real one, so
// the replacement branch below runs exactly as it does in production.
const rename = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rename,
}));

import { persistedRandomIdentifierHash } from '../persisted-random-identifier.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  rename.mockReset();
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-persisted-id-'));
  roots.push(root);
  return root;
}

describe('persistedRandomIdentifierHash', () => {
  test('removes the replacement when the commit rename fails', async () => {
    // Reaching the replacement branch needs a destination that exists but
    // does not hold a UUID: the exclusive create then fails EEXIST and the
    // atomic replace is the remaining path. That replacement carries a fresh
    // UUID in its name, so a leaked one is never reused and never reaped --
    // on the boot that could not read its own identifier, which is the boot
    // most likely to repeat.
    const root = home();
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'analytics-id'), 'not-a-uuid\n', 'utf8');
    rename.mockRejectedValue(
      Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' }),
    );

    await expect(
      persistedRandomIdentifierHash(root, 'analytics-id'),
    ).rejects.toThrow(/rename/);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(
      readdirSync(configDir).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });
});
