import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { clean, homeReset } from '../commands/lifecycle.js';

const roots: string[] = [];

function sharedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-lifecycle-shared-root-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('lifecycle runtime-home admission', () => {
  test('refuses clean and reset before they can delete or archive shared metadata', async () => {
    const root = sharedRoot();
    const previousRoot = process.env.STATION_ROOT;
    process.env.STATION_ROOT = root;
    try {
      await expect(
        clean({
          projectHome: root,
          force: true,
          allowDefaultHomeClean: true,
        }),
      ).rejects.toThrow(/not admissible/);
      expect(() => homeReset({ projectHome: root, confirm: true })).toThrow(
        /not admissible/,
      );
      expect(readdirSync(root)).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previousRoot;
    }
  });
});
