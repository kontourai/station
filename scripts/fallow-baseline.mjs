import { spawnSync } from 'node:child_process';

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const commands = [
  ['fallow', 'dead-code', '--save-baseline', 'fallow-baselines/dead-code.json'],
  ['fallow', 'health', '--save-baseline', 'fallow-baselines/health.json'],
  ['fallow', 'dupes', '--save-baseline', 'fallow-baselines/dupes.json'],
];

for (const args of commands) {
  const result = spawnSync(executable, args, {
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
