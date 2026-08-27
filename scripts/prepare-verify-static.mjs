#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_STATIC_WORKSPACES = [
  {
    buildScript: 'build:connect',
    distDir: 'packages/connect/dist',
    name: '@kontourai/station-connect',
  },
  // station#1813: `dist:freshness` runs at the head of `npm run typecheck`, and
  // `packages/cli` publishes its `bin` out of a git-ignored bundle, so this
  // lane has to produce (and stamp) that bundle for the same reason it
  // produces connect's `.d.ts` files. The esbuild run is sub-second.
  {
    buildScript: 'build:cli',
    // Spelled with the trailing slash the lane declarations already use for
    // this directory; a second spelling for one path would be worse than the
    // inconsistency between it and connect's.
    distDir: 'packages/cli/dist/',
    name: '@kontourai/station-cli',
  },
];

function runNpmScript(script, cwd) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli
    ? { executable: process.execPath, args: [npmCli, 'run', script] }
    : {
        executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['run', script],
      };
  const result = spawnSync(command.executable, command.args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm run ${script} exited with status ${result.status}`);
  }
}

export function prepareVerifyStatic({
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  runBuild = runNpmScript,
} = {}) {
  for (const workspace of REQUIRED_STATIC_WORKSPACES) {
    const distDir = resolve(repoRoot, workspace.distDir);
    console.log(
      `Preparing ${workspace.name} for static verification (${workspace.buildScript})`,
    );
    // The coordinator has admitted this raw lane for this *worktree*.  Remove
    // the exact output it owns before the build so deleted JS/assets cannot
    // survive a replacement build. This path is physically worktree-scoped;
    // never infer or touch a sibling checkout's equivalent directory.
    rmSync(distDir, { force: true, recursive: true });
    runBuild(workspace.buildScript, repoRoot);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    prepareVerifyStatic();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
