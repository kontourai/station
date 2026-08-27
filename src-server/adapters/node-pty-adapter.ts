import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IPtyAdapter, IPtyProcess } from '../domain/pty-adapter.js';

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
          console.debug('Failed to chmod spawn-helper:', p, e);
        }
      }
    }
  } catch (e) {
    console.debug('Failed to fix node-pty spawn-helper permissions:', e);
  }
}

function getNodePty(): Promise<typeof import('node-pty')> {
  if (!nodePtyPromise) {
    ensureSpawnHelper();
    nodePtyPromise = import('node-pty');
  }
  return nodePtyPromise;
}

class NodePtyProcess implements IPtyProcess {
  constructor(private pty: import('node-pty').IPty) {}

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
    cb: (event: { exitCode: number; signal: number | null }) => void,
  ): () => void {
    const disposable = this.pty.onExit(({ exitCode, signal }) =>
      cb({ exitCode, signal: signal ?? null }),
    );
    return () => disposable.dispose();
  }
}

export class NodePtyAdapter implements IPtyAdapter {
  async spawn(input: {
    shell: string;
    args?: string[];
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }): Promise<IPtyProcess> {
    const nodePty = await getNodePty();
    const name =
      process.platform === 'win32' ? 'xterm-color' : 'xterm-256color';
    const pty = nodePty.spawn(input.shell, input.args ?? [], {
      name,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: input.env as Record<string, string>,
    });
    return new NodePtyProcess(pty);
  }
}
