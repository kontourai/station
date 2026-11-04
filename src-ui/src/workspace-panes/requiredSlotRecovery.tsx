import {
  REQUIRED_SLOT_DEFAULTS,
  type RequiredSlot,
} from '@kontourai/station-contracts/required-slots';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

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
const RecoveryAttempts = createContext<{
  owners: Map<string, Attempts>;
  instanceId: string;
} | null>(null);

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
  const owner = useMemo(
    () => ({ owners: owners ?? local.current, instanceId }),
    [owners, instanceId],
  );
  return (
    <RecoveryAttempts.Provider value={owner}>
      {children}
    </RecoveryAttempts.Provider>
  );
}

/** Failed renderers unmount too; only removal from the host document closes an occurrence. */
export function useRequiredSlotRecoveryInstances(
  instances: readonly WorkspacePaneInstance[],
) {
  const owners = useContext(RecoveryScope);
  useEffect(() => {
    const live = new Set<string>(
      instances.map((instance) => instance.instanceId),
    );
    for (const id of owners?.keys() ?? []) {
      if (!live.has(id)) owners?.delete(id);
    }
  }, [owners, instances]);
}

export function useRequiredSlotRenderRecovery(slot: RequiredSlot) {
  const owner = useContext(RecoveryAttempts);
  const failed = useCallback(() => {
    if (!owner) return;
    let attempts = owner.owners.get(owner.instanceId);
    if (!attempts) {
      attempts = new Map();
      owner.owners.set(owner.instanceId, attempts);
    }
    const count = (attempts.get(slot) ?? 0) + 1;
    attempts.set(slot, count);
    // Chat’s Close can remount an empty Chat that also fails.
    if (count === 3) reportRequiredSlotFailure(slot, 'repeated-render-failure');
  }, [owner, slot]);
  return { failed };
}
