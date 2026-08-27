import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveWorkspacePackageRoot } from '../build.js';

// `resolveWorkspacePackageRoot`'s bundled-candidate fallback is derived from
// `build.ts`'s OWN real on-disk location (`sharedDirectory`, computed via
// `import.meta.url`), not from anything a caller passes in — so the only way
// to exercise both on-disk shapes deterministically (rather than depending on
// what happens to exist in this checkout, per the code-review MEDIUM finding
// this test resolves) is to mock `node:fs`'s `existsSync` directly, same
// pattern `plugins.routes.test.ts` already uses for its own filesystem-shape
// coverage.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

// Mirrors `build.ts`'s own `sharedDirectory` computation exactly, so this test
// asserts against the SAME bundled-candidate path the real function computes.
const sharedDirectory = fileURLToPath(new URL('../', import.meta.url));

describe('resolveWorkspacePackageRoot', () => {
  const mockExistsSync = vi.mocked(existsSync);

  afterEach(() => {
    mockExistsSync.mockReset();
  });

  test('shape (a): resolves the dev/source candidate when its src/index.ts is present', () => {
    const devCandidate = '/workspace/packages/sdk';
    mockExistsSync.mockImplementation(
      (p) => p === `${devCandidate}/src/index.ts`,
    );

    expect(resolveWorkspacePackageRoot('sdk', devCandidate)).toBe(devCandidate);
  });

  test('shape (b): falls back to the bundled-server candidate (a sibling packages/<name> hop from this module) when the dev candidate is absent', () => {
    const devCandidate = '/workspace/packages/sdk';
    const bundledCandidate = resolve(sharedDirectory, '..', 'packages', 'sdk');
    mockExistsSync.mockImplementation(
      (p) => p === `${bundledCandidate}/src/index.ts`,
    );

    expect(resolveWorkspacePackageRoot('sdk', devCandidate)).toBe(
      bundledCandidate,
    );
  });

  test('returns null when neither the dev nor the bundled shape resolves (package genuinely absent)', () => {
    mockExistsSync.mockReturnValue(false);

    expect(
      resolveWorkspacePackageRoot('sdk', '/workspace/packages/sdk'),
    ).toBeNull();
  });
});
