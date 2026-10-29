import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../infra/process-utils.js';

export class MediaProcessError extends Error {
  constructor(
    readonly reason: 'timeout' | 'aborted' | 'output-limit' | 'exit',
    message: string,
  ) {
    super(message);
  }
}

/** One owned process group, with a bounded combined output and wall-clock deadline. */
export function runMediaProcess(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    cwd?: string;
  },
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted)
    return Promise.reject(
      new MediaProcessError('aborted', 'Media operation aborted.'),
    );
  return new Promise((resolve, reject) => {
    const { proc, release } = spawnOwnedChild(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    };
    const stop = (error: Error) => {
      if (settled) return;
      // Wait for group termination before the caller removes temporary files.
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      void terminateProcessTree(proc, {
        graceMs: 0,
        killConfirmMs: 1_000,
      }).then(
        () => {
          release();
          reject(error);
        },
        (terminationError: unknown) => {
          reject(
            new Error(
              `Media process termination failed: ${String(terminationError)}`,
              { cause: error },
            ),
          );
        },
      );
    };
    const abort = () =>
      stop(new MediaProcessError('aborted', 'Media operation aborted.'));
    const timer = setTimeout(
      () =>
        stop(new MediaProcessError('timeout', 'Media operation timed out.')),
      Math.max(1, options.timeoutMs),
    );
    const capture = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > (options.maxOutputBytes ?? 1024 * 1024)) {
        stop(
          new MediaProcessError(
            'output-limit',
            'Media process exceeded its output limit.',
          ),
        );
      } else chunks.push(chunk);
    };
    proc.stdout?.on('data', capture(stdout));
    proc.stderr?.on('data', capture(stderr));
    proc.stdout?.on('error', () => {});
    proc.stderr?.on('error', () => {});
    proc.once('error', (error) => {
      release();
      finish(error);
    });
    proc.once('exit', () => release());
    proc.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new MediaProcessError(
              'exit',
              `Media process exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`,
            ),
      ),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
