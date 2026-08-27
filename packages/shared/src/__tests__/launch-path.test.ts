import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { sanitizePath } from '../launch-path.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('service launch PATH sanitizer', () => {
  test('rejects a safe leaf beneath a writable non-sticky ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-launch-path-test-'));
    roots.push(root);
    const writableAncestor = join(root, 'writable');
    const leaf = join(writableAncestor, 'bin');
    mkdirSync(leaf, { recursive: true, mode: 0o700 });
    chmodSync(writableAncestor, 0o770);
    chmodSync(leaf, 0o700);

    expect(sanitizePath(leaf)).toEqual({
      accepted: [],
      rejected: [{ entry: leaf, reason: 'group-writable' }],
    });
  });
});
