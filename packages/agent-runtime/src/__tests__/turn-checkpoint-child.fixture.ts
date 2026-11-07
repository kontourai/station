import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const { path, dev, ino } = z
  .object({ path: z.string(), dev: z.number(), ino: z.number() })
  .parse(JSON.parse(process.argv[2]!));
const current = statSync(path);
if (current.dev !== dev || current.ino !== ino)
  throw new Error('DURABLE_AGENT_CHECKPOINT_FILE_CHANGED');
const database = new DatabaseSync(path);
try {
  database.exec(
    'PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0',
  );
  const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  process.send?.(result?.busy === 0 ? null : 'DURABLE_AGENT_CHECKPOINT_BUSY');
} catch (error) {
  process.send?.(
    error instanceof Error ? error.message : 'DURABLE_AGENT_CHECKPOINT_FAILED',
  );
} finally {
  database.close();
  process.disconnect?.();
}
