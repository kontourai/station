import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';

/**
 * The session-read authority of the HTTP request a knowledge-store read runs
 * inside. Knowledge adapters are process singletons reached through
 * `KnowledgeStoreProvider.adapterFor`, which carries no request, so the
 * runtime binds the request principal's authority around every
 * `/api/knowledge` request and an adapter reads it here.
 *
 * Absent (a read outside any request, or a request whose principal could not
 * be resolved) means no one: session-backed records are then not read at
 * all, rather than read as the operator.
 */
const requestAuthorities = new AsyncLocalStorage<SessionReadAuthority>();

export function runWithKnowledgeReadAuthority<T>(
  authority: SessionReadAuthority,
  run: () => T,
): T {
  return requestAuthorities.run(authority, run);
}

export function currentKnowledgeReadAuthority():
  | SessionReadAuthority
  | undefined {
  return requestAuthorities.getStore();
}
