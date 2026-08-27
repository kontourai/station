import type {
  TerminalProcessDetail,
  TerminalProcessSummary,
} from '@kontourai/station-contracts/orchestration';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import type { ITerminalHistoryStore } from '../../domain/terminal-history-store.js';
import type {
  TerminalEvent,
  TerminalOpenInput,
  TerminalSessionSnapshot,
  TerminalSessionState,
} from '../../domain/terminal-types.js';
import { terminalOps } from '../../telemetry/metrics.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { expandTilde } from '../../utils/paths.js';
import { resolveTerminalShellCandidates } from './terminal-shells.js';
import { pollTerminalSubprocessActivity } from './terminal-subprocess-state.js';

const HISTORY_LINE_LIMIT = 5000;
const PERSIST_DEBOUNCE_MS = 40;

type SessionEntry = TerminalSessionState & {
  process: IPtyProcess | null;
  unsubData: (() => void) | null;
  unsubExit: (() => void) | null;
  /** An accepted close while the asynchronous PTY spawn is still pending. */
  cancelled: boolean;
};

/** The terminal identity that an authorized project route has terminated. */
export interface TerminalProjectCloseResult {
  sessionId: string;
  projectSlug: string;
  terminalId: string;
}

export class TerminalService {
  private sessions = new Map<string, SessionEntry>();
  private listeners = new Set<(event: TerminalEvent) => void>();
  private historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private subprocessInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pty: IPtyAdapter,
    private historyStore: ITerminalHistoryStore,
    private getTerminalShell?: () => string | undefined,
  ) {
    if (process.platform !== 'win32') {
      this.subprocessInterval = setInterval(
        () => this.pollSubprocesses(),
        MS_PER_MINUTE, // Poll every 60s instead of 1s to reduce popup frequency
      );
    }
  }

  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const sessionId = `${input.projectSlug}:${input.terminalId}`;
    const existing = this.sessions.get(sessionId);
    if (existing?.status === 'running') return this.snapshot(existing);
    this.clearPendingKill(sessionId);
    terminalOps.add(1, { operation: 'open' });

    const history =
      existing?.history ?? (await this.historyStore.load(sessionId));

    // station#1497 — refuse an empty working directory instead of letting
    // node-pty decide. `unixTerminal.js` resolves `opt.cwd || process.cwd()`,
    // so a blank cwd silently spawns the user's shell in whatever directory
    // station-control was launched from — usually the Station checkout — and
    // renders as a working prompt rather than as an error. The UI's
    // `config.workingDirectory ?? ''` is a display default; it must not become
    // an execution decision.
    if (input.cwd.trim().length === 0) {
      throw new Error(
        `Cannot open a terminal for project '${input.projectSlug}': it has no working directory configured.`,
      );
    }

    // The project workingDirectory is stored with a literal `~` (e.g.
    // `~/dev/project`). node-pty cannot chdir into an unexpanded `~`, so the
    // shell would spawn and exit immediately (code 1, no prompt). Expand it
    // here so the PTY gets a real path.
    const cwd = expandTilde(input.cwd);

    const entry: SessionEntry = existing ?? {
      sessionId,
      projectSlug: input.projectSlug,
      terminalId: input.terminalId,
      cwd,
      status: 'starting',
      pid: null,
      history,
      exitCode: null,
      cols: input.cols,
      rows: input.rows,
      hasRunningSubprocess: false,
      process: null,
      unsubData: null,
      unsubExit: null,
      cancelled: false,
    };

    entry.status = 'starting';
    entry.cols = input.cols;
    entry.rows = input.rows;
    this.sessions.set(sessionId, entry);

    const env = childProcessEnvironment({
      ...input.env,
      TERM: 'xterm-256color',
    });
    const candidates = input.shell
      ? [{ shell: input.shell, args: input.shellArgs }]
      : resolveTerminalShellCandidates({
          configuredShell: this.getTerminalShell?.(),
          platform: process.platform,
          env: process.env,
        });
    let proc: IPtyProcess | null = null;

    for (const candidate of candidates) {
      try {
        proc = await this.pty.spawn({
          shell: candidate.shell,
          args: candidate.args,
          cwd,
          cols: input.cols,
          rows: input.rows,
          env,
        });
        break;
      } catch (e) {
        if (this.wasCancelledDuringOpen(sessionId, entry)) {
          throw this.openCancelledError(sessionId);
        }
        console.debug('Failed to spawn shell candidate:', candidate.shell, e);
      }
    }

    if (!proc) {
      if (this.wasCancelledDuringOpen(sessionId, entry)) {
        throw this.openCancelledError(sessionId);
      }
      throw new Error('Failed to spawn PTY: no viable shell found');
    }

    // The project-bound close route can accept a close while spawn() is
    // pending. It removes the starting entry immediately, so this delayed
    // process must never become a running, untracked terminal.
    if (this.wasCancelledDuringOpen(sessionId, entry)) {
      proc.kill();
      throw this.openCancelledError(sessionId);
    }

    entry.process = proc;
    entry.pid = proc.pid;
    entry.status = 'running';

    entry.unsubData = proc.onData((data) => {
      entry.history = this.trimHistory(entry.history + data);
      this.emit({ type: 'data', sessionId, data });
      this.schedulePersist(sessionId);
    });

    entry.unsubExit = proc.onExit(({ exitCode, signal }) => {
      this.clearPendingKill(sessionId);
      entry.status = 'exited';
      entry.exitCode = exitCode;
      entry.process = null;
      this.persistNow(sessionId);
      this.emit({ type: 'exited', sessionId, exitCode, signal });
    });

    this.emit({ type: 'started', sessionId, pid: proc.pid });
    return this.snapshot(entry);
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.process?.write(data);
  }

  /**
   * Reads the running shell's cwd for an interaction that must describe the
   * terminal's current context. Deliberately does not fall back to
   * `entry.cwd`: that is only the directory used to launch the PTY and can be
   * stale after a shell-side `cd`.
   */
  async getCwd(sessionId: string): Promise<string | null> {
    terminalOps.add(1, { operation: 'get_cwd' });
    const cwd = await this.sessions.get(sessionId)?.process?.getCwd?.();
    return cwd && cwd.length > 0 ? cwd : null;
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.cols = cols;
    entry.rows = rows;
    entry.process?.resize(cols, rows);
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    terminalOps.add(1, { operation: 'close' });
    entry.cancelled = true;
    this.clearPendingKill(sessionId);
    entry.unsubData?.();
    entry.unsubExit?.();
    const proc = entry.process;
    proc?.kill();
    // SIGKILL fallback for stubborn processes (e.g. kiro-cli with children),
    // tied to the PTY process object instead of a raw PID.
    if (proc) {
      this.killTimers.set(
        sessionId,
        setTimeout(() => {
          this.killTimers.delete(sessionId);
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 3000),
      );
    }
    entry.status = 'exited';
    await this.persistNow(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Close one terminal only when its exact project-scoped identity exists.
   * Callers provide separate route-bound values rather than a raw session id,
   * so a request addressed to one Project cannot terminate another Project's
   * terminal by supplying its session id.
   */
  async closeForProject(
    projectSlug: string,
    terminalId: string,
  ): Promise<TerminalProjectCloseResult | null> {
    const sessionId = `${projectSlug}:${terminalId}`;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;

    const result: TerminalProjectCloseResult = {
      sessionId: entry.sessionId,
      projectSlug: entry.projectSlug,
      terminalId: entry.terminalId,
    };
    await this.close(sessionId);
    return result;
  }

  async closeByProject(projectSlug: string): Promise<void> {
    const ids = [...this.sessions.entries()]
      .filter(([, e]) => e.projectSlug === projectSlug)
      .map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async restart(sessionId: string): Promise<TerminalSessionSnapshot> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    terminalOps.add(1, { operation: 'restart' });
    const input: TerminalOpenInput = {
      projectSlug: entry.projectSlug,
      terminalId: entry.terminalId,
      cwd: entry.cwd,
      cols: entry.cols,
      rows: entry.rows,
    };
    await this.close(sessionId);
    return this.open(input);
  }

  listProcessSummaries(): TerminalProcessSummary[] {
    return [...this.sessions.values()]
      .map((entry) => this.toProcessSummary(entry))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  readProcess(sessionId: string): TerminalProcessDetail | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return null;
    }

    return {
      process: this.toProcessSummary(entry),
      history: entry.history,
    };
  }

  subscribe(cb: (event: TerminalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async dispose(): Promise<void> {
    if (this.subprocessInterval) clearInterval(this.subprocessInterval);
    for (const timer of this.killTimers.values()) clearTimeout(timer);
    this.killTimers.clear();
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private snapshot(entry: SessionEntry): TerminalSessionSnapshot {
    return {
      sessionId: entry.sessionId,
      status: entry.status,
      pid: entry.pid,
      history: entry.history,
      cols: entry.cols,
      rows: entry.rows,
    };
  }

  private emit(event: TerminalEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  private clearPendingKill(sessionId: string): void {
    const timer = this.killTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(sessionId);
    }
  }

  private wasCancelledDuringOpen(
    sessionId: string,
    entry: SessionEntry,
  ): boolean {
    return entry.cancelled || this.sessions.get(sessionId) !== entry;
  }

  private openCancelledError(sessionId: string): Error {
    return new Error(
      `Terminal open cancelled: '${sessionId}' was closed before its PTY started.`,
    );
  }

  private toProcessSummary(entry: SessionEntry): TerminalProcessSummary {
    return {
      kind: 'terminal',
      sessionId: entry.sessionId,
      projectSlug: entry.projectSlug,
      terminalId: entry.terminalId,
      cwd: entry.cwd,
      status: entry.status,
      pid: entry.pid,
      exitCode: entry.exitCode,
      hasRunningSubprocess: entry.hasRunningSubprocess,
      cols: entry.cols,
      rows: entry.rows,
    };
  }

  private trimHistory(history: string): string {
    const lines = history.split('\n');
    return lines.length > HISTORY_LINE_LIMIT
      ? lines.slice(-HISTORY_LINE_LIMIT).join('\n')
      : history;
  }

  private schedulePersist(sessionId: string): void {
    const existing = this.historyTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.historyTimers.set(
      sessionId,
      setTimeout(() => this.persistNow(sessionId), PERSIST_DEBOUNCE_MS),
    );
  }

  private async persistNow(sessionId: string): Promise<void> {
    const timer = this.historyTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.historyTimers.delete(sessionId);
    }
    const entry = this.sessions.get(sessionId);
    if (entry) await this.historyStore.save(sessionId, entry.history);
  }

  private pollSubprocesses(): void {
    for (const [sessionId, entry] of this.sessions) {
      pollTerminalSubprocessActivity({
        sessionId,
        entry,
        emit: (event) => this.emit(event),
      });
    }
  }
}
