import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  systemOps: { add: vi.fn() },
}));
// The contract under test is the unknown-provenance path, which must return
// BEFORE any git or network call. This mock makes an accidental reach into
// the apply/compare path fail fast and loudly instead of touching the
// network (the real `fetchChannelLatestSha` stays wired for that reason).
vi.mock('../../../utils/git-exec.js', () => ({
  execGit: vi
    .fn()
    .mockRejectedValue(new Error('execGit must not run in this contract test')),
}));

/**
 * The route resolves provenance from its own module directory. This seam
 * swaps ONLY the directory the REAL resolver walks: the resolver's actual
 * classification logic (stamp walk, shape validation, reason minting) runs
 * unmocked against temporary resource layouts, so a reason-code regression
 * cannot hide behind a canned mock return.
 */
let moduleDirOverride: string | null = null;
vi.mock('../install-provenance.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../install-provenance.js')>();
  return {
    ...actual,
    resolveInstallProvenance: (
      moduleDir: string,
      opts?: Parameters<typeof actual.resolveInstallProvenance>[1],
    ) =>
      actual.resolveInstallProvenance(
        moduleDirOverride ?? moduleDir,
        opts ?? {
          // Injected (same discipline as install-provenance.test.ts): the
          // real default would fall back to process.cwd() — this test run's
          // own git checkout — and the walk under test would never run.
          resolveGit: () => {
            throw new Error('Not a git repository');
          },
        },
      ),
  };
});

const { createSystemUpdateRoutes } = await import('../system-update-routes.js');
const { writeNightlySourceStamp } = await import(
  '../../../../ops/nightly/macos-source-stamp.mjs'
);

const SHA = 'a'.repeat(40);

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createApp() {
  return createSystemUpdateRoutes(
    { getAppConfig: () => ({}), eventBus: { emit: vi.fn() } } as never,
    logger,
  );
}

let roots: string[] = [];
function bundleLayout(): {
  root: string;
  serverDir: string;
  resourcesDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'update-provenance-'));
  roots.push(root);
  const resourcesDir = join(root, 'Resources');
  const serverDir = join(resourcesDir, 'dist-server');
  // The bundle layout the resolver walks: <root>/Resources/dist-server.
  mkdirSync(serverDir, { recursive: true });
  return { root, serverDir, resourcesDir };
}

/** Write a stamp with the PRODUCTION writer, then corrupt exactly one field. */
function writeCorruptedStamp(resourcesDir: string): void {
  const stampPath = join(resourcesDir, 'station-nightly-source.json');
  writeNightlySourceStamp(stampPath, {
    sha: SHA,
    createdAt: '2026-09-01T00:00:00.000Z',
    originUrl: 'https://github.com/kontourai/station.git',
  });
  const stamp = JSON.parse(readFileSync(stampPath, 'utf-8')) as Record<
    string,
    unknown
  >;
  stamp.sha = 'corrupted-not-a-sha';
  writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
}

beforeEach(() => {
  // The identity diagnostics are pinned by the route test; scrub the env so
  // a developer's ambient STATION_* values cannot leak in here.
  for (const key of [
    'STATION_BUILD_SHA',
    'STATION_BUILD_BRANCH',
    'STATION_BUILD_BUILT_AT',
    'STATION_INSTANCE_ID',
    'STATION_BOOT_ID',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  moduleDirOverride = null;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('core-update provenance contract (resolver reason → route rendering)', () => {
  test('a stampless layout resolves through the real resolver to provenanceIssue "missing"', async () => {
    const { serverDir } = bundleLayout();
    moduleDirOverride = serverDir;
    const body = await json(await createApp().request('/core-update'));

    expect(body.updateAvailable).toBe(false);
    // Neither unknown flavor reaches the apply path: no applyMethod, no
    // error, no git call (the execGit mock above would have thrown).
    expect(body.applyMethod).toBeUndefined();
    expect(body.error).toBeUndefined();
    expect(body.provenanceIssue).toBe('missing');
    expect(body.message).toMatch(
      /^This install carries no update provenance \(/,
    );
    expect(body.technicalDetail).toContain('station-nightly-source.json');
  });

  test('a corrupted production stamp resolves to provenanceIssue "invalid-stamp", a DIFFERENT reason', async () => {
    const { resourcesDir, serverDir } = bundleLayout();
    writeCorruptedStamp(resourcesDir);
    moduleDirOverride = serverDir;

    const body = await json(await createApp().request('/core-update'));

    expect(body.updateAvailable).toBe(false);
    expect(body.applyMethod).toBeUndefined();
    expect(body.error).toBeUndefined();
    // The discriminating assertion: the SAME "unknown install" bucket, a
    // DIFFERENT machine-readable reason — the whole point of the typed
    // reason field.
    expect(body.provenanceIssue).toBe('invalid-stamp');
    expect(body.message).toMatch(
      /^This server's update provenance is invalid\./,
    );
    expect(body.message).toContain('updates cannot be checked from here');
    expect(body.technicalDetail).toContain('malformed');
  });

  test('missing and invalid render different user-facing reasons from the same unknown bucket', async () => {
    const missingLayout = bundleLayout();
    moduleDirOverride = missingLayout.serverDir;
    const missing = await json(await createApp().request('/core-update'));

    const invalidLayout = bundleLayout();
    writeCorruptedStamp(invalidLayout.resourcesDir);
    moduleDirOverride = invalidLayout.serverDir;
    const invalid = await json(await createApp().request('/core-update'));

    expect(missing.provenanceIssue).toBe('missing');
    expect(invalid.provenanceIssue).toBe('invalid-stamp');
    expect(missing.message).not.toBe(invalid.message);
    // Both refuse the check identically on the facts that matter for state:
    // no update claim, nothing to apply, nothing that throws.
    expect(invalid.updateAvailable).toBe(false);
    expect(invalid.applyMethod).toBeUndefined();
    expect(missing.updateAvailable).toBe(false);
    expect(missing.applyMethod).toBeUndefined();
  });
});
