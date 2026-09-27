import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';

// The containment check reads the root with realpathSync. A sibling writer's
// mkdir(root, { recursive: true }) can land between a first failed read and
// the existence check that follows it (#2596). These tests make that race
// deterministic by failing chosen realpathSync calls.
const failures = vi.hoisted(() => ({
  path: '' as string,
  remaining: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = ((path: Parameters<typeof actual.realpathSync>[0]) => {
    if (failures.remaining > 0 && String(path) === failures.path) {
      failures.remaining -= 1;
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
        code: 'ENOENT',
      });
    }
    return actual.realpathSync(path);
  }) as typeof actual.realpathSync;
  return { ...actual, realpathSync };
});

const { isDirectoryPhysicallyWithin } = await import('../skill-paths.js');

const makeTempDir = trackTempDirs();

describe('directory containment under a concurrent root create (#2596)', () => {
  let root: string;
  beforeEach(() => {
    root = join(makeTempDir('skill-paths-race-'), 'skills');
    mkdirSync(root);
  });

  test('a root that appeared between the first read and the existence check is resolved, not refused', () => {
    failures.path = root;
    failures.remaining = 1;
    expect(isDirectoryPhysicallyWithin(root, join(root, 'new-skill'))).toBe(
      true,
    );
    expect(failures.remaining).toBe(0);
  });

  test('a root that exists but still cannot be read is refused', () => {
    failures.path = root;
    failures.remaining = 2;
    expect(isDirectoryPhysicallyWithin(root, join(root, 'new-skill'))).toBe(
      false,
    );
  });
});
