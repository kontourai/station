/**
 * #2998: the legacy git update replaces bytes outside the install
 * transaction. It runs the install trust migration first, so a pre-d1 plugin
 * is grandfathered against the bytes it had before the update, and the
 * record then reads stale against the pulled bytes instead of the pull being
 * grandfathered later.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import {
  pluginTrustForInstalledBytes,
  readPluginTrustRecord,
} from '../../../services/plugins/plugin-install-trust-store.js';
import { execGitSync } from '../../../utils/git-exec.js';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';

const tempDir = trackTempDirs();

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
}

function git(cwd: string, ...args: string[]): string {
  return String(
    execGitSync(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args,
      ],
      { cwd, hardening: { allowFileProtocol: true } },
    ),
  ).trim();
}

describe('legacy git update and install trust', () => {
  test('a pre-d1 plugin is grandfathered against its bytes before the pull, and reads stale after it', async () => {
    const root = tempDir('station-trust-legacy-update-');
    const origin = join(root, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'legacy-git', version: '1.0.0' }),
    );
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'v1');
    const home = join(root, 'home');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    mkdirSync(join(home, 'agents'));
    // Installed before d1: a clone in plugins/, no trust records at all.
    git(join(home, 'plugins'), 'clone', '-q', origin, 'legacy-git');
    const pluginsDir = join(home, 'plugins');
    const v1Digest = computePluginContentDigest(pluginsDir, 'legacy-git');
    writeFileSync(
      join(origin, 'plugin.json'),
      JSON.stringify({ name: 'legacy-git', version: '1.1.0' }),
    );
    git(origin, 'commit', '-q', '-am', 'v2');

    const app = withOperatorPrincipal(createPluginRoutes(home, makeLogger()));
    const response = await app.request('/legacy-git/update', {
      method: 'POST',
    });
    expect(await response.json()).toMatchObject({ success: true });

    const state = readPluginTrustRecord(home, 'legacy-git');
    expect(state).toMatchObject({
      state: 'recorded',
      record: { decision: 'grandfathered', tier: 2, contentDigest: v1Digest },
    });
    const now = computePluginContentDigest(pluginsDir, 'legacy-git');
    expect(now).not.toBe(v1Digest);
    expect(pluginTrustForInstalledBytes(state, now)).toMatchObject({
      state: 'stale',
    });
  });
});
