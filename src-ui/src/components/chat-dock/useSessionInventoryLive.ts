import type { SessionInventoryLiveItem } from '@kontourai/station-basis-pane/session-inventory-view';
import type { AnySessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  backgroundTasksStore,
  selectStationProviderItems,
  stationProviderTasks,
} from '../../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
import { selectSessionInventoryLiveNow } from './sessionInventoryLiveProjection';

export type SessionInventoryLiveOverlay = {
  running: readonly ReturnType<typeof selectSessionInventoryLiveNow>[number][];
  pendingApprovalIds: readonly string[];
};
const EMPTY: SessionInventoryLiveOverlay = {
  running: [],
  pendingApprovalIds: [],
};
const floors = new Map<
  string,
  { authorityKey: string; startedAfter: number }
>();

/** Activation-only, captured-session Live projection. No cache or persistence. */
export function useSessionInventoryLive(
  requestScope:
    | { apiBase: string; authorityKey: string; isCurrent?: () => boolean }
    | undefined,
  sessionId: string,
  chatStoreId?: string,
) {
  const cache = useRef<{
    encoded: string;
    value: SessionInventoryLiveOverlay;
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => {
      const a = backgroundTasksStore.subscribe(listener);
      const b = activeChatsStore.subscribe(listener);
      const c = childWorkGlobalStore.subscribe(listener);
      const releaseTasks = requestScope
        ? backgroundTasksStore.retainPartition(requestScope.apiBase)
        : () => {};
      const releaseChildren = requestScope
        ? childWorkGlobalStore.retainPartition(requestScope.apiBase)
        : () => {};
      return () => {
        a();
        b();
        c();
        releaseTasks();
        releaseChildren();
      };
    },
    [requestScope],
  );
  const snapshot = useCallback(() => {
    if (!requestScope?.isCurrent?.() || !chatStoreId) return EMPTY;
    const floorKey = JSON.stringify([
      requestScope.apiBase,
      chatStoreId,
      sessionId,
    ]);
    const previousFloor = floors.get(floorKey);
    if (
      !previousFloor ||
      previousFloor.authorityKey !== requestScope.authorityKey
    )
      floors.set(floorKey, {
        authorityKey: requestScope.authorityKey,
        startedAfter: Date.now(),
      });
    const startedAfter = floors.get(floorKey)!.startedAfter;
    const raw = backgroundTasksStore.getSnapshot(requestScope.apiBase);
    const provider = stationProviderTasks(
      selectStationProviderItems(
        raw,
        childWorkGlobalStore.getPartition(requestScope.apiBase).registry,
        chatStoreId,
      ),
    );
    const next = selectSessionInventoryLiveNow(raw, sessionId, provider).filter(
      (entry) =>
        entry.startedAt !== undefined && entry.startedAt >= startedAfter,
    );
    const pendingApprovalIds = [
      ...new Set(
        (activeChatsStore.getSnapshot()[chatStoreId]?.messages ?? [])
          .filter((message) => message.sessionId === sessionId)
          .flatMap((message) => message.contentParts ?? [])
          .flatMap((part) =>
            part.needsApproval && part.approvalId ? [part.approvalId] : [],
          ),
      ),
    ];
    const encoded = JSON.stringify([
      requestScope.apiBase,
      requestScope.authorityKey,
      sessionId,
      chatStoreId,
      next,
      pendingApprovalIds,
    ]);
    if (cache.current?.encoded === encoded) return cache.current.value;
    const value = { running: next, pendingApprovalIds };
    cache.current = { encoded, value };
    return value;
  }, [chatStoreId, requestScope, sessionId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Presentation overlay only: no rows, persistence, or cache payload mutation. */
export function overlaySessionInventoryLive(
  projection: AnySessionInventoryProjection,
  live: SessionInventoryLiveOverlay,
): AnySessionInventoryProjection {
  const count = live.running.length + live.pendingApprovalIds.length;
  if (!count) return projection;
  return {
    ...projection,
    groups: projection.groups.map((group) =>
      group.id === 'live-now'
        ? {
            ...group,
            state: 'available' as const,
            count: { kind: 'exact' as const, value: count },
          }
        : group,
    ),
  } as AnySessionInventoryProjection;
}
export function sessionInventoryLiveItems(
  live: SessionInventoryLiveOverlay,
): readonly SessionInventoryLiveItem[] {
  return [
    ...live.running.map((entry) => ({
      key: entry.id,
      kind: entry.kind === 'tool' ? ('tool' as const) : ('agent' as const),
      label: entry.kind === 'tool' ? 'Running tool' : 'Running delegate',
    })),
    ...live.pendingApprovalIds.map((key) => ({
      key,
      kind: 'approval' as const,
      label: 'Pending request',
    })),
  ];
}
