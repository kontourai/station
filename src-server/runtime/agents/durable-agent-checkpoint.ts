import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

/** Station owns background execution; the agent-runtime package receives only the port. */
export function durableAgentCheckpoint(database: DatabaseSync) {
  const path = database.location()!;
  const { dev, ino } = statSync(path);
  const jobs = new Set<Worker>();
  let closed = false;
  const perform = async () => {
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './durable-agent-checkpoint-worker.ts'
          : './durable-agent-checkpoint-worker.js',
        import.meta.url,
      ),
      { workerData: { path, dev, ino } },
    );
    jobs.add(worker);
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      let acknowledged = false;
      worker.once('message', (value: unknown) => {
        acknowledged = value === null;
        if (!acknowledged)
          failure = new Error(
            typeof value === 'string'
              ? value
              : 'DURABLE_AGENT_CHECKPOINT_FAILED',
          );
      });
      worker.once('error', (error) => {
        failure = error;
      });
      worker.once('exit', (code) => {
        jobs.delete(worker);
        if (failure) reject(failure);
        else if (code !== 0 || !acknowledged)
          reject(new Error('DURABLE_AGENT_CHECKPOINT_CLOSED'));
        else resolve();
      });
    });
  };
  return {
    async run() {
      if (closed) throw new Error('DURABLE_AGENT_CHECKPOINT_CLOSED');
      await perform();
      if (closed) throw new Error('DURABLE_AGENT_CHECKPOINT_CLOSED');
    },
    async close() {
      closed = true;
      await Promise.all([...jobs].map((worker) => worker.terminate()));
      if (
        !database.isOpen ||
        !statSync(`${path}-wal`, { throwIfNoEntry: false })?.size
      )
        return;
      try {
        await perform();
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            error.message === 'DURABLE_AGENT_CHECKPOINT_BUSY'
          )
        )
          throw error;
      }
    },
  };
}
