import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareVerifyStatic,
  REQUIRED_STATIC_WORKSPACES,
} from '../prepare-verify-static.mjs';

const tempRoots: string[] = [];

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'station-verify-static-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('verify:static workspace bootstrap', () => {
  it('builds every required workspace from a clean checkout', () => {
    const root = tempRepo();
    const builds: string[] = [];
    // Derived from the declaration rather than hand-listed, so a workspace
    // added to REQUIRED_STATIC_WORKSPACES without its dist being produced
    // fails here (station#1813 added packages/cli, whose `bin` is a
    // git-ignored bundle on the typecheck path).
    const distFor = (script: string) =>
      join(
        root,
        REQUIRED_STATIC_WORKSPACES.find((w) => w.buildScript === script)!
          .distDir,
      );

    prepareVerifyStatic({
      repoRoot: root,
      runBuild(script: string, cwd: string) {
        builds.push(script);
        expect(cwd).toBe(root);
        const dist = distFor(script);
        expect(existsSync(dist)).toBe(false);
        mkdirSync(dist, { recursive: true });
        writeFileSync(join(dist, 'index.d.ts'), 'export {};\n');
      },
    });

    expect(REQUIRED_STATIC_WORKSPACES).toEqual([
      {
        buildScript: 'build:connect',
        distDir: 'packages/connect/dist',
        name: '@kontourai/station-connect',
      },
      {
        buildScript: 'build:cli',
        distDir: 'packages/cli/dist/',
        name: '@kontourai/station-cli',
      },
    ]);
    expect(builds).toEqual(
      REQUIRED_STATIC_WORKSPACES.map((workspace) => workspace.buildScript),
    );
    // Every declared workspace produced output, not just the first.
    for (const workspace of REQUIRED_STATIC_WORKSPACES) {
      expect(existsSync(join(root, workspace.distDir, 'index.d.ts'))).toBe(
        true,
      );
    }
  });

  it('replaces stale Connect output without touching sibling worktree output', () => {
    const root = tempRepo();
    const connectDist = join(root, 'packages/connect/dist');
    const sdkDist = join(root, 'packages/sdk/dist');
    mkdirSync(connectDist, { recursive: true });
    mkdirSync(sdkDist, { recursive: true });
    writeFileSync(join(connectDist, 'stale.js'), 'stale');
    writeFileSync(join(sdkDist, 'sentinel.js'), 'keep');

    prepareVerifyStatic({
      repoRoot: root,
      runBuild(script: string) {
        if (script !== 'build:connect') return;
        expect(existsSync(connectDist)).toBe(false);
        mkdirSync(connectDist, { recursive: true });
        writeFileSync(join(connectDist, 'index.js'), 'current');
      },
    });

    expect(existsSync(join(connectDist, 'stale.js'))).toBe(false);
    expect(readFileSync(join(connectDist, 'index.js'), 'utf8')).toBe('current');
    expect(readFileSync(join(sdkDist, 'sentinel.js'), 'utf8')).toBe('keep');
  });

  it('does not clear a similarly-named output in a sibling worktree', () => {
    const root = tempRepo();
    const connectDist = join(root, 'packages/connect/dist');
    const siblingRoot = tempRepo();
    const siblingConnectDist = join(siblingRoot, 'packages/connect/dist');
    mkdirSync(connectDist, { recursive: true });
    mkdirSync(siblingConnectDist, { recursive: true });
    writeFileSync(join(connectDist, 'stale.js'), 'replace');
    writeFileSync(
      join(siblingConnectDist, 'sibling-live.js'),
      'sibling owns this',
    );

    prepareVerifyStatic({
      repoRoot: root,
      runBuild(script: string) {
        if (script !== 'build:connect') return;
        expect(existsSync(connectDist)).toBe(false);
        mkdirSync(connectDist, { recursive: true });
      },
    });

    expect(
      readFileSync(join(siblingConnectDist, 'sibling-live.js'), 'utf8'),
    ).toBe('sibling owns this');
  });

  it('keeps Node 24 enforcement ahead of the bootstrap in the canonical gate', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const commands = manifest.scripts['verify:static:bootstrap'].split(' && ');

    expect(manifest.engines.node).toBe('24.x');
    // The public command now enters the coordinator, which invokes the raw
    // command. Keeping npm's implicit pre-hook empty prevents a second,
    // unlocked bootstrap outside that owned output lifetime.
    expect(manifest.scripts['preverify:static']).toBe('node -e ""');
    expect(manifest.scripts['prepare:verify-static']).toBe(
      'node scripts/prepare-verify-static.mjs',
    );
    expect(manifest.scripts['dependency-drift:gate']).toBe(
      'tsx scripts/check-kontour-dependency-drift.ts',
    );
    expect(
      commands.indexOf('node scripts/node-runtime-contract.mjs'),
    ).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('npm run dependency-drift:gate')).toBeGreaterThan(
      commands.indexOf('node scripts/node-runtime-contract.mjs'),
    );
    expect(
      commands.findIndex((command: string) =>
        command.startsWith('npx biome check'),
      ),
    ).toBeGreaterThan(commands.indexOf('npm run dependency-drift:gate'));
    expect(commands.indexOf('npm run prepare:verify-static')).toBeGreaterThan(
      commands.indexOf('npm run dependency-drift:gate'),
    );
  });
});
