import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import {
  computePluginContentDigest,
  computePluginContentDigestAsync,
} from '../plugin-content-integrity.js';

// File-scoped observation counts real payload reads without changing their results.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-digest-batch-')),
  );
  roots.push(root);
  mkdirSync(join(root, 'demo'));
  return root;
}

test('concurrent requests collected before a scan read its file payload once', async () => {
  const root = fixture();
  const payload = join(root, 'demo', 'server.mjs');
  writeFileSync(payload, 'export const value = 1;');
  const values = await Promise.all([
    computePluginContentDigestAsync(root, 'demo'),
    computePluginContentDigestAsync(root, 'demo'),
  ]);
  expect(values[0]).toMatch(/^sha256:/);
  expect(values[1]).toBe(values[0]);
  expect(
    vi.mocked(readFileSync).mock.calls.filter(([path]) => path === payload),
  ).toHaveLength(1);
});

test('a request arriving after a scan starts cannot inherit its older bytes', async () => {
  const root = fixture();
  for (let index = 0; index < 256; index++)
    writeFileSync(
      join(root, 'demo', `${String(index).padStart(4, '0')}.txt`),
      'before',
    );
  const expectedBefore = computePluginContentDigest(root, 'demo');
  vi.mocked(readFileSync).mockClear();
  let firstFinished = false;
  let started!: () => void;
  const scanning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const actualRead = vi.mocked(readFileSync).getMockImplementation()!;
  vi.mocked(readFileSync).mockImplementationOnce((...args) => {
    const bytes = Reflect.apply(actualRead, undefined, args);
    started();
    return bytes;
  });
  const first = computePluginContentDigestAsync(root, 'demo');
  void first.then(() => {
    firstFinished = true;
  });
  await scanning;
  const changed = join(root, 'demo', '0000.txt');
  expect(
    vi.mocked(readFileSync).mock.calls.some(([path]) => path === changed),
  ).toBe(true);
  expect(firstFinished).toBe(false);
  writeFileSync(changed, 'after');
  const second = computePluginContentDigestAsync(root, 'demo');
  await setImmediate();
  const third = computePluginContentDigestAsync(root, 'demo');
  const [oldObservation, newObservation, latestObservation] = await Promise.all(
    [first, second, third],
  );
  expect(latestObservation).toBe(newObservation);
  expect(
    vi.mocked(readFileSync).mock.calls.filter(([path]) => path === changed),
  ).toHaveLength(2);
  expect(oldObservation).toBe(expectedBefore);
  expect(newObservation).not.toBe(oldObservation);
  expect(newObservation).toBe(computePluginContentDigest(root, 'demo'));
});
