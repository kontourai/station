import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { sanitizedGitEnvironment } from './lib/git-environment.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { parseReleaseTag } from './lib/release-tag.mjs';
import { compareProductVersions } from './nightly-release-base.mjs';
import {
  assertProductVersion,
  checkProductVersion,
  syncProductVersion,
} from './product-version.mjs';

export function releaseCutPlan({
  tag,
  sourceSha,
  currentHead,
  sourceVersion,
  currentVersion,
}) {
  const identity = parseReleaseTag(tag);
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[0-9a-f]{40}$/.test(currentHead))
    throw new Error('Release cut requires exact source and working-tree SHAs');
  if (assertProductVersion(sourceVersion) !== identity.baseVersion)
    throw new Error(
      'The immutable cut source product version does not match its tag',
    );
  const [major, minor] = identity.baseVersion.split('.').map(Number);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor + 1))
    throw new Error(
      'The next product version exceeds the supported number range',
    );
  const nextVersion = `${major}.${minor + 1}.0`;
  const alreadyAdvanced =
    compareProductVersions(currentVersion, nextVersion) >= 0;
  if (!alreadyAdvanced && currentVersion !== identity.baseVersion)
    throw new Error(
      'Main product base must still equal the cut version or already be at a later development base',
    );
  return {
    kind: 'station.release-cut-plan/v1',
    tag,
    sourceSha,
    currentHead,
    sourceVersion,
    currentVersion,
    nextVersion,
    action: alreadyAdvanced ? 'already-advanced' : 'bump',
  };
}

/** A local delivery-branch edit after an immutable tag exists; never pushes or moves a tag. */
export function prepareReleaseCut({
  root = process.cwd(),
  tag,
  apply = false,
}) {
  const git = (args) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: sanitizedGitEnvironment(),
    }).trim();
  parseReleaseTag(tag);
  if (git(['status', '--porcelain', '--untracked-files=all']))
    throw new Error(
      'Release cut requires a committed clean isolated delivery checkout',
    );
  const sourceSha = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  const currentHead = git(['rev-parse', 'HEAD']);
  git(['merge-base', '--is-ancestor', sourceSha, currentHead]);
  const sourceVersion = JSON.parse(
    git(['show', `${sourceSha}:package.json`]),
  ).version;
  const currentVersion = checkProductVersion(root);
  const plan = releaseCutPlan({
    tag,
    sourceSha,
    currentHead,
    sourceVersion,
    currentVersion,
  });
  if (apply && plan.action === 'bump') {
    if (
      git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !==
        sourceSha ||
      git(['rev-parse', 'HEAD']) !== currentHead
    )
      throw new Error('Release cut source moved before the product-base edit');
    const path = resolve(root, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.version = plan.nextVersion;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    syncProductVersion(root);
  }
  return { ...plan, applied: apply && plan.action === 'bump' };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.some(
        (arg, index) =>
          arg !== '--apply' && arg !== '--tag' && args[index - 1] !== '--tag',
      )
    )
      throw new Error('Usage: release-cut.mjs --tag vX.Y.Z[-rc.N] [--apply]');
    if (
      args.filter((arg) => arg === '--tag').length !== 1 ||
      args.filter((arg) => arg === '--apply').length > 1
    )
      throw new Error('Release-cut options must be unambiguous');
    const index = args.indexOf('--tag');
    if (index < 0 || !args[index + 1]) throw new Error('Missing --tag');
    process.stdout.write(
      `${JSON.stringify(prepareReleaseCut({ tag: args[index + 1], apply: args.includes('--apply') }))}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
