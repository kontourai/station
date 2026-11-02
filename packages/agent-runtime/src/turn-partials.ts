import type { AgentTurnLease } from './turn-runtime.js';
import { agentWire } from './turn-wire.js';

/** Commit bounded prefix batches before making them visible to the framework. */
export async function* journalAgentStreamPrefix<T>(
  lease: AgentTurnLease,
  id: string,
  source: AsyncIterable<T>,
  isSuffix: (part: T) => boolean,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let next = iterator.next();
  let pending: T[] = [];
  let wires: string[] = [];
  let bytes = 0;
  let suffix = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due: Promise<'flush'> | undefined;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    due = undefined;
    if (!pending.length) return [];
    const batch = pending;
    const parts = wires;
    pending = [];
    wires = [];
    bytes = 0;
    await lease.effect({ type: 'effectPartialBatch', id, parts });
    return batch;
  };
  try {
    for (;;) {
      const result = due ? await Promise.race([next, due]) : await next;
      if (result === 'flush') {
        yield* await flush();
        continue;
      }
      if (result.done) break;
      const part = result.value;
      next = iterator.next();
      // Observe rejection while a committed batch is being delivered.
      void next.catch(() => {});
      if (suffix || isSuffix(part)) {
        suffix = true;
        yield* await flush();
        yield part;
        continue;
      }
      const wire = agentWire(part);
      pending.push(part);
      wires.push(wire);
      bytes += Buffer.byteLength(wire);
      if (!due)
        due = new Promise((resolve) => {
          timer = setTimeout(() => resolve('flush'), 16);
        });
      if (pending.length >= 128 || bytes >= 64 * 1024) yield* await flush();
    }
    yield* await flush();
  } finally {
    if (timer) clearTimeout(timer);
    await iterator.return?.();
  }
}
