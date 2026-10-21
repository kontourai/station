import { randomUUID } from 'node:crypto';
import { commandDigest } from './decisions.js';
import { hash, RuntimeError } from './encoding.js';
import type {
  ModelContext,
  ModelStorage,
  RunKey,
  RuntimeProjectionSink,
} from './types.js';
export async function drainModelOutbox(
  storage: ModelStorage,
  sink: RuntimeProjectionSink,
  key: RunKey,
  context: ModelContext,
): Promise<void> {
  let page = await storage.execute(
    { type: 'listOutbox', key, limit: 1024 },
    context,
  );
  if (page.kind !== 'listed')
    throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
  const throughPosition = page.throughPosition;
  const seen = new Set<string>();
  if (!Number.isSafeInteger(throughPosition) || throughPosition < -1)
    throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
  if (!page.entries.length) return;
  for (let pages = 0; pages <= throughPosition; pages++) {
    if (page.kind !== 'listed' || page.throughPosition !== throughPosition)
      throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
    if (!page.entries.length) return;
    for (const entry of page.entries) {
      if (seen.has(entry.id) || seen.size >= throughPosition + 1)
        throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
      seen.add(entry.id);
      await sink.apply(entry);
      const fields = {
        type: 'acknowledge' as const,
        key,
        projectionId: entry.id,
        projectionDigest: hash(entry),
        operationId: randomUUID(),
      };
      const ack = await storage.execute(
        { ...fields, digest: commandDigest(fields) },
        context,
      );
      if (ack.kind === 'refused')
        throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
    }
    page = await storage.execute(
      { type: 'listOutbox', key, limit: 1024, throughPosition },
      context,
    );
    if (page.kind !== 'listed' || page.throughPosition !== throughPosition)
      throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
    if (!page.entries.length) return;
  }
  throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
}
