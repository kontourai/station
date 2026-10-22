import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_SCOPES,
  evaluateAuditPolicy,
  formatPolicyReport,
} from './dependency-advisory-policy.mjs';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { collectPnpmAudits } from './lib/pnpm-advisory.mjs';
import { readPnpmLockfile, readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';

const POLICY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{40}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function git(root, args) {
  return execFileSyncBounded(
    'git',
    ['--no-replace-objects', '-C', root, ...args],
    {
      windowsHide: true,
      timeout: 30_000,
    },
  );
}
function revision(root, expected) {
  if (
    !SHA.test(expected ?? '') ||
    git(root, ['rev-parse', 'HEAD']).toString().trim() !== expected
  )
    throw new Error(
      'Release advisory checkout does not match its exact source or policy SHA',
    );
}
function sourceInputs(root, sha) {
  revision(root, sha);
  const lock = readPnpmLockfile(root);
  const workspace = readPnpmWorkspace(root);
  const paths = new Set([
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    ...Object.keys(lock.importers).map((p) =>
      p === '.' ? 'package.json' : `${p}/package.json`,
    ),
    ...Object.values(workspace.patchedDependencies ?? {}),
  ]);
  const inputs = [...paths].sort().map((path) => {
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').includes('..')
    )
      throw new Error('Unsafe release dependency input');
    const file = resolve(root, path);
    if (!lstatSync(file).isFile() || realpathSync(file) !== file)
      throw new Error(
        `Release dependency input is not a regular file: ${path}`,
      );
    const bytes = readFileSync(file);
    if (!bytes.equals(git(root, ['show', `${sha}:${path}`])))
      throw new Error(
        `Release dependency input differs from the exact source: ${path}`,
      );
    return [path, digest(bytes)];
  });
  return {
    inputs,
    lockfileSha256: inputs.find(([p]) => p === 'pnpm-lock.yaml')[1],
  };
}

/** Registry collection is the only injected boundary; policy always evaluates the candidate graph. */
export async function auditReleaseSource({
  sourceRoot,
  sourceSha,
  policySha,
  policyRoot = POLICY_ROOT,
  collect = collectPnpmAudits,
}) {
  const source = realpathSync(sourceRoot);
  const policy = realpathSync(policyRoot);
  revision(policy, policySha);
  git(policy, ['diff', '--exit-code', 'HEAD', '--', '.']);
  const before = sourceInputs(source, sourceSha);
  const exceptions = readFileSync(
    resolve(policy, 'scripts/dependency-advisory-exceptions.json'),
  );
  const auditedAt = new Date().toISOString();
  // All six views, regardless of event/range. One fresh registry response; no receipt reuse or retry.
  const audits = await collect(
    AUDIT_SCOPES.map(({ scope }) => ({ scope })),
    { root: source },
  );
  const expected = new Set(
    AUDIT_SCOPES.flatMap(({ scope }) =>
      ['full', 'production'].map((r) => `${scope}/${r}`),
    ),
  );
  for (const audit of audits) {
    if (!expected.delete(`${audit.scope}/${audit.reachability}`))
      throw new Error('Duplicate or unexpected release advisory view');
  }
  if (expected.size) throw new Error('Incomplete release advisory views');
  const result = evaluateAuditPolicy(audits, JSON.parse(exceptions), {
    root: source,
  });
  const after = sourceInputs(source, sourceSha);
  revision(policy, policySha);
  git(policy, ['diff', '--exit-code', 'HEAD', '--', '.']);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    !exceptions.equals(
      readFileSync(
        resolve(policy, 'scripts/dependency-advisory-exceptions.json'),
      ),
    )
  )
    throw new Error('Release advisory inputs changed during the scan');
  return {
    schemaVersion: 1,
    kind: 'station.release-advisory',
    sourceSha,
    policySha,
    lockfileSha256: before.lockfileSha256,
    dependencyInputs: before.inputs,
    auditedAt,
    completedAt: new Date().toISOString(),
    scanCompleted: true,
    passed: result.ok,
    result,
  };
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (
        !['--source-root', '--source-sha', '--policy-sha', '--output'].includes(
          key,
        ) ||
        !args[i + 1] ||
        Object.hasOwn(options, key)
      )
        throw new Error(
          'Expected unique --source-root, --source-sha, --policy-sha and --output values',
        );
      options[key] = args[i + 1];
    }
    if (!options['--source-root'] || !options['--output'])
      throw new Error('Missing release advisory roots/output');
    const receipt = await auditReleaseSource({
      sourceRoot: options['--source-root'],
      sourceSha: options['--source-sha'],
      policySha: options['--policy-sha'],
    });
    writeFileSync(options['--output'], `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(formatPolicyReport(receipt.result));
    console.log(
      `Release advisory scan completed: source=${receipt.sourceSha} policy=${receipt.policySha} lock=${receipt.lockfileSha256}`,
    );
    process.exitCode = receipt.passed ? 0 : 1;
  } catch (error) {
    console.error(`Release advisory scan NOT_VERIFIED: ${error.message}`);
    process.exitCode = 2;
  }
}
