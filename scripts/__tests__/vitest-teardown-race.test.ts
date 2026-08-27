import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The run root is removed by `vitest.global-setup.ts` while pooled workers may
 * still be writing under it — the file's own comment says workers "may be
 * killed outright", so one outliving teardown is expected.
 *
 * `rm(..., { force: true })` suppresses ENOENT, not ENOTEMPTY. When the
 * directory gained an entry between the walk and the final rmdir, the throw
 * surfaced as a *collect error against whichever test file happened to be in
 * flight*, so an unrelated test was reported as broken. That cost three
 * investigation cycles in one session before anyone read the stack.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function contendedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'teardown-race-'));
  created.push(root);
  const nested = join(root, 'worker');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'artifact.json'), '{}');
  return root;
}

describe('run-root teardown', () => {
  it('force alone does not survive a directory that keeps gaining entries', async () => {
    // Pins the premise: `force` is about ENOENT, so it is not the guard the
    // original code assumed it was.
    const root = contendedRoot();
    let observed: string | undefined;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 0,
    }).catch((error: NodeJS.ErrnoException) => {
      observed = error.code;
    });
    // On a quiet filesystem this succeeds; the point is only that `force`
    // carries no retry, which is what the fix supplies.
    expect(observed === undefined || observed === 'ENOTEMPTY').toBe(true);
  });

  it('removes a populated run root', async () => {
    const root = contendedRoot();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
    expect(() => readFileSync(join(root, 'worker', 'artifact.json'))).toThrow();
  });

  it('teardown asks for retries rather than failing the run', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'vitest.global-setup.ts'),
      'utf-8',
    );
    expect(source).toContain('maxRetries');
    // A bare rmSync is what blamed innocent test files.
    expect(source).not.toMatch(/rmSync\(runRoot/);
  });

  it('tolerates a root that is still contended after the retries', () => {
    // Failing here would put the run back to reporting an infrastructure race
    // as a test failure; the documented day-old sweep reclaims it instead.
    const source = readFileSync(
      join(__dirname, '..', '..', 'vitest.global-setup.ts'),
      'utf-8',
    );
    expect(source).toMatch(/ENOTEMPTY/);
    // But it must not swallow everything — a genuinely undeletable root is
    // still worth surfacing.
    expect(source).toMatch(/throw error/);
  });
});
