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

function git(args) {
  return execFileSync('git', args, {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function fail(message) {
  console.error(`[install-git-hooks] ${message}`);
  process.exit(1);
}

let toplevel;
try {
  toplevel = git(['rev-parse', '--show-toplevel']);
} catch {
  fail('not a git checkout; hooks were NOT armed');
}

// Guard against arming an ENCLOSING repository: if this package is vendored
// or nested inside another checkout, `git rev-parse` resolves to the outer
// repo, and setting its core.hooksPath would clobber that repo's own hooks
// while pointing at a .githooks directory it does not have.
if (resolve(toplevel) !== packageRoot) {
  fail(
    `git toplevel (${toplevel}) is not this package root (${packageRoot}); ` +
      'refusing to arm hooks on an enclosing repository',
  );
}
for (const hook of ['pre-push', 'commit-msg']) {
  if (!existsSync(join(packageRoot, '.githooks', hook))) {
    fail(`.githooks/${hook} is missing; nothing to arm`);
  }
}

try {
  git(['config', 'core.hooksPath', '.githooks']);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail(`could not set core.hooksPath: ${detail}`);
}

// Prove the write landed rather than assuming it: a read-only config makes
// `git config` fail above, but proving by read-back keeps "armed" a
// derivation instead of a label.
if (git(['config', '--get', 'core.hooksPath']) !== '.githooks') {
  fail('core.hooksPath did not read back as .githooks; hooks are NOT armed');
}

console.log('Station git hooks active (.githooks)');
