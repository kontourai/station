import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
if (process.platform === 'win32') {
  const git = spawnSync('git', ['--exec-path'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status !== 0)
    throw new Error('Cannot locate Git shell for Veritas evidence checks');
  const shellDir = resolve(git.stdout.trim(), '../../..', 'bin');
  if (!existsSync(resolve(shellDir, 'sh.exe')))
    throw new Error(`Git shell is missing from ${shellDir}`);
  env.PATH = `${shellDir}${delimiter}${env.PATH ?? ''}`;
}

/**
 * Veritas diffs `--changed-from A --changed-to B` as the two-point range
 * `A..B`. When A is a moving ref such as `origin/main` that has advanced past
 * the branch's base, that range counts files added on newer main as changed and
 * readiness fails with ENOENT reading them (#5120). Resolve such a ref to
 * `git merge-base A B` (the three-dot `A...B` base). A ref that is already an
 * ancestor of B (an explicit base SHA, CI's `HEAD^`) is passed through as given.
 */
function branchScopedArgs(args) {
  const flagValue = (flag) => {
    const at = args.lastIndexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const cwd = flagValue('--root') ?? process.cwd();
  const to = flagValue('--changed-to') ?? 'HEAD';
  const git = (gitArgs) =>
    spawnSync('git', gitArgs, { cwd, encoding: 'utf8', windowsHide: true });
  return args.map((arg, index) => {
    if (index === 0 || args[index - 1] !== '--changed-from') return arg;
    if (git(['merge-base', '--is-ancestor', arg, to]).status !== 1) return arg;
    const base = git(['merge-base', arg, to]);
    const sha = base.status === 0 ? base.stdout.trim() : '';
    if (!sha) return arg;
    process.stderr.write(
      `veritas readiness: --changed-from ${arg} is not an ancestor of ${to}; using its merge base ${sha}\n`,
    );
    return sha;
  });
}

const entry = fileURLToPath(
  new URL(
    '../node_modules/@kontourai/veritas/bin/veritas.mjs',
    import.meta.url,
  ),
);
const child = spawnSync(
  process.execPath,
  [entry, 'readiness', ...branchScopedArgs(process.argv.slice(2))],
  {
    env,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
