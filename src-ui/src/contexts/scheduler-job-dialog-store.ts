import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import type { NewChatSetupAuthority } from '../components/modals/useNewChatSetupReturn';
import type { JobFormPrefill } from '../components/scheduler/JobFormModal';

export type SchedulerJobDialogRequest = {
  epoch: number;
  authority: NonNullable<NewChatSetupAuthority>;
  job?: SchedulerJob;
  prefill?: JobFormPrefill;
};
let request: SchedulerJobDialogRequest | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
export const schedulerJobDialogStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => request,
  open(next: Omit<SchedulerJobDialogRequest, 'epoch'>) {
    if (!next.authority.isCurrent()) return;
    request = { ...next, epoch: ++epoch };
    notify();
  },
  close(expected: SchedulerJobDialogRequest) {
    if (request !== expected) return;
    request = null;
    notify();
  },
};
