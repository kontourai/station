export const OPEN_CONNECTIONS_MODAL_EVENT = 'station:open-connections-modal';

export type OpenConnectionsModalDetail = {
  /**
   * - `list` — the connection list (the default).
   * - `pair-device` — device pairing (host approve surface).
   * - `request-access` — re-pairing for the ACTIVE connection, archive#3297.
   *   The connection indicator uses this: a device whose credential has gone
   *   stale needs the one exchange that replaces it, not a list to navigate.
   */
  mode?: 'list' | 'pair-device' | 'request-access' | 'devices';
};

let pendingOpen: OpenConnectionsModalDetail | null = null;

/** Consume an open request that arrived before the deferred modal owner mounted. */
export function consumePendingConnectionsModal(): OpenConnectionsModalDetail | null {
  const pending = pendingOpen;
  pendingOpen = null;
  return pending;
}

export function openConnectionsModal(
  detail: OpenConnectionsModalDetail = {},
): void {
  pendingOpen = detail;
  window.dispatchEvent(
    new CustomEvent(OPEN_CONNECTIONS_MODAL_EVENT, { detail }),
  );
}
