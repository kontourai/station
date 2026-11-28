import { spawnSync } from 'node:child_process';

const invocation = JSON.parse(
  Buffer.from(process.argv[2], 'base64url').toString('utf8'),
);
const result = spawnSync(invocation.command, invocation.args, {
  argv0: invocation.argv0,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
