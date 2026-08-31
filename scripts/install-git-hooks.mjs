#!/usr/bin/env node
// Arms the repo's version-controlled git hooks (.githooks/) by setting
// core.hooksPath. Runs from `npm run hooks:install` and Station's dependency
// lifecycle runner, so a supported fresh developer bootstrap arms the
// pre-push and commit-msg gates without letting npm's package lifecycle
// execute arbitrary scripts.
//
// This script is STRICT: it exits non-zero whenever the hooks did not end up
// armed, so an explicit `npm run hooks:install` cannot report success while
// leaving pushes ungated. A container manifest-only install is not a checkout
// and has no `.git`, so the runner reports that hook arming is not applicable.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mergeDriverName = 'station-ui-bundle-budget';
const mergeDriverCommand =
  'node scripts/merge-ui-bundle-budget.mjs %O %A %B %L %P';

function git(args) {
  return execFileSync('git', args, {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function fail(message) {
  throw new Error(message);
}

export function installGitIntegration({
  root = packageRoot,
  runGit = git,
  pathExists = existsSync,
} = {}) {
  let toplevel;
  try {
    toplevel = runGit(['rev-parse', '--show-toplevel']);
  } catch {
    fail('not a git checkout; hooks and merge driver were NOT armed');
  }

  // Guard against arming an ENCLOSING repository: if this package is vendored
  // or nested inside another checkout, `git rev-parse` resolves to the outer
  // repo, and setting its local config would clobber that repo's integration.
  if (resolve(toplevel) !== root) {
    fail(
      `git toplevel (${toplevel}) is not this package root (${root}); ` +
        'refusing to configure an enclosing repository',
    );
  }
  for (const hook of ['pre-push', 'commit-msg']) {
    if (!pathExists(join(root, '.githooks', hook))) {
      fail(`.githooks/${hook} is missing; nothing to arm`);
    }
  }

  const settings = [
    ['core.hooksPath', '.githooks'],
    [
      `merge.${mergeDriverName}.name`,
      'Station UI bundle budget re-measurement',
    ],
    [`merge.${mergeDriverName}.driver`, mergeDriverCommand],
  ];
  for (const [key, value] of settings) {
    try {
      runGit(['config', '--local', key, value]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`could not set ${key}: ${detail}`);
    }

    // Prove every write landed rather than assuming it. In particular, the
    // attribute is fail-safe only when a missing driver stays unregistered;
    // never report this driver active after a partial or redirected write.
    if (runGit(['config', '--local', '--get', key]) !== value) {
      fail(
        `${key} did not read back as configured; git integration is NOT armed`,
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    installGitIntegration();
    console.log(
      `Station git hooks active (.githooks); merge driver active (${mergeDriverName})`,
    );
  } catch (error) {
    console.error(
      `[install-git-hooks] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
