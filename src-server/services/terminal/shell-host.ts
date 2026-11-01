import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import { isPtyUnavailableError } from '../../domain/pty-adapter.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import type { TerminalJournal } from './terminal-journal.js';
import { resolveTerminalShellCandidates } from './terminal-shells.js';

/** Where a session's journal lives, for a host that journals output itself. */
export interface ShellJournalSpec {
  directory: string;
  options: Record<string, number | boolean>;
}

/** Handles may be local PTYs or proxies to supervisor-owned workloads. */
export interface ShellHost {
  spawn(input: {
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    journal: ShellJournalSpec;
  }): Promise<IPtyProcess>;
  /**
   * A shell this host kept running while the core restarted, or null when it
   * has ended. Only hosts that outlive the core (the supervisor's) have one.
   */
  attach?(
    terminalId: string,
    journal: ShellJournalSpec,
  ): Promise<HostedShellProcess | null>;
}

/**
 * A shell whose host journals its output (a supervisor workload). Its
 * output is read from `journal`, never appended by the core.
 */
export interface HostedShellProcess extends IPtyProcess {
  readonly journal: Pick<
    TerminalJournal,
    | 'read'
    | 'flush'
    | 'discard'
    | 'seal'
    | 'append'
    | 'backpressured'
    | 'drained'
  >;
  /** Calls back once more output is journaled and readable. */
  onOutput(listener: () => void): () => void;
  /** Stops listening without ending the shell: it outlives this core. */
  detach(): void;
}

export function isHostedShellProcess(
  process: IPtyProcess,
): process is HostedShellProcess {
  return 'detach' in process && 'onOutput' in process;
}

/**
 * Spawns the first candidate shell. Permission, cwd and backend failures must
 * not silently select a different shell; only a missing executable moves on.
 */
export async function spawnFirstShell(
  pty: IPtyAdapter,
  candidates: readonly { shell: string; args?: string[] }[],
  input: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
): Promise<IPtyProcess> {
  for (const candidate of candidates) {
    try {
      return await pty.spawn({
        shell: candidate.shell,
        args: candidate.args,
        ...input,
      });
    } catch (error) {
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

export function terminalShellEnvironment(): NodeJS.ProcessEnv {
  return childProcessEnvironment({
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
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
    const candidates = resolveTerminalShellCandidates({
      configuredShell: await this.configuredShell?.(),
      platform: process.platform,
      env: process.env,
    });
    return spawnFirstShell(this.pty, candidates, {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: terminalShellEnvironment(),
    });
  }
}
