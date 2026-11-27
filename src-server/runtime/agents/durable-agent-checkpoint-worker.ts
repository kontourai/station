import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';

const { path, dev, ino } = z
  .object({ path: z.string(), dev: z.number(), ino: z.number() })
  .parse(workerData);
const identity = () => {
  const current = statSync(path);
  if (current.dev !== dev || current.ino !== ino)
    throw new Error('DURABLE_AGENT_CHECKPOINT_FILE_CHANGED');
};
identity();
const database = new DatabaseSync(path);
identity();
database.exec(
  'PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0',
);
try {
  identity();
  const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (result?.busy !== 0) throw new Error('DURABLE_AGENT_CHECKPOINT_BUSY');
  parentPort?.postMessage(null);
} catch (error) {
  parentPort?.postMessage(
    error instanceof Error ? error.message : 'DURABLE_AGENT_CHECKPOINT_FAILED',
  );
} finally {
  database.close();
  parentPort?.close();
}
