import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { countBareMounts } from '../lazy-boundary-ratchet.mjs';

describe('lazy-boundary ratchet source matching', () => {
  const count = (source: string) =>
    countBareMounts(['surface.tsx'], () => source).reduce(
      (total, occurrence) => total + occurrence.count,
      0,
    );

  test.each([
    '<Suspense fallback={null}><LazySurface /></Suspense>',
    '<Suspense key={block.key} fallback={null}><LazySurface /></Suspense>',
    `<Suspense
       key={block.key}
       fallback = { null }
     ><LazySurface /></Suspense>`,
    '<Suspense fallback={null} key={block.key}><LazySurface /></Suspense>',
  ])('detects a null fallback regardless of attribute layout: %s', (source) => {
    expect(count(source)).toBe(1);
  });

  test('does not classify an explicit pending surface as bare', () => {
    expect(
      count(
        '<Suspense key={block.key} fallback={<Loading />}><LazySurface /></Suspense>',
      ),
    ).toBe(0);
  });
});

test('the gate accepts this repository as a real child process', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/lazy-boundary-ratchet.mjs'],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 30_000);
