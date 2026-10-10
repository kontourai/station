export const CONNECTION_SETUP_RETURN_EVENT = 'station:connection-setup-return';

export const OPEN_CONNECTIONS_MODAL_EVENT = 'station:open-connections-modal';

export type OpenConnectionsModalDetail = {
  /**
   * - `list` — the connection list (the default).
   * - `pair-device` — scan an invitation on the joining device.
   * - `pair-host` — invite another device to the selected Station server.
   * - `request-access` — re-pairing for the ACTIVE connection, archive#3297.
   *   The connection indicator uses this: a device whose credential has gone
   *   stale needs the one exchange that replaces it, not a list to navigate.
   */
  /** Correlation for a mounted Project caller; carries no draft or authority. */
  setupRequestId?: string;
  projectName?: string;
  peerOnly?: boolean;
  mode?:
    | 'connect-station'
    | 'list'
    | 'pair-device'
    | 'request-access'
    | 'devices'
    | 'pair-host';
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
