import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';

type Phase = 'idle' | 'running' | 'retiring' | 'incomplete' | 'closed';
export interface OwnedSearchReadWorker {
  /** Only fixed built-in adapters supply these bounded encoders/decoders; neither crosses the port. */
  execute<T>(
    encode: (id: number) => string | null,
    decode: (value: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<T | null>;
  /** No queue. Retiring/incomplete custody continues occupying the sole slot. */
  inspect(): { phase: Phase };
  /** Bounded truthful result; repeated close joins pending cleanup or retries a rejection. */
  close(): Promise<{ state: 'closed' | 'winding-down' | 'incomplete' }>;
}

/** Implementation-only fault seams. Not a runtime/plugin module selection API. */
export interface OwnedSearchReadWorkerTestOptions {
  workerSourceUrl?: URL;
  deadlineMs?: number;
  terminate?: (worker: Worker) => Promise<number>;
}

/**
 * Private lifecycle shared by two fixed first-party read operations. This is
 * not a plugin executor: kind selects a compiled worker, never caller code.
 */
export function createOwnedSearchReadWorker(
  owner: { kind: 'task' | 'transcript'; path: string },
  test: OwnedSearchReadWorkerTestOptions = {},
): OwnedSearchReadWorker {
  if (!isAbsolute(owner.path) || owner.path.length > 4096)
    throw new TypeError('Invalid read owner');
  const path = owner.path;
  const kind = owner.kind;
  if (kind !== 'task' && kind !== 'transcript')
    throw new TypeError('Unknown read operation');
  const requestBytes = 2048;
  const responseBytes = kind === 'task' ? 20 * 1024 : 64 * 1024;
  const resultKey = kind === 'task' ? 'page' : 'result';
  const deadlineMs = test.deadlineMs ?? 2000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new TypeError('Invalid read deadline');
  const terminate = test.terminate ?? ((worker: Worker) => worker.terminate());
  let closed = false;
  let sequence = 0;
  type Flight = {
    id: number;
    deadline: number;
    decode: (value: unknown) => unknown | null;
    signal?: AbortSignal;
    finish: (page: unknown) => void;
  };
  type OwnedWorker = {
    worker: Worker;
    phase: 'idle' | 'running' | 'retiring' | 'incomplete';
    flight?: Flight;
    termination?: Promise<void>;
    exited: boolean;
  };
  let owned: OwnedWorker | undefined;

  function retire(record: OwnedWorker) {
    if (record.exited) return Promise.resolve();
    if (record.termination) return record.termination;
    record.phase = 'retiring';
    record.flight?.finish(null);
    // Capture the single cleanup promise before invoking an injected terminator.
    const settlement = Promise.resolve()
      .then(() => terminate(record.worker))
      .then(
        () => {
          record.exited = true;
          if (owned === record) owned = undefined;
        },
        () => {
          if (!record.exited) record.phase = 'incomplete';
          record.termination = undefined; // Only a genuinely settled rejection may retry.
        },
      );
    record.termination = settlement;
    return settlement;
  }

  function acquire(): OwnedWorker {
    if (owned) return owned;
    const source =
      test.workerSourceUrl ??
      new URL(
        `./${kind === 'task' ? 'task' : 'transcript'}-search-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
        import.meta.url,
      );
    const worker = new Worker(source, {
      workerData:
        kind === 'task' ? { storePath: path } : { databasePath: path },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
      },
      // Do not inherit eval/debug flags (e.g. --input-type) into a file entry.
      execArgv: source.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
    });
    const record: OwnedWorker = { worker, phase: 'idle', exited: false };
    owned = record;
    worker.on('message', (wire: unknown) => {
      if (owned !== record || record.phase !== 'running' || !record.flight)
        return;
      const flight = record.flight;
      if (flight.signal?.aborted || performance.now() >= flight.deadline) {
        void retire(record);
        return;
      }
      try {
        if (typeof wire !== 'string' || Buffer.byteLength(wire) > responseBytes)
          throw new TypeError('Invalid Task response');
        const reply = JSON.parse(wire);
        if (
          !reply ||
          typeof reply !== 'object' ||
          Array.isArray(reply) ||
          Object.keys(reply).length !== 2 ||
          !Object.hasOwn(reply, 'id') ||
          !Object.hasOwn(reply, resultKey)
        )
          throw new TypeError('Invalid Task response');
        // An out-of-generation reply never completes another request.
        if (reply.id !== flight.id) {
          void retire(record);
          return;
        }
        const page = flight.decode(reply[resultKey]);
        if (page === null) throw new TypeError('Invalid read result');
        if (flight.signal?.aborted || performance.now() >= flight.deadline) {
          void retire(record);
          return;
        }
        flight.finish(page);
      } catch {
        void retire(record);
      }
    });
    worker.on('error', () => {
      void retire(record);
    });
    worker.on('exit', () => {
      record.exited = true;
      record.flight?.finish(null);
      if (owned === record) owned = undefined;
    });
    return record;
  }

  async function execute<T>(
    encode: (id: number) => string | null,
    decode: (value: unknown) => T | null,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (closed || signal?.aborted || (owned && owned.phase !== 'idle'))
      return null;
    const id = ++sequence;
    let wire: string | null;
    try {
      wire = encode(id);
    } catch {
      return null;
    }
    if (wire === null || Buffer.byteLength(wire) > requestBytes) return null;
    const deadline = performance.now() + deadlineMs;
    let record: OwnedWorker;
    try {
      record = acquire();
    } catch {
      return null;
    }
    return new Promise((resolve) => {
      record.phase = 'running';
      let settled = false;
      const abort = () => {
        void retire(record);
      };
      const timer = setTimeout(
        abort,
        Math.max(0, deadline - performance.now()),
      );
      const finish = (page: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        record.flight = undefined;
        if (record.phase === 'running') record.phase = 'idle';
        resolve(page as T | null);
      };
      record.flight = {
        id,
        deadline,
        decode,
        signal,
        finish,
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || performance.now() >= deadline) {
        abort();
        return;
      }
      try {
        record.worker.postMessage(wire);
      } catch {
        abort();
      }
    });
  }

  return {
    execute,
    inspect: () => ({ phase: owned?.phase ?? (closed ? 'closed' : 'idle') }),
    async close() {
      closed = true;
      if (!owned) return { state: 'closed' };
      const record = owned;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        retire(record),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 100);
        }),
      ]);
      clearTimeout(timer);
      return {
        state: !owned
          ? 'closed'
          : owned.phase === 'incomplete'
            ? 'incomplete'
            : 'winding-down',
      };
    },
  };
}
