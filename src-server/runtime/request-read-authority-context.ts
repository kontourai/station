import { AsyncLocalStorage } from 'node:async_hooks';
import {
  INTERNAL_SESSION_READ_SCOPE,
  type InternalSessionReadScope,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';

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
/** See `runAsStationKnowledgeIndexer`. */
const stationIndexing = new AsyncLocalStorage<true>();

export function runWithRequestReadAuthority<T>(
  authority: SessionReadAuthority,
  run: () => T,
): T {
  // A request scope always leaves any enclosing indexer context: a request
  // nested inside a build must never read with the internal scope.
  return stationIndexing.exit(() => requestAuthorities.run(authority, run));
}

export function currentRequestReadAuthority():
  | SessionReadAuthority
  | undefined {
  return requestAuthorities.getStore();
}

/**
 * Station-internal knowledge indexing (index rebuild, Neo4j sync): the index
 * and graph are shared Station-wide artifacts, so they are built from ALL
 * sessions under the named internal scope, and every read path re-reads each
 * session-backed record as its own caller before showing it. Only the
 * knowledge readers consult this (`currentKnowledgeReadScope`);
 * `currentRequestReadAuthority` never returns it, and a request scope nested
 * inside a build leaves it (`runWithRequestReadAuthority`).
 */
export function runAsStationKnowledgeIndexer<T>(build: () => T): T {
  return stationIndexing.run(true, build);
}

/**
 * The scope a knowledge adapter reads sessions with: all sessions while the
 * Station indexer builds, otherwise the request's own principal (or none).
 */
export function currentKnowledgeReadScope():
  | SessionReadAuthority
  | InternalSessionReadScope
  | undefined {
  return stationIndexing.getStore()
    ? INTERNAL_SESSION_READ_SCOPE
    : requestAuthorities.getStore();
}
