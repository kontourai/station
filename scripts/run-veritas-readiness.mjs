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
const entry = fileURLToPath(
  new URL(
    '../node_modules/@kontourai/veritas/bin/veritas.mjs',
    import.meta.url,
  ),
);
const child = spawnSync(
  process.execPath,
  [entry, 'readiness', ...process.argv.slice(2)],
  {
    env,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
