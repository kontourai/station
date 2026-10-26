import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  closeChildWorkload,
  prepareChildWorkload,
  trackChildWorkload,
} from '@kontourai/station-shared/child-workload';
import {
  describeTerminalPtyLoadFailure,
  type TerminalCapability,
  terminalPtyUnavailableReason,
} from '@kontourai/station-shared/terminal-capability';
import {
  type IPtyAdapter,
  type IPtyProcess,
  PtyUnavailableError,
} from '../domain/pty-adapter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ name: 'node-pty-adapter' });

let nodePtyPromise: Promise<typeof import('node-pty')> | null = null;
let didFixSpawnHelper = false;

function ensureSpawnHelper(): void {
  if (didFixSpawnHelper || process.platform === 'win32') return;
  didFixSpawnHelper = true;
  try {
    // Resolve node-pty package directory via require.resolve
    const pkgPath = require.resolve('node-pty/package.json');
    const pkgDir = dirname(pkgPath);
    const candidates = [
      join(
        pkgDir,
        'prebuilds',
        `${process.platform}-${process.arch}`,
        'spawn-helper',
      ),
      join(pkgDir, 'build', 'Release', 'spawn-helper'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          chmodSync(p, 0o755);
        } catch (e) {
          logger.debug('Failed to chmod spawn-helper', { path: p, error: e });
        }
      }
    }
  } catch (e) {
    logger.debug('Failed to fix node-pty spawn-helper permissions', {
      error: e,
    });
  }
}

function getNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) {
    ensureSpawnHelper();
    // The rejection stays cached deliberately: a native module that failed
    // to load does not heal without a rebuild and a process restart, and a
    // sticky failure keeps every later probe and spawn reporting the same
    // reason instead of re-running a doomed import (#1244).
    nodePtyPromise = import('node-pty');
  }
  return nodePtyPromise;
}

class NodePtyProcess implements IPtyProcess {
  private paused = false;
  private pauseEpoch = 0;
  private outputIncomplete = false;
  private pauseWatch?: ReturnType<typeof setTimeout>;

  constructor(private pty: import('node-pty').IPty) {
    pty.onExit(() => {
      if (this.paused) this.outputIncomplete = true;
      clearTimeout(this.pauseWatch);
      this.pauseEpoch++;
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  async getCwd(): Promise<string | null> {
    if (process.platform === 'linux') {
      try {
        return readlinkSync(`/proc/${this.pid}/cwd`);
      } catch {
        return null;
      }
    }
    if (process.platform !== 'darwin') return null;

    return new Promise((resolve) => {
      // `lsof` is the supported way to inspect another process's cwd on
      // macOS. execFile keeps the numeric pid out of shell interpolation.
      execFile(
        'lsof',
        ['-a', '-d', 'cwd', '-p', String(this.pid), '-Fn'],
        { timeout: 1_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const cwd = stdout
            .split(/\r?\n/)
            .find((line) => line.startsWith('n'))
            ?.slice(1);
          resolve(cwd || null);
        },
      );
    });
  }

  pause(): void {
    this.paused = true;
    this.pty.pause();
    if (process.platform === 'win32' || this.pauseWatch) return;
    // node-pty may destroy a paused socket 200 ms after child exit, before
    // publishing onExit. Check only the owned child; never signal a census PID.
    const epoch = ++this.pauseEpoch;
    let delay = 50;
    const check = () => {
      // kill(pid, 0) succeeds for zombies and macOS E (exiting) children.
      execFile(
        'ps',
        ['-p', String(this.pid), '-o', 'stat='],
        { timeout: 500, maxBuffer: 4096, windowsHide: true },
        (error, stdout, stderr) => {
          if (epoch !== this.pauseEpoch || !this.paused) return;
          // ps exits 1 with no output when the selected PID no longer exists.
          const gone =
            error?.code === 1 &&
            !error.killed &&
            !error.signal &&
            !stdout.trim() &&
            !stderr.trim();
          if (gone || (!error && /[ZE]/.test(stdout.trim()))) {
            this.outputIncomplete = true;
            this.resume();
            return;
          }
          // Failed observations are unknown, never permission to bypass pressure.
          delay = Math.min(delay * 2, 1000);
          this.pauseWatch = setTimeout(check, delay);
          this.pauseWatch.unref();
        },
      );
    };
    this.pauseWatch = setTimeout(check, delay);
    this.pauseWatch.unref();
  }
  resume(): void {
    this.pauseEpoch++;
    clearTimeout(this.pauseWatch);
    this.pauseWatch = undefined;
    this.paused = false;
    this.pty.resume();
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.pty.kill(signal);
  }

  onData(cb: (data: string) => void): () => void {
    const disposable = this.pty.onData(cb);
    return () => disposable.dispose();
  }

  onExit(
    cb: (event: {
      exitCode: number;
      signal: number | null;
      outputIncomplete?: boolean;
    }) => void,
  ): () => void {
    const disposable = this.pty.onExit(({ exitCode, signal }) =>
      cb({
        exitCode,
        signal: signal ?? null,
        outputIncomplete: this.outputIncomplete,
      }),
    );
    return () => disposable.dispose();
  }
}

export class NodePtyAdapter implements IPtyAdapter {
  /**
   * Test seam: production always uses the module-cached `getNodePty`, so one
   * failed native load degrades every adapter instance identically.
   */
  constructor(
    private readonly loadNodePty: () => Promise<
      typeof import('node-pty')
    > = getNodePty,
  ) {}

  /**
   * Loads the native module or converts its rejection into the one specific,
   * actionable degraded-terminal error (#1244). A missing or unbuildable
   * node-pty must never surface as a generic spawn failure.
   */
  private async requireNodePty(): Promise<typeof import('node-pty')> {
    try {
      return await this.loadNodePty();
    } catch (error) {
      throw new PtyUnavailableError(
        terminalPtyUnavailableReason(describeTerminalPtyLoadFailure(error)),
      );
    }
  }

  async probeCapability(): Promise<TerminalCapability> {
    try {
      await this.requireNodePty();
      return { state: 'available' };
    } catch (error) {
      return {
        state: 'unavailable',
        reason:
          error instanceof PtyUnavailableError
            ? error.message
            : terminalPtyUnavailableReason(
                describeTerminalPtyLoadFailure(error),
              ),
      };
    }
  }

  async spawn(input: {
    shell: string;
    args?: string[];
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }): Promise<IPtyProcess> {
    const nodePty = await this.requireNodePty();
    const name =
      process.platform === 'win32' ? 'xterm-color' : 'xterm-256color';
    const launch = prepareChildWorkload(
      input.shell,
      input.args ?? [],
      input.env,
    );
    let pty: import('node-pty').IPty;
    try {
      pty = nodePty.spawn(
        launch?.command ?? input.shell,
        launch?.args ?? input.args ?? [],
        {
          name,
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          env: (launch?.env ?? input.env) as Record<string, string>,
        },
      );
    } catch (error) {
      await launch?.close();
      throw error;
    }
    trackChildWorkload(launch, pty.pid);
    pty.onExit(() => {
      void closeChildWorkload(pty.pid).catch((error) =>
        logger.warn('Terminal workload cleanup failed', { error }),
      );
    });
    return new NodePtyProcess(pty);
  }
}
