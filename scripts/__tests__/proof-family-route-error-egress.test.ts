import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';

// End to end: a violating source in a checkout must make the real
// repo-governance lane CLI block. The lane resolves its root from its own
// location, so it runs from a temporary copy of the tracked tree. Directories
// no governance check reads are left out to keep the copy small; if a check
// starts reading one, the clean control below fails first.
const repoRoot = resolve(import.meta.dirname, '../..');
const OMITTED_TOP_LEVEL = ['src-ui', 'packages', 'tests', 'examples'];
const VOICE_SESSION = 'src-server/voice/voice-session.ts';
const EXPECTED_BLOCK =
  '- repo-governance: Raw outward or durable error coercion: src-server/voice/voice-session.ts :: route ON error :: String(failure).';

const makeTempDir = trackTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
});

function copyTrackedTree() {
  // Resolved so the lane runs from a canonical path; macOS tmpdir() is a
  // symlink into /private.
  const root = realpathSync(makeTempDir('proof-family-e2e-'));
  // Hooks export GIT_DIR, GIT_INDEX_FILE and friends; inheriting them would
  // list some other repository or index instead of this checkout.
  const listing = spawnSyncBounded('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    env: sanitizedGitEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(listing.error).toBeUndefined();
  expect(listing.status, listing.stderr).toBe(0);
  const files = listing.stdout
    .split('\0')
    .filter(Boolean)
    .filter((file) => !OMITTED_TOP_LEVEL.includes(file.split('/')[0]));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(root, file), { dereference: false });
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
  return root;
}

function runLane(root: string) {
  return spawnSync(
    process.execPath,
    ['scripts/proof-family-lane.mjs', '--lane=repo-governance'],
    {
      cwd: root,
      env: sanitizedGitEnvironment(),
      encoding: 'utf8',
      // A hang guard only; the lane itself takes seconds.
      timeout: 120_000,
      windowsHide: true,
    },
  );
}

describe('repo-governance route error egress proof', () => {
  test('the lane CLI blocks on a raw WebSocket error coercion in a checkout', () => {
    // As a git hook would: an inherited index must not empty the copy.
    vi.stubEnv('GIT_INDEX_FILE', '/dev/null');
    const root = copyTrackedTree();
    expect(existsSync(join(root, VOICE_SESSION))).toBe(true);

    const clean = runLane(root);
    expect(clean.error).toBeUndefined();
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('Proof family lane passed: repo-governance');

    writeFileSync(
      join(root, VOICE_SESSION),
      `
        export function write(ws) {
          ws.on('error', (failure) => {
            ws.send(JSON.stringify({ message: String(failure) }));
          });
        }
      `,
    );
    const violating = runLane(root);
    expect(violating.error).toBeUndefined();
    expect(violating.status).toBe(1);
    expect(violating.stderr).toContain(
      'Proof family lane failed: repo-governance',
    );
    expect(violating.stderr.split('\n')).toContain(EXPECTED_BLOCK);
  }, 180_000);
});
