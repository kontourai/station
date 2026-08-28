import type { StationCompatibilityResult } from '@kontourai/station-contracts';
import { lazy, Suspense } from 'react';
import type { ConnectionHealthCheckResult } from '../core/ConnectionHealthCoordinator';
import type { PendingPairingExchange } from '../core/devicePairing';
import type { SavedConnection } from '../core/types';
import type { ConnectionManagerPanel } from './connection-manager-modal-utils';

// The modal body (discovery, pairing, QR, the connection list) is the largest
// surface this package contributes, and it is only ever mounted behind a user
// gesture — `isOpen` starts false on every host and flips on a click. Splitting
// it keeps that whole subtree out of the first-paint bundle, matching the
// in-package precedent set by `CompatibilityNotice`.
const ConnectionManagerModalContent = lazy(() =>
  import('./ConnectionManagerModalContent').then((m) => ({
    default: m.ConnectionManagerModalContent,
  })),
);

export interface ConnectionManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Injected health-checker so the library stays server-agnostic.
   *
   * Return `true` when the server is healthy. A bare `false` cannot say why a
   * check failed, so returning `{ ok: false, reason }` is preferred — a
   * reachable Station that rejects the credential answers 401, and reporting
   * that as 'unreachable' sends the user to check an address that is fine.
   * `ConnectionHealthCheckResult` includes `boolean`, so existing boolean
   * implementations still satisfy this.
   */
  checkHealth: (
    url: string,
    credential?: string,
  ) => Promise<ConnectionHealthCheckResult>;
  /**
   * Optional client/server compatibility check, run against a host before it
   * is saved. Omit it and the add/pairing paths behave exactly as before.
   */
  checkCompatibility?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<StationCompatibilityResult>;
  initialPanel?: ConnectionManagerPanel;
  /** A decoded, one-time pairing payload awaiting the user's confirmation. */
  initialPairingPayload?: string;
  /** A rejected native link's safe, parser-authored remedy for the active review. */
  pairingLinkError?: string;
  onPairingReviewDismissed?: () => void;
  /**
   * True when the page was served by a Station host (the web case), so the
   * direct "Request access" flow can target `window.location.origin`. The app
   * layer passes false in a native shell, where the origin is not a Station
   * host and the flow must collect a host address first. Defaults to true to
   * preserve the current served-from-Station behavior when unset.
   */
  originIsStation?: boolean;
  /** Native shell name, when this UI is not running in a browser. */
  hostAppName?: string;
  /** Native desktop keeps bearer values host-side and disables manual entry. */
  allowManualCredentials?: boolean;
  /** Host-owned request transport for native management routes. */
  authenticatedRequest?: typeof fetch;
  /**
   * Restart the supervising desktop's bundled server. Passed only by a
   * supervising desktop host; when omitted the not-running local-server row
   * shows its state without a Restart control.
   */
  onRestartInjectedConnection?: (connection: SavedConnection) => void;
  /** Persistent trigger to restore after a parent chooser is replaced. */
  returnFocusTarget?: HTMLElement | null;
  /**
   * Optional success side-effect after a pairing exchange commits (station#1954
   * mobile haptics). Connect stays free of platform imports.
   */
  onPairingSucceeded?: () => void;
  /** Move a submitted approval request into persistent application chrome. */
  onApprovalPending?: (pending: PendingPairingExchange) => void;
}

export function ConnectionManagerModal({
  isOpen,
  onClose,
  checkHealth,
  checkCompatibility,
  initialPanel,
  initialPairingPayload,
  pairingLinkError,
  onPairingReviewDismissed,
  originIsStation,
  hostAppName,
  allowManualCredentials,
  authenticatedRequest,
  onRestartInjectedConnection,
  returnFocusTarget,
  onPairingSucceeded,
  onApprovalPending,
}: ConnectionManagerModalProps) {
  if (!isOpen) return null;
  return (
    <Suspense fallback={null}>
      <ConnectionManagerModalContent
        onClose={onClose}
        checkHealth={checkHealth}
        checkCompatibility={checkCompatibility}
        initialPanel={initialPanel}
        initialPairingPayload={initialPairingPayload}
        pairingLinkError={pairingLinkError}
        onPairingReviewDismissed={onPairingReviewDismissed}
        originIsStation={originIsStation}
        hostAppName={hostAppName}
        allowManualCredentials={allowManualCredentials}
        authenticatedRequest={authenticatedRequest}
        onRestartInjectedConnection={onRestartInjectedConnection}
        returnFocusTarget={returnFocusTarget}
        onPairingSucceeded={onPairingSucceeded}
        onApprovalPending={onApprovalPending}
      />
    </Suspense>
  );
}
