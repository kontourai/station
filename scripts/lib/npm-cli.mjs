import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * The one way this repository invokes npm from Node.
 *
 * Windows ships npm as `npm.cmd`, which `CreateProcess` cannot execute, so a
 * bare `spawnSync('npm', ...)` throws ENOENT and takes its caller with it --
 * including the pre-push hook, which meant no Windows contributor could push
 * at all (#1093). The fix is not `shell: true` (that earns DEP0190 and
 * concatenates rather than escapes its arguments); it is to run npm's own JS
 * entry point under the current Node binary, which is deterministic and
 * shell-free on every platform.
 */

function checkedFile(path, description) {
  if (!path || !existsSync(path) || !statSync(path).isFile())
    throw new Error(`cannot resolve ${description} as a local file`);
  return path;
}

/**
 * Resolves npm's JS entry point. Prefers `npm_execpath` -- the npm that
 * actually invoked us, which is the only correct choice when a script runs
 * under `npm run` -- and otherwise falls back to the npm shipped beside this
 * Node binary. The fallback matters because Git hooks invoke scripts as bare
 * `node scripts/...`, which sets no npm environment at all.
 */
export function resolveNpmCli(env = process.env, node = process.execPath) {
  const fromNpm = env.npm_execpath;
  if (fromNpm) {
    if (!isAbsolute(fromNpm) || !/npm-cli\.js$/.test(fromNpm))
      throw new Error('npm_execpath must name an absolute npm-cli.js file');
    return checkedFile(fromNpm, 'npm CLI');
  }
  // Node distributions ship npm beside their node binary. Windows keeps it in
  // `node_modules` next to node.exe; Unix distributions conventionally use
  // the sibling `lib/node_modules`. Both are explicit JS entries, never .cmd.
  const candidates = [
    resolve(dirname(node), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return checkedFile(candidates.find(existsSync), 'npm CLI');
}

/**
 * Spawn-ready `{ command, args }` for an npm invocation. Pass the result
 * straight to `spawnSync`/`execFileSync` -- never with `shell: true`.
 *
 * @param {readonly string[]} npmArgs arguments after `npm`, e.g. ['run', 'build']
 */
export function npmInvocation(
  npmArgs,
  { env = process.env, node = process.execPath } = {},
) {
  return { command: node, args: [resolveNpmCli(env, node), ...npmArgs] };
}
