import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function main() {
  // This check is sub-second and the bundle graph includes local modules and
  // resolver settings outside any single hand-maintained prefix list. Always
  // run it: complete selection is safer than a stale path allowlist.
  console.log('Basis MCP app freshness: checking — mandatory.');
  const result = spawnSync('npm', ['run', '--silent', 'basis:mcp:check'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
