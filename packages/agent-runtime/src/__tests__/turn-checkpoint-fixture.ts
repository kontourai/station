import { type ChildProcess, fork } from 'node:child_process';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** Exercise the host port with an independent real SQLite process. */
export function checkpointFixture(database: DatabaseSync) {
  const path = database.location()!;
  const { dev, ino } = statSync(path);
  const jobs = new Set<ChildProcess>();
  const perform = async () => {
    const child = fork(
      fileURLToPath(
        new URL('./turn-checkpoint-child.fixture.ts', import.meta.url),
      ),
      [JSON.stringify({ path, dev, ino })],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        timeout: 30_000,
      },
    );
    jobs.add(child);
    await new Promise<void>((resolve, reject) => {
      let acknowledged = false;
      let failure: Error | undefined;
      child.once('message', (value: unknown) => {
        acknowledged = value === null;
        if (!acknowledged)
          failure = new Error(
            typeof value === 'string'
              ? value
              : 'DURABLE_AGENT_CHECKPOINT_FAILED',
          );
      });
      child.once('error', (error) => {
        failure = error;
      });
      child.once('exit', (code) => {
        jobs.delete(child);
        if (failure) reject(failure);
        else if (code !== 0 || !acknowledged)
          reject(new Error('DURABLE_AGENT_CHECKPOINT_CLOSED'));
        else resolve();
      });
    });
  };
  return {
    run: perform,
    async close() {
      await Promise.all(
        [...jobs].map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once('exit', () => resolve());
              child.kill();
            }),
        ),
      );
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
