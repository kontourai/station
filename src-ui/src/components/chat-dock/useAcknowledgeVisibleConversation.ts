import { useAcknowledgeConversationMutation } from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import { useDocumentFocused } from '../../hooks/useDocumentFocused';
import {
  type HomeWorkItem,
  isTerminalLifecycle,
} from '../../views/home/home-view-model';

type AcknowledgeableItem = Pick<
  HomeWorkItem,
  | 'id'
  | 'lifecycleLabel'
  | 'conversationUpdatedAt'
  | 'acknowledgedAt'
  | 'unread'
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
 *
 * #3075: every version the server calls `unread` is recorded while the chat
 * is on screen, so a second device sees it read even mid-turn. Otherwise the
 * last-viewed rule above still decides: "read" may come from the baseline
 * (history before read state was kept), and Home's Just finished compares
 * the recorded view with the finish time, so that record must still be made.
 */
export function visibleConversationAcknowledgement(
  item: AcknowledgeableItem | undefined,
  viewedWhileLive: ReadonlySet<string>,
): string | undefined {
  const version = item?.conversationUpdatedAt;
  if (!item || !version) return undefined;
  // The server says unread: record it, every version, while on screen.
  if (item.unread === true) return version;
  const versionAt = Date.parse(version);
  if (!Number.isFinite(versionAt)) return undefined;
  if (item.acknowledgedAt !== undefined && item.acknowledgedAt >= versionAt) {
    return undefined;
  }
  if (!isTerminalLifecycle(item.lifecycleLabel) && viewedWhileLive.has(item.id))
    return undefined;
  return version;
}

/**
 * Records "last viewed" for the chat the pane is showing while the pane is
 * open and its window is focused (#3075: a chat on screen in a window the
 * person is not using stays unread). `paneVisible` is the caller's
 * answer for its own chrome (dock open, not covered by the phone's task
 * switcher).
 */
export function useAcknowledgeVisibleConversation(
  item: AcknowledgeableItem | undefined,
  paneVisible: boolean,
): void {
  const { mutate } = useAcknowledgeConversationMutation();
  const focused = useDocumentFocused();
  const visible = paneVisible && focused;
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
