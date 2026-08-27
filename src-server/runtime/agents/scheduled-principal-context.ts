import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnattendedPrincipal } from '../types.js';

/**
 * Internal runtime context for scheduler execution.  The scheduler owns the
 * server-issued job identity; neither HTTP nor a caller-supplied agent option
 * can manufacture this context.  Framework lifecycle hooks read it only
 * while the runtime adapter invokes the selected agent.
 */
type ScheduledInvocation = {
  principal: Extract<UnattendedPrincipal, { kind: 'scheduled-job' }>;
  /** Receipt correlation only; deliberately not part of the grant key. */
  runId: string;
};

const scheduledPrincipalContext = new AsyncLocalStorage<ScheduledInvocation>();

export function runWithScheduledPrincipal<T>(
  principal: Extract<UnattendedPrincipal, { kind: 'scheduled-job' }>,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  return scheduledPrincipalContext.run({ principal, runId }, work);
}

export function currentScheduledPrincipal(): UnattendedPrincipal | undefined {
  return scheduledPrincipalContext.getStore()?.principal;
}

export function currentScheduledRunId(): string | undefined {
  return scheduledPrincipalContext.getStore()?.runId;
}
