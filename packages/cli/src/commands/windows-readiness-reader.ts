import type { WindowsOwnedWorker } from '@kontourai/station-shared/windows-command-guard';

export function createWindowsReadinessReader(options: {
  launch: () => Promise<WindowsOwnedWorker>;
  timeoutMs: number;
}) {
  let worker: WindowsOwnedWorker | undefined;
  let starting: Promise<WindowsOwnedWorker> | undefined;
  let retiring: Promise<void> | undefined;
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
  const stop = (): Promise<void> => {
    if (retiring) return retiring;
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    retiring = (async () => {
      try {
        const child = worker ?? (await starting);
        if (child && !(await child.stop())) closed = true;
      } catch {
        closed = true;
      } finally {
        worker = undefined;
        starting = undefined;
        output = '';
      }
    })();
    void retiring.then(() => {
      retiring = undefined;
      active?.resolve(null);
      queued?.resolve(null);
      active = queued = undefined;
    });
    return retiring;
  };
  const start = async () => {
    if (!active || closed || retiring) return;
    deadline = setTimeout(() => {
      void stop();
    }, options.timeoutMs);
    try {
      if (!worker) {
        starting = options.launch();
        const child = await starting;
        worker = child;
        if (closed || retiring) return;
        child.stdin.on('error', () => {
          if (worker === child) void stop();
        });
        void child.settled.then(() => {
          if (worker === child) void stop();
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (worker !== child || retiring) return;
          output += chunk;
          if (output.length > 1_048_576) {
            void stop();
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
              void stop();
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
            if (active) void start();
          } catch {
            void stop();
          }
        });
      }
      sequence += 1;
      worker.stdin.write(`${sequence}\n`);
    } catch {
      void stop();
    }
  };
  return {
    read(): Promise<string | null> {
      if (closed || retiring) return Promise.resolve(null);
      if (active) {
        queued ??= batch();
        return queued.promise;
      }
      active = batch();
      const promise = active.promise;
      void start();
      return promise;
    },
    close(): Promise<void> {
      closed = true;
      return stop();
    },
  };
}
