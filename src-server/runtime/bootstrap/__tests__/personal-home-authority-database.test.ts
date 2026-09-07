import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createPersonalHomeAuthorityDatabase } from '../personal-home-authority-database.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-authority-path-'));
  roots.push(root);
  const home = join(root, 'home');
  const external = join(root, 'external');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(external, { mode: 0o700 });
  return { root, home, external };
}
test('unset configuration opens nothing', () => {
  expect(
    createPersonalHomeAuthorityDatabase('/not-read', undefined),
  ).toBeUndefined();
});
test.skipIf(process.platform === 'win32')(
  'external store persists through separate connections with durable journaling',
  () => {
    const f = fixture();
    const open = createPersonalHomeAuthorityDatabase(
      f.home,
      join(f.external, 'authority.sqlite'),
    )!;
    const first = open();
    first.exec(
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('retained')",
    );
    first.close();
    const second = open();
    try {
      expect(second.prepare('SELECT value FROM evidence').get()).toMatchObject({
        value: 'retained',
      });
      expect(second.prepare('PRAGMA synchronous').get()).toMatchObject({
        synchronous: 2,
      });
    } finally {
      second.close();
    }
  },
);
test.skipIf(process.platform === 'win32')(
  'a portable home and its symlink aliases cannot contain the authority database',
  () => {
    const f = fixture();
    expect(() =>
      createPersonalHomeAuthorityDatabase(
        f.home,
        join(f.home, 'authority.sqlite'),
      ),
    ).toThrow();
    const alias = join(f.root, 'alias');
    symlinkSync(f.home, alias);
    expect(() =>
      createPersonalHomeAuthorityDatabase(
        f.home,
        join(alias, 'authority.sqlite'),
      ),
    ).toThrow();
  },
);
test.skipIf(process.platform === 'win32')(
  'unsafe permissions or a substituted database link fail closed',
  () => {
    const f = fixture();
    const location = join(f.external, 'authority.sqlite');
    const open = createPersonalHomeAuthorityDatabase(f.home, location)!;
    chmodSync(f.external, 0o755);
    expect(open).toThrow();
    chmodSync(f.external, 0o700);
    symlinkSync(join(f.home, 'copied.sqlite'), location);
    expect(open).toThrow();
  },
);

test.skipIf(process.platform === 'win32').each(['-wal', '-shm', '-journal'])(
  'linked SQLite %s sidecars are refused before opening',
  (suffix) => {
    const f = fixture();
    const path = join(f.external, 'authority.sqlite');
    const open = createPersonalHomeAuthorityDatabase(f.home, path)!;
    symlinkSync(join(f.home, 'copied-sidecar'), path + suffix);
    expect(open).toThrow();
  },
);
