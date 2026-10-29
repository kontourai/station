import { useAcknowledgeConversationMutation } from '@kontourai/station-sdk';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  type HomeWorkItem,
  isTerminalLifecycle,
} from '../../views/home/home-view-model';

type AcknowledgeableItem = Pick<
  HomeWorkItem,
  'id' | 'lifecycleLabel' | 'conversationUpdatedAt' | 'acknowledgedAt'
>;

/**
 * The inventory version to record as viewed for the chat on screen, or
 * `undefined` when nothing should be sent (#4266).
 *
 * - A finished thread records the version on screen, so watching it finish
 *   clears it from "Just finished" and it does not reappear there.
 * - A thread still working records one view per visible span, not one per
 *   inventory refresh: that view is what later puts it in "Just finished"
 *   when it finishes after the person looked away.
 * - Nothing already on record at or past this version is sent again.
 */
export function visibleConversationAcknowledgement(
  item: AcknowledgeableItem | undefined,
  viewedWhileLive: ReadonlySet<string>,
): string | undefined {
  const version = item?.conversationUpdatedAt;
  if (!item || !version) return undefined;
  const versionAt = Date.parse(version);
  if (!Number.isFinite(versionAt)) return undefined;
  if (item.acknowledgedAt !== undefined && item.acknowledgedAt >= versionAt) {
    return undefined;
  }
  if (!isTerminalLifecycle(item.lifecycleLabel) && viewedWhileLive.has(item.id))
    return undefined;
  return version;
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const documentVisible = () => document.visibilityState === 'visible';

/**
 * Records "last viewed" for the chat the pane is showing while the pane is
 * open and the page is in the foreground. `paneVisible` is the caller's
 * answer for its own chrome (dock open, not covered by the phone's task
 * switcher).
 */
export function useAcknowledgeVisibleConversation(
  item: AcknowledgeableItem | undefined,
  paneVisible: boolean,
): void {
  const { mutate } = useAcknowledgeConversationMutation();
  const pageVisible = useSyncExternalStore(
    subscribeVisibility,
    documentVisible,
    () => false,
  );
  const visible = paneVisible && pageVisible;
  const viewedWhileLive = useRef(new Set<string>());
  const sent = useRef<string | null>(null);

  useEffect(() => {
    // A new visible span: a thread still working may record one more view.
    if (!visible) viewedWhileLive.current.clear();
  }, [visible]);

  const id = item?.id;
  const version = visible
    ? visibleConversationAcknowledgement(item, viewedWhileLive.current)
    : undefined;
  useEffect(() => {
    if (!id || !version) return;
    const key = `${id}\u0000${version}`;
    if (sent.current === key) return;
    sent.current = key;
    viewedWhileLive.current.add(id);
    mutate({ conversationId: id, updatedAt: version });
  }, [id, version, mutate]);
}
