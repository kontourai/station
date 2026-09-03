export interface IPtyProcess {
  pid: number;
  /**
   * The shell process's current directory at the time of the call. A launch
   * cwd is not a substitute: shells can `cd` after their PTY is opened.
   */
  getCwd?(): Promise<string | null>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): () => void;
  onExit(
    cb: (event: { exitCode: number; signal: number | null }) => void,
  ): () => void;
}

export interface IPtyAdapter {
  spawn(input: {
    shell: string;
    args?: string[];
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }): Promise<IPtyProcess>;
  /**
   * Whether this adapter's PTY backend can actually load (#1244). Absent on
   * adapters with no native backend to lose; callers treat absence as
   * available rather than inventing a degradation nothing observed.
   */
  probeCapability?(): Promise<
    import('@kontourai/station-shared/terminal-capability').TerminalCapability
  >;
}

/**
 * Thrown by an adapter whose PTY backend could not be loaded at all —
 * distinct from one shell candidate failing to spawn. `TerminalService`
 * rethrows it untouched so terminal routes report the specific degraded
 * reason instead of the generic "no viable shell found" (#1244).
 */
export class PtyUnavailableError extends Error {
  readonly code = 'PTY_UNAVAILABLE';

  constructor(reason: string) {
    super(reason);
    this.name = 'PtyUnavailableError';
  }
}

export function isPtyUnavailableError(
  error: unknown,
): error is PtyUnavailableError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'PTY_UNAVAILABLE'
  );
}
