import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export function createWindowsCommandGuardResolver(options: {
  sourceDirectory: string;
  fallbackDirectory?: string;
  stagedGuard: string | null;
}) {
  let resolved: Promise<string | null> | undefined;
  return (signal?: AbortSignal) => {
    resolved ??= (async () => {
      if (options.stagedGuard) return options.stagedGuard;
      const fs = process.getBuiltinModule('fs');
      const files = fs.promises;
      const path = process.getBuiltinModule('path');
      const { tmpdir } = process.getBuiltinModule('os');
      const { execFile } = process.getBuiltinModule('child_process');
      let source: string | undefined;
      for (const from of [options.sourceDirectory, options.fallbackDirectory]) {
        if (!from || source) continue;
        let directory = from;
        for (let depth = 0; depth < 8; depth++) {
          const candidate = path.join(
            directory,
            'scripts',
            'windows-owned-guard.cs',
          );
          if (fs.existsSync(candidate)) {
            source = candidate;
            break;
          }
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
      if (!source) return null;
      const sourceFile = source;
      const scratch = await files.mkdtemp(
        path.join(tmpdir(), 'station-command-guard-'),
      );
      process.once('exit', () => {
        try {
          fs.rmSync(scratch, { recursive: true, force: true });
        } catch {}
      });
      const staged = path.join(scratch, 'guard.partial.exe');
      const output = path.join(scratch, 'station-windows-owned-guard.exe');
      const compiler = path.join(
        process.env.WINDIR ?? 'C:\\Windows',
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      await new Promise<void>((resolve, reject) => {
        execFile(
          compiler,
          ['/nologo', '/target:exe', `/out:${staged}`, sourceFile],
          { encoding: 'utf8', timeout: 120_000, windowsHide: true, signal },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await files.rename(staged, output);
      return output;
    })();
    return resolved;
  };
}

export type WindowsOwnedWorker = {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly settled: Promise<boolean>;
  stop(): Promise<boolean>;
};

export function createWindowsOwnedWorkerLauncher(options: {
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  resolveGuard: (signal?: AbortSignal) => Promise<string | null>;
  timeoutMs: number;
}) {
  let owner: Promise<{ guard: string; birth: string }> | undefined;
  return async (
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<WindowsOwnedWorker> => {
    signal?.throwIfAborted();
    owner ??= (async () => {
      const guard = await options.resolveGuard(signal);
      signal?.throwIfAborted();
      if (!guard) throw new Error('No Station Job guard is available');
      const { execFile } = process.getBuiltinModule('child_process');
      const birth = await new Promise<string>((resolve, reject) => {
        execFile(
          guard,
          ['--identity', String(process.pid)],
          { encoding: 'utf8', timeout: 30_000, windowsHide: true, signal },
          (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
        );
      });
      if (!birth) throw new Error('The Job guard reported no owner identity');
      return { guard, birth };
    })();
    const { guard, birth } = await owner;
    signal?.throwIfAborted();
    const quote = (argument: string) => {
      let quoted = '"';
      let backslashes = 0;
      for (const character of argument) {
        if (character === '\\') {
          backslashes++;
          continue;
        }
        quoted +=
          character === '"'
            ? `${'\\'.repeat(backslashes * 2 + 1)}"`
            : '\\'.repeat(backslashes) + character;
        backslashes = 0;
      }
      return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
    };
    const { Duplex } = process.getBuiltinModule('stream');
    const child = options.spawn(
      guard,
      [
        '--session',
        String(process.pid),
        birth,
        command,
        [command, ...args].map(quote).join(' '),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const pipe = (fd: number) => child.stdio[fd];
    const input = pipe(5);
    const output = pipe(3);
    let ended = false;
    let stopping: Promise<boolean> | undefined;
    let buffer = '';
    let boundPid: number | undefined;
    let closed = false;
    let finish!: (result: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let retirementDeadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopping ??= (async () => {
        if (!closed) {
          try {
            child.stdin?.write('ABORT\n');
          } catch {
            child.stdin?.destroy();
          }
          retirementDeadline = setTimeout(() => {
            child.kill();
            retirementDeadline = setTimeout(() => finish(false), 5_000);
          }, 5_000);
        }
        return settled;
      })();
      return stopping;
    };
    const abort = () => {
      void stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin?.on('error', () => child.stdin?.destroy());
    child.stderr?.resume();
    if (child.stdio[4] instanceof Duplex) child.stdio[4].resume();
    child.once('close', (code) => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      if (retirementDeadline) clearTimeout(retirementDeadline);
      finish(ended && code === 0);
    });
    const started = new Promise<number>((resolve, reject) => {
      void settled.then(() =>
        reject(new Error('The Job guard did not establish worker custody')),
      );
      child.once('error', reject);
      child.once('close', () =>
        reject(new Error('The Job guard exited before binding')),
      );
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4096) {
          reject(new Error('The Job guard exceeded its control output bound'));
          void stop();
          return;
        }
        for (
          let newline = buffer.indexOf('\n');
          newline >= 0;
          newline = buffer.indexOf('\n')
        ) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          const binding = /^BOUND (\d+) \S+$/.exec(line);
          if (
            binding &&
            boundPid === undefined &&
            !stopping &&
            !signal?.aborted
          ) {
            boundPid = Number(binding[1]);
            child.stdin?.write('RESUME\n');
            resolve(boundPid);
          } else if (line === 'ENDED') ended = true;
          else if (/^EXIT \d+$/.test(line)) void stop();
        }
      });
    });
    const startupDeadline = setTimeout(() => {
      void stop();
    }, options.timeoutMs);
    if (signal?.aborted) void stop();
    try {
      const pid = await started;
      if (!(input instanceof Duplex) || !(output instanceof Duplex))
        throw new Error('The Job guard has no worker pipes');
      return { pid, stdin: input, stdout: output, settled, stop };
    } catch (error) {
      await stop();
      throw error;
    } finally {
      clearTimeout(startupDeadline);
    }
  };
}
