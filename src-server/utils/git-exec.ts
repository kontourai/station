/**
 * Central git execution helper.
 *
 * The whole reason this module exists: an inherited `GIT_DIR` /
 * `GIT_WORK_TREE` in the environment silently retargets every spawned `git`
 * at the wrong repository. Under such an environment Station's git operations
 * (status/commit/push/clone/worktree) would act on whatever repo those vars
 * point at instead of the directory passed via `cwd`, which has caused real
 * `core.bare` corruption of the surrounding checkout (issue archive#104).
 *
 * Every production git invocation MUST go through one of the helpers here so
 * the sanitized environment is applied uniformly. The only behavioral change
 * versus a raw `execFile`/`spawn` is that `GIT_DIR`/`GIT_WORK_TREE` are removed
 * from the inherited environment and `windowsHide: true` is set.
 */
import {
  type ExecFileOptions,
  type ExecFileSyncOptions,
  execFile as execFileCb,
  execFileSync,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { promisify } from 'node:util';
import { childProcessEnvironment } from './child-process-environment.js';

const execFileAsync = promisify(execFileCb);

/**
 * Return a copy of `process.env` with `GIT_DIR` and `GIT_WORK_TREE` deleted,
 * merged with `extra`. The keys are actually removed (not set to the string
 * "undefined"), so a spawned `git` falls back to discovering the repo from its
 * `cwd` instead of an inherited, possibly-wrong target.
 */
export function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = childProcessEnvironment(extra);
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/** Promisified `execFile('git', …)` with a sanitized environment. */
export function execGit(
  args: string[],
  opts: ExecFileOptions & { encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    ...opts,
    env: gitEnv(opts.env),
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * Promisified command execution for tools (such as `gh`) which discover a
 * repository from their cwd. It deliberately shares git's environment scrub:
 * inherited GIT_DIR/GIT_WORK_TREE must never retarget that discovery.
 */
export function execGitContextCommand(
  command: string,
  args: string[],
  opts: ExecFileOptions & { encoding?: BufferEncoding } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    ...opts,
    env: gitEnv(opts.env),
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/** `execFileSync('git', …)` with a sanitized environment. */
export function execGitSync(
  args: string[],
  opts: ExecFileSyncOptions = {},
): string | Buffer {
  return execFileSync('git', args, {
    ...opts,
    env: gitEnv(opts.env),
    windowsHide: true,
  });
}

/** `spawn('git', …)` with a sanitized environment. */
export function spawnGit(args: string[], opts: SpawnOptions = {}) {
  return spawn('git', args, {
    ...opts,
    env: gitEnv(opts.env),
    windowsHide: true,
  });
}
