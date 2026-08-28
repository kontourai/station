import type { SessionInventoryLiveItem } from '@kontourai/station-basis-pane/session-inventory-view';
import type { AnySessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
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
  requestScope: { authorityKey: string; isCurrent?: () => boolean } | undefined,
  sessionId: string,
  chatStoreId?: string,
) {
  const cache = useRef<unknown>(null);
  const subscribe = useCallback((listener: () => void) => {
    const a = backgroundTasksStore.subscribe(listener);
    const b = activeChatsStore.subscribe(listener);
    return () => {
      a();
      b();
    };
  }, []);
  const snapshot = useCallback(() => {
    if (!requestScope?.isCurrent?.() || !chatStoreId) return EMPTY;
    const floorKey = `${chatStoreId}\u0000${sessionId}`;
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
    const raw = backgroundTasksStore.getSnapshot();
    const provider =
      activeChatsStore.getSnapshot()[chatStoreId]?.backgroundTasks;
    const next = selectSessionInventoryLiveNow(raw, sessionId, provider).filter(
      (entry) => entry.startedAt >= startedAfter,
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
      next.map((entry) => [entry.id, entry.state]),
      pendingApprovalIds,
    ]);
    if (
      cache.current &&
      (cache.current as { encoded: string }).encoded === encoded
    )
      return (cache.current as { value: SessionInventoryLiveOverlay }).value;
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
