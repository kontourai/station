import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function createWindowsReadinessReader(options: {
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  command: string;
  args: string[];
  taskkill: string;
  timeoutMs: number;
}) {
  let worker: ChildProcess | undefined;
  let closed = false;
  let sequence = 0;
  let output = '';
  let deadline: ReturnType<typeof setTimeout> | undefined;
  type Batch = {
    promise: Promise<string | null>;
    resolve: (content: string | null) => void;
  };
  let active: Batch | undefined;
  let queued: Batch | undefined;
  const batch = (): Batch => {
    let resolve!: Batch['resolve'];
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const stop = () => {
    const child = worker;
    worker = undefined;
    output = '';
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    active?.resolve(null);
    queued?.resolve(null);
    active = queued = undefined;
    if (!child || child.exitCode !== null) return;
    child.stdin?.destroy();
    if (child.pid) {
      const killer = options.spawn(
        options.taskkill,
        ['/PID', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5_000,
        },
      );
      killer.once('error', () => child.kill());
      killer.once('exit', (code) => {
        if (code !== 0) child.kill();
      });
      killer.unref();
    }
  };
  const start = () => {
    if (!active || closed) return;
    try {
      if (!worker) {
        const child = options.spawn(options.command, options.args, {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        worker = child;
        child.stdin?.on('error', () => {
          if (worker === child) stop();
        });
        child.once('error', () => {
          if (worker === child) stop();
        });
        child.once('exit', () => {
          if (worker === child) stop();
        });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          if (worker !== child) return;
          output += chunk;
          if (output.length > 1_048_576) {
            stop();
            return;
          }
          const newline = output.indexOf('\n');
          if (newline < 0) return;
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            const result = JSON.parse(line);
            if (
              !active ||
              result.sequence !== String(sequence) ||
              output.trim()
            ) {
              stop();
              return;
            }
            if (deadline) clearTimeout(deadline);
            deadline = undefined;
            const completed = active;
            active = queued;
            queued = undefined;
            completed.resolve(
              result.trusted === true && typeof result.content === 'string'
                ? result.content
                : null,
            );
            if (active) start();
          } catch {
            stop();
          }
        });
      }
      sequence += 1;
      deadline = setTimeout(stop, options.timeoutMs);
      worker.stdin?.write(`${sequence}\n`);
    } catch {
      stop();
    }
  };
  return {
    read(): Promise<string | null> {
      if (closed) return Promise.resolve(null);
      if (active) {
        queued ??= batch();
        return queued.promise;
      }
      active = batch();
      const promise = active.promise;
      start();
      return promise;
    },
    close() {
      closed = true;
      stop();
    },
  };
}
