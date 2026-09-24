import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PushSigningKeyStore } from '../push-signing-key-store.js';

const STATION = '11111111-1111-4111-8111-111111111111';
const OTHER_STATION = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(stationId = STATION) {
  const home = mkdtempSync(join(tmpdir(), 'station-push-key-'));
  roots.push(home);
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  let current = stationId;
  const store = new PushSigningKeyStore(home, () => current);
  return {
    home,
    store,
    path: join(home, 'security', 'push-signing-key.json'),
    setStation: (next: string) => {
      current = next;
    },
  };
}

const posix = process.platform !== 'win32';

describe('PushSigningKeyStore', () => {
  test('creates nothing until asked, then one private key that every reopen reuses', async () => {
    const { home, store, path } = fixture();
    expect(store.read()).toBeNull();
    expect(existsSync(path)).toBe(false);

    const other = new PushSigningKeyStore(home, () => STATION);
    const [first, second] = await Promise.all([
      store.loadOrCreate(),
      other.loadOrCreate(),
    ]);
    expect(first.thumbprint).toBe(second.thumbprint);
    expect(
      new PushSigningKeyStore(home, () => STATION).read()?.thumbprint,
    ).toBe(first.thumbprint);
    expect((await store.loadOrCreate()).thumbprint).toBe(first.thumbprint);
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);

    // The public projection carries no private material.
    const projected = JSON.stringify(first);
    expect(projected).not.toContain('PRIVATE KEY');
    expect(Object.keys(first.publicJwk).sort()).toEqual([
      'crv',
      'kty',
      'x',
      'y',
    ]);
    expect(readFileSync(path, 'utf8')).toContain('PRIVATE KEY');
  });

  test('is domain-separated from the connection signing key file', async () => {
    const { home, store } = fixture();
    await store.loadOrCreate();
    expect(
      existsSync(join(home, 'security', 'connection-signing-key.json')),
    ).toBe(false);
  });

  test('refuses a corrupt file instead of replacing it', async () => {
    const { store, path } = fixture();
    writeFileSync(path, '{ not json', { mode: 0o600 });
    expect(() => store.read()).toThrow('key_store_invalid');
    await expect(store.loadOrCreate()).rejects.toThrow('key_store_invalid');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });

  test('refuses an oversized file', async () => {
    const { store, path } = fixture();
    await store.loadOrCreate();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(record) + ' '.repeat(5000), {
      mode: 0o600,
    });
    expect(() => store.read()).toThrow('key_store_invalid');
  });

  test('refuses a record with unknown fields', async () => {
    const { store, path } = fixture();
    await store.loadOrCreate();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...record, extra: true }), {
      mode: 0o600,
    });
    expect(() => store.read()).toThrow('key_store_invalid');
  });

  test.runIf(posix)('refuses a loosely permissioned file', async () => {
    const { store, path } = fixture();
    await store.loadOrCreate();
    chmodSync(path, 0o644);
    expect(() => store.read()).toThrow('key_store_invalid');
  });

  test.runIf(posix)('refuses a symlinked file', async () => {
    const { home, store, path } = fixture();
    const real = join(home, 'elsewhere.json');
    const source = fixture();
    await source.store.loadOrCreate();
    writeFileSync(real, readFileSync(source.path), { mode: 0o600 });
    symlinkSync(real, path);
    expect(() => store.read()).toThrow('key_store_invalid');
  });

  test("never signs with another environment's key and replaces it on the next registration", async () => {
    const { store, setStation } = fixture();
    const original = await store.loadOrCreate();
    setStation(OTHER_STATION);
    expect(store.read()).toBeNull();
    const replaced = await store.loadOrCreate();
    expect(replaced.thumbprint).not.toBe(original.thumbprint);
    expect(store.read()?.thumbprint).toBe(replaced.thumbprint);
  });
});
