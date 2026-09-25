import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';

/**
 * The session-read authority of the HTTP request a process-singleton reader
 * runs inside. Some readers (knowledge-store adapters reached through
 * `KnowledgeStoreProvider.adapterFor`, Starter Work's inspection owners) are
 * built once and called with no request, so the runtime binds the request
 * principal's authority around their routes and the reader looks it up here.
 *
 * Absent (a read outside any request, or a request whose principal could not
 * be resolved) means no one: session-backed data is then not read at all,
 * rather than read as the operator.
 */
const requestAuthorities = new AsyncLocalStorage<SessionReadAuthority>();

export function runWithRequestReadAuthority<T>(
  authority: SessionReadAuthority,
  run: () => T,
): T {
  return requestAuthorities.run(authority, run);
}

export function currentRequestReadAuthority():
  | SessionReadAuthority
  | undefined {
  return requestAuthorities.getStore();
}
