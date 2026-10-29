/**
 * docs/design/event-content-spill.md: requests the server refused an allow
 * for (409 `request_content_not_loaded`): its binding holds content this
 * surface did not load. Bumping the version remounts the card's loader,
 * which refetches the binding, and makes the toast offer Review instead of
 * Allow; the person then allows again once it has loaded.
 *
 * Kept apart from `answerRequest` so the toast handlers can read it without
 * loading the answering module eagerly.
 */
const contentRefreshVersions = new Map<string, number>();
const contentRefreshListeners = new Set<() => void>();

function contentRefreshKey(threadId: string, requestEventId: string) {
  return `${threadId}\u0000${requestEventId}`;
}

export function subscribeContentRefresh(listener: () => void) {
  contentRefreshListeners.add(listener);
  return () => {
    contentRefreshListeners.delete(listener);
  };
}

export function contentRefreshVersion(
  threadId: string,
  requestEventId: string,
): number {
  return (
    contentRefreshVersions.get(contentRefreshKey(threadId, requestEventId)) ?? 0
  );
}

export function bumpContentRefresh(threadId: string, requestEventId: string) {
  const key = contentRefreshKey(threadId, requestEventId);
  if (contentRefreshVersions.size >= 256)
    contentRefreshVersions.delete(contentRefreshVersions.keys().next().value!);
  contentRefreshVersions.set(key, (contentRefreshVersions.get(key) ?? 0) + 1);
  for (const listener of contentRefreshListeners) listener();
}
