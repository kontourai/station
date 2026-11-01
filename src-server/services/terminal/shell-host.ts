import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { resolveTerminalShellCandidates } from './terminal-shells.js';

/** A program the server resolved; never taken from a request. */
export interface ShellLaunch {
  file: string;
  args: readonly string[];
  /** Added to the scrubbed child environment. */
  env?: Readonly<Record<string, string>>;
}

/** Handles may be local PTYs or proxies to supervisor-owned workloads. */
export interface ShellHost {
  spawn(input: {
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    /** Absent: the configured interactive shell. */
    launch?: ShellLaunch;
  }): Promise<IPtyProcess>;
}

export class InProcessShellHost implements ShellHost {
  constructor(
    private readonly pty: IPtyAdapter,
    private readonly configuredShell?: () =>
      | string
      | undefined
      | Promise<string | undefined>,
  ) {}

  async spawn(input: Parameters<ShellHost['spawn']>[0]): Promise<IPtyProcess> {
    if (input.launch)
      // A named program has no fallback: a missing executable is reported.
      return this.pty.spawn({
        shell: input.launch.file,
        args: [...input.launch.args],
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: childProcessEnvironment({
          ...input.launch.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        }),
      });
    const candidates = resolveTerminalShellCandidates({
      configuredShell: await this.configuredShell?.(),
      platform: process.platform,
      env: process.env,
    });
    for (const candidate of candidates) {
      try {
        return await this.pty.spawn({
          shell: candidate.shell,
          args: candidate.args,
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          env: childProcessEnvironment({
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          }),
        });
      } catch (error) {
        // Permission, cwd and backend failures must not silently select a
        // different shell. Only a missing executable permits fallback.
        if (
          isPtyUnavailableError(error) ||
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          throw error;
      }
    }
    throw new Error('No terminal shell is installed');
  }
}
