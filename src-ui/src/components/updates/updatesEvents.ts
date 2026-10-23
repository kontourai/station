import { useSyncExternalStore } from 'react';

export type UpdateTarget = 'desktop' | 'server';

export interface UpdateNotice {
  id: string;
  target: UpdateTarget;
  message: string;
  detail?: string;
  href?: string;
  actionLabel?: string;
  onAction?: () => void;
}

const listeners = new Set<() => void>();
let notices: readonly UpdateNotice[] = [];
let request: { target?: UpdateTarget; sequence: number; pending: boolean } = {
  sequence: 0,
  pending: false,
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => {
  for (const listener of listeners) listener();
};

export function publishUpdateNotice(notice: UpdateNotice): void {
  notices = [...notices.filter((entry) => entry.id !== notice.id), notice];
  emit();
}

export function clearUpdateNotice(id: string): void {
  if (!notices.some((notice) => notice.id === id)) return;
  notices = notices.filter((notice) => notice.id !== id);
  emit();
}

/** Opens the sidebar-owned panel, including when its content has not loaded. */
export function openUpdates(target?: UpdateTarget): void {
  request = { target, sequence: request.sequence + 1, pending: true };
  emit();
}

export function takeOpenUpdatesRequest(sequence: number): boolean {
  if (!request.pending || request.sequence !== sequence) return false;
  request = { ...request, pending: false };
  emit();
  return true;
}

export function useUpdateNotices(): readonly UpdateNotice[] {
  return useSyncExternalStore(subscribe, () => notices);
}

export function useOpenUpdatesRequest() {
  return useSyncExternalStore(subscribe, () => request);
}
