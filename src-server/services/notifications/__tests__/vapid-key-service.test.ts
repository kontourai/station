import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VapidKeyService } from '../vapid-key-service.js';

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-vapid-keys-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('VapidKeyService', () => {
  test('generates a keypair on first use and persists it atomically at 0600', () => {
    const homeDir = makeHome();
    const service = new VapidKeyService(homeDir);

    const keys = service.loadOrCreate();
    expect(keys.publicKey.length).toBeGreaterThan(0);
    expect(keys.privateKey.length).toBeGreaterThan(0);

    const keysPath = join(homeDir, 'security', 'vapid-keys.json');
    const persisted = JSON.parse(readFileSync(keysPath, 'utf8'));
    expect(persisted).toEqual({
      schemaVersion: 1,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
    if (process.platform !== 'win32') {
      expect(statSync(keysPath).mode & 0o777).toBe(0o600);
    }
  });

  test('loads the same persisted keypair on a fresh instance rather than regenerating', () => {
    const homeDir = makeHome();
    const first = new VapidKeyService(homeDir).loadOrCreate();
    const second = new VapidKeyService(homeDir).loadOrCreate();

    expect(second).toEqual(first);
  });

  test('caches the in-memory result rather than re-reading the file on every call', () => {
    const homeDir = makeHome();
    const service = new VapidKeyService(homeDir);
    const first = service.loadOrCreate();

    const keysPath = join(homeDir, 'security', 'vapid-keys.json');
    writeFileSync(
      keysPath,
      `${JSON.stringify({ schemaVersion: 1, publicKey: 'x'.repeat(87), privateKey: 'y'.repeat(43) })}\n`,
      { mode: 0o600 },
    );

    expect(service.loadOrCreate()).toEqual(first);
  });

  test('refuses a corrupt or invalid-shape persisted key file', () => {
    const homeDir = makeHome();
    // Prime the security directory the same way loadOrCreate would.
    new VapidKeyService(homeDir).loadOrCreate();
    const keysPath = join(homeDir, 'security', 'vapid-keys.json');
    writeFileSync(keysPath, `${JSON.stringify({ schemaVersion: 1 })}\n`, {
      mode: 0o600,
    });

    expect(() => new VapidKeyService(homeDir).loadOrCreate()).toThrow(
      /Invalid VAPID key record/,
    );
  });
});
