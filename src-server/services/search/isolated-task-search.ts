import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchProvider,
  type UnifiedSearchProviderPage,
  type UnifiedSearchProviderRequest,
} from '@kontourai/station-contracts/unified-search';
import {
  boundedTaskText,
  TASK_SEARCH_LIMITS,
  taskReadRequest,
} from './task-search-protocol.js';
import { parseUnifiedSearchProviderPage } from './unified-search-service.js';

type Phase = 'idle' | 'running' | 'retiring' | 'incomplete' | 'closed';
export interface IsolatedTaskSearch {
  readonly provider: UnifiedSearchProvider;
  /** No queue. Retiring/incomplete custody continues occupying the sole slot. */
  inspect(): { phase: Phase };
  /** Bounded truthful result; repeated close joins pending cleanup or retries a rejection. */
  close(): Promise<{ state: 'closed' | 'winding-down' | 'incomplete' }>;
}

/** Implementation-only fault seams. Not a runtime/plugin module selection API. */
export interface TaskSearchTestOptions {
  workerSourceUrl?: URL;
  deadlineMs?: number;
  terminate?: (worker: Worker) => Promise<number>;
}

const unavailable = (): UnifiedSearchProviderPage => ({
  version: UNIFIED_SEARCH_V1,
  state: 'unavailable',
  reason: 'source-unavailable',
});

/** The TaskGraph owner binds the path once; requests cannot choose files or executable code. */
export function createIsolatedTaskSearch(
  owner: { storePath: string; stationId: string },
  test: TaskSearchTestOptions = {},
): IsolatedTaskSearch {
  if (
    !isAbsolute(owner.storePath) ||
    owner.storePath.length > 4096 ||
    !boundedTaskText(owner.stationId, 256)
  )
    throw new TypeError('Invalid Task read owner');
  const storePath = owner.storePath;
  const stationId = owner.stationId;
  const deadlineMs = test.deadlineMs ?? TASK_SEARCH_LIMITS.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)
    throw new TypeError('Invalid Task deadline');
  const terminate = test.terminate ?? ((worker: Worker) => worker.terminate());
  let closed = false;
  let sequence = 0;
  type Flight = {
    id: number;
    deadline: number;
    limit: number;
    signal?: AbortSignal;
    finish: (page: UnifiedSearchProviderPage) => void;
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
    record.flight?.finish(unavailable());
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
        import.meta.url.endsWith('.ts')
          ? './task-search-worker.ts'
          : './task-search-worker.js',
        import.meta.url,
      );
    const worker = new Worker(source, {
      workerData: { storePath },
      resourceLimits: {
        maxOldGenerationSizeMb: TASK_SEARCH_LIMITS.workerMemoryMb,
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
        if (
          typeof wire !== 'string' ||
          Buffer.byteLength(wire) > TASK_SEARCH_LIMITS.responseBytes
        )
          throw new TypeError('Invalid Task response');
        const reply = JSON.parse(wire);
        if (
          !reply ||
          typeof reply !== 'object' ||
          Array.isArray(reply) ||
          Object.keys(reply).length !== 2 ||
          !Object.hasOwn(reply, 'id') ||
          !Object.hasOwn(reply, 'page')
        )
          throw new TypeError('Invalid Task response');
        // An out-of-generation reply never completes another request.
        if (reply.id !== flight.id) {
          void retire(record);
          return;
        }
        const page = parseUnifiedSearchProviderPage(
          reply.page,
          { kind: 'station', stationId },
          flight.limit,
        );
        if (
          !page ||
          ('results' in page &&
            page.results.some((result) => result.kind !== 'task'))
        )
          throw new TypeError('Invalid Task page');
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
      record.flight?.finish(unavailable());
      if (owned === record) owned = undefined;
    });
    return record;
  }

  async function search(
    request: UnifiedSearchProviderRequest,
    signal?: AbortSignal,
  ): Promise<UnifiedSearchProviderPage> {
    if (closed || signal?.aborted || (owned && owned.phase !== 'idle'))
      return unavailable();
    const payload = taskReadRequest(request, ++sequence);
    if (!payload) return unavailable();
    const wire = JSON.stringify(payload);
    if (Buffer.byteLength(wire) > TASK_SEARCH_LIMITS.requestBytes)
      return unavailable();
    const deadline = performance.now() + deadlineMs;
    let record: OwnedWorker;
    try {
      record = acquire();
    } catch {
      return unavailable();
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
      const finish = (page: UnifiedSearchProviderPage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        record.flight = undefined;
        if (record.phase === 'running') record.phase = 'idle';
        resolve(page);
      };
      record.flight = {
        id: payload.id,
        deadline,
        limit: payload.limit,
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
    provider: {
      descriptor: {
        id: 'station.tasks',
        version: '1.0.0',
        owner: { kind: 'station', stationId },
        kinds: ['task'],
      },
      search,
    },
    inspect: () => ({ phase: owned?.phase ?? (closed ? 'closed' : 'idle') }),
    async close() {
      closed = true;
      if (!owned) return { state: 'closed' };
      const record = owned;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        retire(record),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TASK_SEARCH_LIMITS.closeWaitMs);
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
