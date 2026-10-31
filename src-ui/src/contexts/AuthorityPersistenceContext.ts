import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { createContext, useContext } from 'react';
import type { AuthorityPersistenceStatus } from '../lib/authorityNamespace';

export interface AuthorityPersistenceContextValue {
  status: AuthorityPersistenceStatus;
  /** Verified durable namespace; null while current authority is unverified. */
  namespace: string | null;
  observation: AuthorityObservation | null;
  /**
   * The Station refused this credential (401): a definite "no person", unlike
   * the other 'unavailable' states (no connection, a native relay account not
   * ready yet). Absent means false.
   */
  refused?: boolean;
  /**
   * Present while the observation failed for a reason other than a refusal:
   * reads it again. The connection health signal calls it on reconnect, since
   * a route-only outage (a VPN dropping while Wi-Fi stays up) fires no
   * browser `online` event for the observation's own reconnect retry.
   */
  reobserve?: () => void;
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

/** Boot capability for the current verified authority activation. */
export interface ClientBootstrapReadiness {
  status: 'pending' | 'settled';
  sharedRealtime: boolean;
  authorityKey?: string;
}

export const ClientBootstrapContext = createContext<ClientBootstrapReadiness>({
  status: 'settled',
  sharedRealtime: false,
});

export function useClientBootstrapReadiness(): ClientBootstrapReadiness {
  return useContext(ClientBootstrapContext);
}
