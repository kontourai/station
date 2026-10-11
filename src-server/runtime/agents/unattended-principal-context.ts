import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnattendedPrincipal } from '../types.js';

/**
 * The principals a server-owned owner establishes around an invocation it
 * started: the scheduler for a job, the Automation dispatcher for a rule.
 * Voice and delegated-child principals reach the InvocationContext through
 * their own paths and are deliberately not accepted here.
 */
export type ContextualUnattendedPrincipal = Extract<
  UnattendedPrincipal,
  { kind: 'scheduled-job' } | { kind: 'automation-rule' }
>;

/**
 * Internal runtime context for unattended execution. The owner supplies the
 * server-issued identity (job id or rule id); neither HTTP nor a
 * caller-supplied agent option can manufacture this context. Framework
 * lifecycle hooks read it only while the runtime adapter invokes the
 * selected agent.
 */
type UnattendedInvocation = {
  principal: ContextualUnattendedPrincipal;
  /** Receipt correlation only; deliberately not part of the grant key. */
  runId: string;
};

const unattendedPrincipalContext =
  new AsyncLocalStorage<UnattendedInvocation>();

export function runWithUnattendedPrincipal<T>(
  principal: ContextualUnattendedPrincipal,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  return unattendedPrincipalContext.run({ principal, runId }, work);
}

export function currentUnattendedPrincipal(): UnattendedPrincipal | undefined {
  return unattendedPrincipalContext.getStore()?.principal;
}

export function currentUnattendedRunId(): string | undefined {
  return unattendedPrincipalContext.getStore()?.runId;
}
