import {
  REQUIRED_SLOT_DEFAULTS,
  type RequiredSlot,
} from '@kontourai/station-contracts/required-slots';
import { createContext, type ReactNode, useContext, useRef } from 'react';

export interface RequiredSlotFailure {
  slot: RequiredSlot;
  defaultFiller: string;
  reason: 'unavailable' | 'repeated-render-failure';
}

const listeners = new Set<(failure: RequiredSlotFailure) => void>();

/**
 * Diagnostic only. Slice f must obtain recovery authority from a kernel-owned
 * channel, never this renderer callback or a window event. In-page plugins
 * share this realm; module privacy is not a security boundary against them.
 */
export function subscribeRequiredSlotFailures(
  listener: (failure: RequiredSlotFailure) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportRequiredSlotFailure(
  slot: RequiredSlot,
  reason: RequiredSlotFailure['reason'],
) {
  for (const listener of listeners) {
    try {
      listener({ slot, defaultFiller: REQUIRED_SLOT_DEFAULTS[slot], reason });
    } catch {
      // A diagnostic subscriber must not interrupt the pane's recovery UI.
    }
  }
}

type Attempts = Map<RequiredSlot, number>;
const RecoveryScope = createContext<Map<string, Attempts> | null>(null);
const RecoveryAttempts = createContext<Attempts | null>(null);

/** Lives above the host's failed/ready switch, so explicit retries retain history. */
export function RequiredSlotRecoveryScope({
  children,
}: {
  children: ReactNode;
}) {
  const owners = useRef(new Map<string, Attempts>());
  return (
    <RecoveryScope.Provider value={owners.current}>
      {children}
    </RecoveryScope.Provider>
  );
}

export function RequiredSlotRecoveryFrame({
  instanceId,
  children,
}: {
  instanceId: string;
  children: ReactNode;
}) {
  const owners = useContext(RecoveryScope);
  const local = useRef(new Map<string, Attempts>());
  const scope = owners ?? local.current;
  let attempts = scope.get(instanceId);
  if (!attempts) {
    attempts = new Map();
    scope.set(instanceId, attempts);
  }
  return (
    <RecoveryAttempts.Provider value={attempts}>
      {children}
    </RecoveryAttempts.Provider>
  );
}

export function useRequiredSlotRenderRecovery(slot: RequiredSlot) {
  const attempts = useContext(RecoveryAttempts);
  return {
    failed: () => {
      if (!attempts) return;
      const count = (attempts.get(slot) ?? 0) + 1;
      attempts.set(slot, count);
      // Initial failure plus two explicit retries: tolerate a transient crash
      // without turning an indefinitely failing conversation into a retry loop.
      if (count === 3)
        reportRequiredSlotFailure(slot, 'repeated-render-failure');
    },
    recovered: () => attempts?.delete(slot),
  };
}
