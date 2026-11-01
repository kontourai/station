import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { isSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { UsageTaskOutcome } from '@kontourai/station-contracts/usage-rollup';
import {
  type UsageRollupReadAuthority,
  type UsageTaskOutcomeSource,
  usageTaskOutcomeKey,
} from './usage-rollup-service.js';

type Outcome =
  | {
      state: 'available';
      taskCreatedAt: string;
      status: Extract<UsageTaskOutcome, { state: 'available' }>['status'];
    }
  | { state: 'restricted' | 'unavailable' };
/** Request-local projection over canonical local Tasks; peer identities never reach the local lookup. */
export class LocalTaskOutcomeSource implements UsageTaskOutcomeSource {
  private releaseCheck?: () => Promise<boolean>;

  async isCurrent(): Promise<boolean> {
    try {
      return this.releaseCheck
        ? await this.releaseCheck()
        : await this.current();
    } catch {
      return false;
    }
  }
  constructor(
    private readonly localStationId: string,
    private readonly tasks: () => readonly Pick<
      TaskRecord,
      'id' | 'projectId' | 'createdAt' | 'status'
    >[],
    private readonly authorizeTask: (
      task: Pick<TaskRecord, 'id' | 'projectId' | 'createdAt'>,
      authority: UsageRollupReadAuthority,
    ) => Promise<boolean>,
    private readonly current: () => boolean | Promise<boolean>,
  ) {}
  async read(
    tasks: readonly { stationId: string; taskId: string }[],
    authority: UsageRollupReadAuthority,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Outcome>> {
    if (
      !isSessionReadAuthority(authority) ||
      signal.aborted ||
      !(await this.current())
    )
      throw new Error('Task outcome read denied');
    const wanted = tasks.filter(
      (task) => task.stationId === this.localStationId,
    );
    if (wanted.length === 0) return new Map();
    const canonical = new Map(
      this.tasks().map(
        (task) =>
          [
            task.id,
            {
              id: task.id,
              projectId: task.projectId,
              createdAt: task.createdAt,
              status: task.status,
            },
          ] as const,
      ),
    );
    const admitted = new Map<string, boolean>();
    for (const task of wanted) {
      const record = canonical.get(task.taskId);
      if (record)
        admitted.set(record.id, await this.authorizeTask(record, authority));
    }
    const result = new Map<string, Outcome>();
    for (const task of wanted) {
      const record = canonical.get(task.taskId);
      if (record && admitted.get(record.id))
        admitted.set(record.id, await this.authorizeTask(record, authority));
    }
    if (signal.aborted || !(await this.current()))
      throw new Error('Task outcome authority changed');
    const currentTasks = new Map(
      this.tasks().map(
        (task) =>
          [
            task.id,
            {
              id: task.id,
              projectId: task.projectId,
              createdAt: task.createdAt,
              status: task.status,
            },
          ] as const,
      ),
    );
    for (const task of wanted) {
      const record = currentTasks.get(task.taskId);
      const original = canonical.get(task.taskId);
      result.set(
        usageTaskOutcomeKey(task.stationId, task.taskId),
        !record ||
          record.projectId !== original?.projectId ||
          record.createdAt !== original?.createdAt
          ? { state: 'unavailable' }
          : admitted.get(record.id)
            ? {
                state: 'available',
                taskCreatedAt: record.createdAt,
                status: record.status,
              }
            : { state: 'restricted' },
      );
    }
    const delivered = [...currentTasks.values()].filter(
      (task) =>
        result.get(usageTaskOutcomeKey(this.localStationId, task.id))?.state ===
        'available',
    );
    const same = (
      before: (typeof delivered)[number],
      live: (typeof delivered)[number] | undefined,
    ) =>
      live?.projectId === before.projectId &&
      live.createdAt === before.createdAt &&
      live.status === before.status;
    this.releaseCheck = async () => {
      if (signal.aborted || !(await this.current())) return false;
      const live = new Map(this.tasks().map((task) => [task.id, task]));
      for (const task of delivered)
        if (
          !same(task, live.get(task.id)) ||
          !(await this.authorizeTask(task, authority))
        )
          return false;
      if (signal.aborted || !(await this.current())) return false;
      const final = new Map(this.tasks().map((task) => [task.id, task]));
      return delivered.every((task) => same(task, final.get(task.id)));
    };
    return result;
  }
}
