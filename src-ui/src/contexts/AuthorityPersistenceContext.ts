import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { createContext, useContext } from 'react';
import type { AuthorityPersistenceStatus } from '../lib/authorityNamespace';

interface AuthorityPersistenceContextValue {
  status: AuthorityPersistenceStatus;
  /** Verified durable namespace; null while current authority is unverified. */
  namespace: string | null;
  observation: AuthorityObservation | null;
}

export const AuthorityPersistenceContext =
  createContext<AuthorityPersistenceContextValue>({
    status: 'unavailable',
    namespace: null,
    observation: null,
  });

export function useAuthorityPersistence(): AuthorityPersistenceContextValue {
  return useContext(AuthorityPersistenceContext);
}

/**
 * Whether this client may start chats and send turns. The server's pairing
 * route table requires `orchestration:operate` for both (chat creation and
 * turns sit in the `/agents` family's mutating tier), and a paired device
 * without it gets a 403 `insufficient_scope`. A surface uses this to withhold
 * an action that would only fail rather than offering it.
 *
 * `false` only on a POSITIVE observation of a device grant that lacks the
 * scope. An unknown authority (not yet read, unavailable) answers `true`: the
 * server still enforces, and hiding the actions while the observation loads
 * would hide them from operators too.
 */
export function canOperateConversations(
  observation: AuthorityObservation | null,
): boolean {
  const grant = observation?.grant;
  return !(
    grant?.kind === 'device' &&
    !grant.grantedScopes.includes('orchestration:operate')
  );
}

export function useCanOperateConversations(): boolean {
  return canOperateConversations(
    useContext(AuthorityPersistenceContext).observation,
  );
}
