import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../private-json-file.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../private-json-file.js')>();
  return {
    ...actual,
    readPrivateJsonFile: (
      ...args: Parameters<typeof actual.readPrivateJsonFile>
    ) => {
      reads.count += 1;
      return actual.readPrivateJsonFile(...args);
    },
  };
});

import { NativePushRegistrationStore } from '../native-push-registration-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('an unchanged file is not re-read: the publisher listener reads it on every lifecycle event', () => {
  const home = mkdtempSync(join(tmpdir(), 'station-native-push-cache-'));
  roots.push(home);
  mkdirSync(join(home, 'security'), { mode: 0o700 });
  const store = new NativePushRegistrationStore(home);
  store.upsert(
    'device-1',
    {
      token: `fcm-token-${'a'.repeat(40)}`,
      packageName: 'io.kontourai.station',
      platform: 'android',
    },
    'k'.repeat(43),
    1,
  );
  reads.count = 0;
  for (let i = 0; i < 20; i += 1) expect(store.list().size).toBe(1);
  expect(reads.count).toBe(0);
});
