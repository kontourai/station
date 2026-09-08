import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmInvocation } from './lib/npm-cli.mjs';

function main() {
  // This check is sub-second and the bundle graph includes local modules and
  // resolver settings outside any single hand-maintained prefix list. Always
  // run it: complete selection is safer than a stale path allowlist.
  console.log('Basis MCP app freshness: checking — mandatory.');
  const npm = npmInvocation(['run', '--silent', 'basis:mcp:check']);
  const result = spawnSync(npm.command, npm.args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
