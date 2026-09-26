import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fallow's JS launcher under the current Node rather than an `npx` shim, which
// Windows refuses to spawn without a shell (EINVAL, CVE-2024-27980); the form
// `run-fallow-audit.mjs` uses.
const fallowBin = fileURLToPath(import.meta.resolve('fallow/bin/fallow'));

const commands = [
  ['fallow', 'dead-code', '--save-baseline', 'fallow-baselines/dead-code.json'],
  ['fallow', 'health', '--save-baseline', 'fallow-baselines/health.json'],
  ['fallow', 'dupes', '--save-baseline', 'fallow-baselines/dupes.json'],
];

for (const args of commands) {
  const result = spawnSync(process.execPath, [fallowBin, ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`fallow baseline command terminated by ${result.signal}`);
    process.exit(1);
  }
}
