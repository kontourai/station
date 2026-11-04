import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy';
import { useManagedPolicyStatusQuery } from '@kontourai/station-sdk';
import { createContext, type ReactNode, useContext } from 'react';
import { useApiBase } from './ApiBaseContext';

/**
 * #4518: the managed policy the connected Station loaded, for surfaces that
 * explain a managed control (the approval picker disables modes above the
 * ceiling). `undefined` while it is read, when the host has none, or when the
 * read failed: the server enforces the policy whatever a client shows, so a
 * surface without it offers the control and the server's refusal explains.
 */
export const ManagedPolicyContext = createContext<
  ManagedPolicySummary | undefined
>(undefined);

export function useManagedPolicySummary(): ManagedPolicySummary | undefined {
  return useContext(ManagedPolicyContext);
}

/** Mounted inside the verified authority boundary, beside account preferences. */
export function ManagedPolicyProvider({ children }: { children: ReactNode }) {
  const { apiBase } = useApiBase();
  const status = useManagedPolicyStatusQuery(apiBase);
  return (
    <ManagedPolicyContext.Provider
      value={status.data?.state === 'loaded' ? status.data.summary : undefined}
    >
      {children}
    </ManagedPolicyContext.Provider>
  );
}
