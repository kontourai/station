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
