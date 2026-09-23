import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  PluginDraftBuildOptions,
  PluginDraftBuildResult,
} from '@kontourai/station-shared/build';

/**
 * Runs one plugin DRAFT build in a disposable child process (epic #2323 S3,
 * review round 3).
 *
 * A draft is authored by any Project member, and some of what esbuild reads
 * never passes through Station's `onLoad` checks: its resolver opens files
 * such as `package.json` itself. A FIFO there blocks esbuild's Go service in
 * a syscall that `cancel()` cannot interrupt, and in-process that service is
 * shared by every build on the host, installs included, so each blocked
 * attempt leaked OS threads into it until installs failed too.
 *
 * Here each draft build gets its own Node process, which starts its own
 * esbuild service. The child is its own process-group leader (POSIX), and
 * aborting kills the whole group with SIGKILL, so a blocked read, its
 * threads, and the esbuild service die with it. Install builds stay
 * in-process; they are an operator action, not member input.
 *
 * On Windows there are no process groups, so only the child is killed; its
 * esbuild service exits when its stdin closes. That path is not exercised
 * by this repository's tests.
 */

const CHILD_ENTRY = new URL(
  `./plugin-draft-build-child.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/**
 * The environment a draft build child gets: only what Node, tsx and esbuild
 * need to run. The server's environment carries provider keys and tokens,
 * and a draft is member-authored input, so nothing else is inherited.
 */
const DRAFT_BUILD_CHILD_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows process basics.
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  // An operator-pinned esbuild binary, honored by esbuild itself.
  'ESBUILD_BINARY_PATH',
] as const;

export function draftBuildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DRAFT_BUILD_CHILD_ENV_KEYS) {
    const value = parent[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export interface DraftBuildProcessHooks {
  /** Called with the child's pid once it is spawned (tests observe it). */
  onSpawn?: (pid: number) => void;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

export function buildPluginDraftInChildProcess(
  options: PluginDraftBuildOptions,
  hooks: DraftBuildProcessHooks = {},
): Promise<PluginDraftBuildResult> {
  const { signal, ...request } = options;
  const stopped = (): PluginDraftBuildResult => ({
    ok: false,
    diagnostics: [{ text: 'The draft build was stopped before it finished.' }],
  });
  if (signal?.aborted) return Promise.resolve(stopped());
  return new Promise((resolve) => {
    // `spawn` with an 'ipc' stdio slot, not `fork`: it is the same IPC
    // channel, and unlike ForkOptions its options carry `windowsHide`, which
    // every process this server launches sets.
    const child = spawn(
      process.execPath,
      [
        ...(CHILD_ENTRY.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []),
        fileURLToPath(CHILD_ENTRY),
      ],
      {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        windowsHide: true,
        env: draftBuildChildEnv(),
      },
    );
    let settled = false;
    const settle = (result: PluginDraftBuildResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      // Whatever happened, nothing this build started outlives it.
      killGroup(child);
      resolve(result);
    };
    const onAbort = () => settle(stopped());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (child.pid !== undefined) hooks.onSpawn?.(child.pid);
    child.once('message', (message: { result?: PluginDraftBuildResult }) => {
      settle(
        message?.result ?? {
          ok: false,
          diagnostics: [{ text: 'The draft build returned no result.' }],
        },
      );
    });
    child.once('error', () =>
      settle({
        ok: false,
        diagnostics: [{ text: 'The draft build process could not start.' }],
      }),
    );
    child.once('exit', () =>
      settle({
        ok: false,
        diagnostics: [{ text: 'The draft build process exited early.' }],
      }),
    );
    child.send({ options: request });
  });
}
