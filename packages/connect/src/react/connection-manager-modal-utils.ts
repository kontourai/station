import { connectionFailureCopy } from '../core/environmentProfiles';
import type { SavedConnection } from '../core/types';

export type ConnectionManagerPanel =
  | 'list'
  | 'add'
  | 'request-access'
  | 'pair-device'
  | 'pair-code'
  | 'pair-host'
  | 'devices'
  | 'discover';

export type ConnectionHealthValue = boolean | null | undefined;

export type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'idle';

export function getConnectionManagerTitle(
  panel: ConnectionManagerPanel,
): string {
  switch (panel) {
    case 'list':
      return 'Stations';
    case 'add':
      return 'Add Station';
    case 'request-access':
      return 'Request Access';
    case 'pair-device':
      return 'Scan a pairing code';
    case 'pair-code':
      return 'Enter a pairing code';
    case 'pair-host':
      return 'Pair a Device';
    case 'devices':
      return 'Paired Devices';
    case 'discover':
      return 'Other Stations';
  }
}

export function getConnectionStatus({
  connectionId,
  activeConnectionId,
  healthValue,
}: {
  connectionId: string;
  activeConnectionId: string | null | undefined;
  healthValue: ConnectionHealthValue;
}): ConnectionStatus {
  if (connectionId === activeConnectionId) {
    if (healthValue === null) return 'connecting';
    if (healthValue === true) return 'connected';
    if (healthValue === false) return 'error';
    return 'connecting';
  }

  if (healthValue === true) return 'connected';
  if (healthValue === false) return 'error';
  return 'connecting';
}

/**
 * True when the connection needs an in-row access-request affordance.
 *
 * - Rejected / missing credentials → yes.
 * - `not-required` (access is managed outside this row) → **no**. This legacy
 *   state never means a direct loopback address grants protected API authority.
 *   Durable pairing remains available from Paired devices / Request access;
 *   show friction only when the connection reports that access is required.
 * - `saved` / `device-session` without error → no.
 */
export function connectionNeedsAccessRequest(
  connection: SavedConnection,
): boolean {
  // Host-injected connections (bundled-server loopback, CLI base) are outside
  // the persisted list, so the store's credential/pairing mutations silently
  // no-op on them — a request-access affordance here would false-succeed.
  // The native host supervises these; they never need in-app access requests.
  if (connection.injected) return false;
  if (connection.lastError?.reason === 'authentication-failed') return true;
  return connection.credentialState === 'required';
}

/** The name shown for a connection: its label, falling back to its address. */
export function connectionDisplayLabel(connection: SavedConnection): string {
  return connection.name || connection.url;
}

/**
 * Human-readable state for the desktop-supervised local server's injected
 * connection when it is NOT running. Returns null for a running loopback, a CLI
 * base, or any saved connection — those show their address as usual. A non-null
 * result is the row's cue to render state-in-place-of-URL, suppress the
 * edit/remove/check affordances, and (when a restart handler is wired) offer a
 * Restart control.
 */
export function injectedConnectionStateLabel(
  connection: SavedConnection,
): string | null {
  if (!connection.injected) return null;
  switch (connection.injectedStatus) {
    case 'starting':
      return 'Starting…';
    case 'failed':
      return 'Failed to start';
    case 'stopped':
      return 'Not running';
    default:
      // 'running' (shows its URL) or an unstated status (e.g. a CLI base).
      return null;
  }
}

/**
 * station#4513 — the ONE status line (and, for most of the states, its one
 * action) a Stations-sheet card shows for its dominant condition.
 *
 * A card used to stack every prose block it had — a pending access request,
 * an identity-mismatch paragraph, "Credential required", all at once for a
 * connection unlucky enough to carry more than one — which is the clutter
 * this collapses. Precedence: `pending-approval` > `identity-mismatch` >
 * `authentication-failed` > `credential-required` (any OTHER reason
 * `connectionNeedsAccessRequest` flags) > any other observed failure >
 * nothing to report. Only ever one of these renders per card; the full
 * explanation (`connectionFailureCopy`'s `.action` sentence, not just its
 * `.summary`) moves to the card's edit view instead of stacking here too —
 * see `ConnectionListPanel`.
 *
 * station#4512 review (M4): `authentication-failed` used to fall into the
 * generic `credential-required` bucket (`connectionNeedsAccessRequest`
 * already flags it, alongside the unrelated "never had one" case), which
 * lost the #3903 insight — "the address is fine, this device isn't
 * authorised there" — this connection's row had until then. It is now its
 * own bucket with that insight, short, ahead of the generic one.
 */
export interface ConnectionCardMeta {
  line: string;
  /** Present only for a state whose one action differs from the row's persistent icons. */
  action?: 'request-access';
  actionLabel?: string;
  actionAriaLabel?: string;
}

export function connectionCardMeta(
  connection: SavedConnection,
  isPendingConnection: boolean,
): ConnectionCardMeta | null {
  // Host-injected connections narrate their own lifecycle in place of the
  // URL (`injectedConnectionStateLabel`) and never carry a pairing/access
  // story — the store's mutations no-op on them.
  if (connection.injected) return null;
  if (isPendingConnection) {
    return { line: 'Access request pending approval' };
  }
  if (connection.lastError?.reason === 'identity-mismatch') {
    return {
      line: connectionFailureCopy(
        'identity-mismatch',
        connectionDisplayLabel(connection),
        connection.url,
      ).summary,
      action: 'request-access',
      actionLabel: 'Pair again',
      actionAriaLabel: `Pair ${connectionDisplayLabel(connection)} again`,
    };
  }
  if (connection.lastError?.reason === 'authentication-failed') {
    // station#4512 review (L-new-2): the short form lives in
    // `connectionFailureCopy`'s table (the single source for reason
    // wording), not hardcoded here — a caller that needs shorter copy adds
    // a `short` entry there rather than routing around it.
    const copy = connectionFailureCopy(
      'authentication-failed',
      connectionDisplayLabel(connection),
      connection.url,
    );
    return {
      line: copy.short ?? copy.summary,
      action: 'request-access',
      actionLabel: 'Request access',
      actionAriaLabel: `Request access to ${connectionDisplayLabel(connection)}`,
    };
  }
  if (connectionNeedsAccessRequest(connection)) {
    return {
      line: 'Credential required',
      action: 'request-access',
      actionLabel: 'Request access',
      actionAriaLabel: `Request access to ${connectionDisplayLabel(connection)}`,
    };
  }
  if (
    connection.lastError &&
    connection.lastError.reason !== 'awaiting-approval'
  ) {
    return {
      line: connectionFailureCopy(
        connection.lastError.reason,
        connectionDisplayLabel(connection),
        connection.url,
      ).summary,
    };
  }
  return null;
}

/**
 * The status dot for a supervised local server, keyed off its lifecycle state
 * rather than health polling (the browser never probes the loopback base).
 * Returns null for a non-injected connection, a running loopback, or a CLI base
 * — those fall back to the normal active-id/health dot. `starting` reads as
 * connecting (yellow), `failed` as error (red), `stopped` as idle (neutral).
 */
export function injectedConnectionDotStatus(
  connection: SavedConnection,
): ConnectionStatus | null {
  if (!connection.injected) return null;
  switch (connection.injectedStatus) {
    case 'starting':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'idle';
    default:
      // 'running' / unstated → use the normal dot.
      return null;
  }
}
