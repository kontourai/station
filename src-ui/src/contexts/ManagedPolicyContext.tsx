import { isKnownFullAccessAcpModeId } from '@kontourai/station-contracts/acp';
import {
  approvalModeExceedsCeiling,
  clampApprovalModeToCeiling,
  type ManagedPolicySummary,
  managedApprovalCeiling,
} from '@kontourai/station-contracts/managed-policy';
import {
  type ApprovalMode,
  type ConcreteApprovalMode,
  isConcreteApprovalMode,
} from '@kontourai/station-contracts/provider';
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

/**
 * #4518: the machine's approval ceiling as every approval picker applies it:
 * the same contract comparison the server uses. With no policy read (or none
 * restricting), nothing is above it and nothing is lowered.
 */
export interface ManagedApprovalCeilingView {
  summary: ManagedPolicySummary | undefined;
  ceiling: ConcreteApprovalMode | undefined;
  /** Whether picking `mode` would be refused for being above the ceiling. */
  aboveCeiling: (mode: unknown) => boolean;
  /** Whether an ACP session mode id is a known full-access mode above it. */
  acpModeAboveCeiling: (modeId: string) => boolean;
  /** A default as it applies: lowered to the ceiling when broader. */
  clamp: <M extends ApprovalMode>(mode: M) => M | ConcreteApprovalMode;
}

export function useManagedApprovalCeiling(): ManagedApprovalCeilingView {
  const summary = useManagedPolicySummary();
  const ceiling = managedApprovalCeiling(summary);
  const aboveCeiling = (mode: unknown) =>
    isConcreteApprovalMode(mode) && approvalModeExceedsCeiling(mode, ceiling);
  return {
    summary,
    ceiling,
    aboveCeiling,
    acpModeAboveCeiling: (modeId) =>
      isKnownFullAccessAcpModeId(modeId) && aboveCeiling('never'),
    clamp: (mode) => clampApprovalModeToCeiling(mode, ceiling),
  };
}
