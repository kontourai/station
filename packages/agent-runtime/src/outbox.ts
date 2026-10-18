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
  const listed = await storage.execute(
    { type: 'listOutbox', key, limit: 1024 },
    context,
  );
  if (listed.kind !== 'listed')
    throw new RuntimeError('DURABLE_OUTBOX_UNAVAILABLE');
  for (const entry of listed.entries) {
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
}
