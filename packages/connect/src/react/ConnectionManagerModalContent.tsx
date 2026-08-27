import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
  type StationCompatibilityResult,
} from '@kontourai/station-contracts';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { ConnectionHealthCheckResult } from '../core/ConnectionHealthCoordinator';
import {
  loadPendingExchange,
  type PendingPairingExchange,
  savePendingExchange,
} from '../core/devicePairing';
import {
  createStationProofNonce,
  verifyStationEnvironmentProof,
} from '../core/environmentProof';
import { normalizeHostInput } from '../core/hostInput';
import type { SavedConnection } from '../core/types';
import { ConnectionManagerDiscoverPanel } from './ConnectionManagerDiscoverPanel';
import { useConnections } from './ConnectionsContext';
import { ConnectionListPanel } from './connection-manager-modal/ConnectionListPanel';
import { ManualAddPanel } from './connection-manager-modal/ManualAddPanel';
import { PairedDevicesPanel } from './connection-manager-modal/PairedDevicesPanel';
import {
  type ConnectionManagerPanel,
  getConnectionManagerTitle,
  getConnectionStatus,
} from './connection-manager-modal-utils';
import {
  HostDevicePairingPanel,
  JoinDevicePairingPanel,
  type PairingResult,
} from './DevicePairingPanel';
import { completeVerifiedPairing } from './pairingCompletion';
import { useConnectionCandidates } from './useConnectionCandidates';
import { useResponsiveVisualViewport } from './useResponsiveVisualViewport';
import './ConnectionManagerModal.css';

// Version drift is rare and this notice carries its own copy; it is split out
// so the first-paint bundle does not carry a screen most users never see.
const CompatibilityNotice = lazy(() =>
  import('./connection-manager-modal/CompatibilityNotice').then((m) => ({
    default: m.CompatibilityNotice,
  })),
);

interface ConnectionManagerModalContentProps {
  onClose: () => void;
  /**
   * A bare `false` cannot say why the check failed, so the caller may return a
   * `{ ok: false, reason }` result instead. `ConnectionHealthCheckResult`
   * includes `boolean`, so existing boolean implementations still satisfy this.
   */
  checkHealth: (
    url: string,
    credential?: string,
  ) => Promise<ConnectionHealthCheckResult>;
  /**
   * Client/server compatibility check, run against a host before the
   * connection is committed. Every add and pairing path requires this proof;
   * an omitted checker is an actionable integration error, never permission to
   * save an unverified URL-only profile.
   */
  checkCompatibility?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<StationCompatibilityResult>;
  initialPanel?: ConnectionManagerPanel;
  /** A decoded, one-time pairing payload awaiting the user's confirmation. */
  initialPairingPayload?: string;
  /**
   * True when the page origin is a usable direct-request target (served by a
   * Station host). Passed through to the request-access panel; defaults to
   * true so the served-from-Station web behavior is unchanged when unset.
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
  /** Optional success side-effect after pairing commits (station#1954). */
  onPairingSucceeded?: () => void;
  /** Move a submitted approval request into persistent application chrome. */
  onApprovalPending?: (pending: PendingPairingExchange) => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';
const MAX_CANDIDATE_HANDSHAKE_BYTES = 32 * 1024;

async function readCandidateHandshake(response: Response): Promise<{
  environmentId?: unknown;
  authentication?: { scheme?: unknown; protocolVersion?: unknown };
} | null> {
  const declaredLength = response.headers.get('Content-Length');
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_CANDIDATE_HANDSHAKE_BYTES
  ) {
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_CANDIDATE_HANDSHAKE_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text) as {
      environmentId?: unknown;
      authentication?: { scheme?: unknown; protocolVersion?: unknown };
    };
  } catch {
    return null;
  }
}

export function ConnectionManagerModalContent({
  onClose,
  checkHealth,
  checkCompatibility,
  initialPanel = 'list',
  initialPairingPayload,
  originIsStation = true,
  hostAppName,
  allowManualCredentials = true,
  authenticatedRequest,
  onRestartInjectedConnection,
  returnFocusTarget,
  onPairingSucceeded,
  onApprovalPending,
}: ConnectionManagerModalContentProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement[]>([]);
  const candidateReviewControllerRef = useRef<AbortController | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const visualViewportStyle = useResponsiveVisualViewport();
  const {
    connections,
    activeConnection,
    addConnection,
    removeConnection,
    updateConnection,
    setActiveConnection,
    setCredential,
    markDeviceSession,
    removeCredential,
    reconcileHandshake,
    commitVerifiedPairing,
    makeDefaultProfile,
    getConnectionCredential,
    commitEndpointCandidate,
    failEndpointCandidate,
    recordEndpointSuccess,
    recordEndpointFailure,
  } = useConnections();

  /**
   * station#3297 — the target for a caller that opened straight onto
   * `request-access` (the connection indicator's one-tap re-pair).
   *
   * Host-injected connections are excluded for the reason
   * `connectionNeedsAccessRequest` already gives: they sit outside the
   * persisted list, so the store's pairing mutations no-op on them and the
   * exchange would false-succeed.
   */
  const seededRequestAccessTarget =
    initialPanel === 'request-access' &&
    activeConnection &&
    !activeConnection.injected
      ? {
          id: activeConnection.id,
          url: activeConnection.url,
          name: activeConnection.name,
        }
      : null;
  const [panel, setPanel] = useState<ConnectionManagerPanel>(
    // An untargeted request-access panel is the FIRST-RUN shape: it asks for a
    // host address. Showing that to someone re-pairing a saved connection
    // would be worse than the list they were trying to skip, so fall back
    // rather than open a screen that cannot do the job asked of it.
    initialPanel === 'request-access' && !seededRequestAccessTarget
      ? 'list'
      : initialPanel,
  );
  const pairingCodeTriggerRef = useRef<HTMLButtonElement>(null);
  const restorePairingCodeFocusRef = useRef(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [credentialEntry, setCredentialEntry] = useState('');
  const [healthMap, setHealthMap] = useState<Record<string, boolean | null>>(
    {},
  );
  const [compatBlock, setCompatBlock] =
    useState<StationCompatibilityResult | null>(null);
  const [compatChecking, setCompatChecking] = useState(false);
  const [defaultMutationError, setDefaultMutationError] = useState<
    string | null
  >(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  // The saved Station the shared request-access flow targets. First-run and
  // saved-but-unpaired rows use the same exchange and differ only in whether
  // a profile already exists.
  // Seeded at mount only (the initializer, not an effect): once the panel is
  // open, a connection switching underneath a live pairing exchange must not
  // retarget it.
  const [requestAccessTarget, setRequestAccessTarget] = useState<{
    id: string;
    url: string;
    name: string;
  } | null>(seededRequestAccessTarget);

  useEffect(() => {
    if (!initialPairingPayload) return;
    // `initialPanel` seeds local state only at mount. A native deep link can
    // arrive while this modal is already open on another panel, so the payload
    // itself is the event that moves the existing instance into Join.
    setRequestAccessTarget(null);
    setPanel('pair-device');
  }, [initialPairingPayload]);
  useEffect(() => {
    if (panel !== 'list' || !restorePairingCodeFocusRef.current) return;
    restorePairingCodeFocusRef.current = false;
    pairingCodeTriggerRef.current?.focus();
  }, [panel]);
  const {
    discovering,
    candidates,
    providers: candidateProviders,
    providerCount,
    refresh: refreshCandidates,
  } = useConnectionCandidates();

  useEffect(() => {
    // The trigger and every ancestor, captured while all of them are still
    // attached — see `@kontourai/station-shared/return-focus`.
    previousFocusRef.current = captureReturnFocus(returnFocusTarget);
    const overlay = overlayRef.current;
    const inertedBackground: Array<{
      element: HTMLElement;
      inert: boolean;
      ariaHidden: string | null;
    }> = [];
    let activeBranch: HTMLElement | null = overlay;
    while (activeBranch?.parentElement) {
      const parent: HTMLElement = activeBranch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) {
          continue;
        }
        inertedBackground.push({
          element: sibling,
          inert: sibling.inert,
          ariaHidden: sibling.getAttribute('aria-hidden'),
        });
        sibling.inert = true;
        sibling.setAttribute('aria-hidden', 'true');
      }
      activeBranch = parent;
      if (parent === document.body) break;
    }

    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      for (const { element, inert, ariaHidden } of inertedBackground) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      // Restore through the shared module rather than this file's own copy
      // (station#1245). `if (previousFocus?.isConnected) previousFocus.focus()`
      // carried both #1126 gaps, and this modal is where the second one is
      // easiest to hit: the loop above inerts every ancestor branch outside the
      // overlay, so a surviving ancestor can have a perfectly ordinary computed
      // style and still refuse focus — the case `tests/dialog-return-focus.spec
      // .ts` names this component for. It also has the first gap for real:
      // `OnboardingGate` renders this modal from its unreachable-host screen,
      // and a successful connect unmounts that whole screen, trigger included,
      // so `isConnected` is false and nothing at all happened.
      //
      // What is load-bearing here is the *deferral*, not the statement order.
      // Fault injection: moving this call above the un-inert loop changes
      // nothing — the loop is synchronous and the restore is a frame later, so
      // it still sees an un-inerted tree, and the browser suite correctly
      // refuses to fail. Making the restore synchronous instead does fail it,
      // in Chromium only: every surviving ancestor is still `inert`, refuses
      // focus, and the walk runs out. Do not "simplify" this to
      // `applyReturnFocus`.
      const chain = previousFocusRef.current;
      previousFocusRef.current = [];
      restoreReturnFocus(chain, overlay);
    };
  }, [returnFocusTarget]);

  const cancelCandidateReview = useCallback(() => {
    const controller = candidateReviewControllerRef.current;
    candidateReviewControllerRef.current = null;
    controller?.abort();
  }, []);

  useEffect(
    () => () => {
      cancelCandidateReview();
    },
    [cancelCandidateReview],
  );

  const checkOne = useCallback(
    async (conn: SavedConnection) => {
      setHealthMap((m) => ({ ...m, [conn.id]: null }));
      let publicHandshakeVerified = false;
      try {
        const targetUrl = conn.endpointCandidate?.url ?? conn.url;
        const handshakeUrl = new URL(PUBLIC_STATION_HANDSHAKE_PATH, targetUrl);
        const response = await fetch(handshakeUrl, {
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const handshake = (await response.json()) as {
            schemaVersion?: unknown;
            environmentId?: unknown;
            authentication?: {
              scheme?: unknown;
              protocolVersion?: unknown;
            };
            transports?: {
              http?: unknown;
              sse?: unknown;
              websocket?: unknown;
            };
          };
          if (
            typeof handshake.environmentId === 'string' &&
            handshake.authentication?.scheme === 'bearer' &&
            typeof handshake.authentication.protocolVersion === 'number'
          ) {
            const reconciled = reconcileHandshake(conn.id, {
              ...(typeof handshake.schemaVersion === 'number'
                ? { schemaVersion: handshake.schemaVersion }
                : {}),
              environmentId: handshake.environmentId,
              authentication: {
                scheme: 'bearer',
                protocolVersion: handshake.authentication.protocolVersion,
              },
              ...(typeof handshake.transports?.http === 'number' &&
              typeof handshake.transports.sse === 'number' &&
              typeof handshake.transports.websocket === 'number'
                ? {
                    transports: {
                      http: handshake.transports.http,
                      sse: handshake.transports.sse,
                      websocket: handshake.transports.websocket,
                    },
                  }
                : {}),
            });
            if (reconciled) {
              // Reconciliation is the successful identity proof. Health must
              // use the resulting endpoint/credential shape below.
              conn = reconciled;
            }
            publicHandshakeVerified = true;
          } else {
            throw new Error('invalid_public_handshake');
          }
        } else {
          throw new Error('public_handshake_rejected');
        }
      } catch {
        setSelectionError(
          `Could not verify ${conn.name || conn.url} as a Station. Check its address and Station version, then try again.`,
        );
      }
      if (conn.endpointCandidate) {
        setHealthMap((m) => ({ ...m, [conn.id]: false }));
        return;
      }
      const result = await checkHealth(
        conn.url,
        getConnectionCredential(conn.id),
      ).catch((): ConnectionHealthCheckResult => false);
      // A failure result is an object, and every object is truthy — so `ok`
      // has to be derived explicitly rather than by testing `result`.
      const ok = result === true || (typeof result === 'object' && result.ok);
      if (!publicHandshakeVerified) {
        // The health probe is classification-only after a public handshake
        // failure. It can name a real credential or identity problem, but a
        // green probe cannot make an unverified host compatible or healthy.
        recordEndpointFailure(
          conn.id,
          typeof result === 'object' && !result.ok
            ? result.reason
            : 'unreachable',
        );
        setHealthMap((m) => ({ ...m, [conn.id]: false }));
        return;
      }
      if (ok) {
        recordEndpointSuccess(conn.id, conn.url);
      } else {
        // Reporting every failure as 'unreachable' told users to check the
        // host when the host was fine and had simply rejected the credential,
        // which sent them round the re-pair loop instead of re-authenticating.
        recordEndpointFailure(
          conn.id,
          typeof result === 'object' && !result.ok
            ? result.reason
            : 'unreachable',
        );
      }
      setHealthMap((m) => ({ ...m, [conn.id]: ok }));
    },
    [
      checkHealth,
      getConnectionCredential,
      reconcileHandshake,
      recordEndpointFailure,
      recordEndpointSuccess,
    ],
  );

  const confirmEndpoint = useCallback(
    async (conn: SavedConnection) => {
      const candidate = conn.endpointCandidate;
      if (candidate?.state !== 'confirmation-required') return;
      const credential = getConnectionCredential(conn.id);
      if (!credential) {
        failEndpointCandidate(conn.id);
        return;
      }
      let endpoint: URL;
      try {
        endpoint = new URL(candidate.url);
      } catch {
        failEndpointCandidate(conn.id);
        return;
      }
      const loopback =
        endpoint.hostname === 'localhost' ||
        endpoint.hostname === '127.0.0.1' ||
        endpoint.hostname === '[::1]';
      if (
        endpoint.protocol !== 'https:' &&
        !(loopback && endpoint.protocol === 'http:')
      ) {
        failEndpointCandidate(conn.id);
        return;
      }
      const nonce = createStationProofNonce();
      const proved = await fetch(new URL(PUBLIC_STATION_PROOF_PATH, endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
          nonce,
        }),
      })
        .then(async (response) =>
          response.ok
            ? verifyStationEnvironmentProof({
                credential,
                environmentId: conn.environmentId ?? '',
                nonce,
                response: await response.json(),
              })
            : false,
        )
        .catch(() => false);
      if (proved) commitEndpointCandidate(conn.id);
      else failEndpointCandidate(conn.id);
    },
    [commitEndpointCandidate, failEndpointCandidate, getConnectionCredential],
  );

  /** Resolves to false whenever compatibility cannot be affirmatively proved. */
  const passesCompatibility = useCallback(
    async (url: string): Promise<boolean> => {
      if (!checkCompatibility) {
        setCompatBlock(null);
        setSelectionError(
          'Station compatibility checking is unavailable. This Station cannot be added until the app can verify its compatibility declaration.',
        );
        return false;
      }
      setCompatChecking(true);
      try {
        const result = await checkCompatibility(url);
        if (result.blocking || result.verdict !== 'compatible') {
          if (result.verdict === 'unknown') {
            setCompatBlock(null);
            setSelectionError(result.reason);
          } else {
            setSelectionError(null);
            setCompatBlock(result);
          }
          return false;
        }
        setCompatBlock(null);
        return true;
      } catch {
        setSelectionError(
          'Station compatibility could not be verified. Check reachability to this Station and try again.',
        );
        return false;
      } finally {
        setCompatChecking(false);
      }
    },
    [checkCompatibility],
  );

  const handleAdd = async () => {
    if (!newUrl.trim()) return;
    setSelectionError(null);
    // Default a bare address to HTTPS (the identity-bearing path) before saving;
    // an explicitly typed http:// is kept for raw LAN/direct hosts.
    const url = normalizeHostInput(newUrl);
    // Before the connection exists, not after: a saved-then-broken host is the
    // exact experience this replaces.
    if (!(await passesCompatibility(url))) return;
    const conn = addConnection(newName.trim(), url);
    await setActiveConnection(conn.id);
    setNewName('');
    setNewUrl('');
    void checkOne(conn);
    // Adding a Station should mean getting connected to it: continue straight
    // into the same pairing/access-request exchange as a saved Station that
    // affordance uses, instead of leaving a saved-but-unauthorised connection
    // behind a separate screen the user has to know to find.
    setRequestAccessTarget({ id: conn.id, url: conn.url, name: conn.name });
    setPanel('request-access');
  };

  const resolvePendingTarget = useCallback(
    (endpoint: string, label?: string) => {
      const origin = new URL(endpoint).origin;
      const existing = connections.find((connection) => {
        try {
          return new URL(connection.url).origin === origin;
        } catch {
          return false;
        }
      });
      const target = existing ?? addConnection(label || 'Station', endpoint);
      return {
        targetConnectionId: target.id,
        targetConnectionLabel: target.name || target.url,
      };
    },
    [addConnection, connections],
  );

  const pendingForConnections = connections
    .flatMap((connection) =>
      (['direct', 'code'] as const).map((requestKind) =>
        loadPendingExchange(connection.url, requestKind),
      ),
    )
    .filter(
      (pending): pending is PendingPairingExchange =>
        pending !== null &&
        typeof pending.targetConnectionId === 'string' &&
        typeof pending.targetConnectionLabel === 'string',
    )
    .find((pending) =>
      connections.some(
        (connection) => connection.id === pending.targetConnectionId,
      ),
    );

  const startEdit = (conn: SavedConnection) => {
    setEditingId(conn.id);
    setEditName(conn.name);
    setEditUrl(conn.url);
    setCredentialEntry('');
  };

  const saveEdit = () => {
    if (!editingId) return;
    updateConnection(editingId, { name: editName, url: editUrl });
    if (allowManualCredentials && credentialEntry.trim()) {
      setCredential(editingId, credentialEntry);
    }
    setCredentialEntry('');
    setEditingId(null);
  };

  const statusForConn = (conn: SavedConnection) =>
    getConnectionStatus({
      connectionId: conn.id,
      activeConnectionId: activeConnection?.id,
      healthValue: healthMap[conn.id],
    });

  const reviewConnectionCandidate = useCallback(
    async (candidate: { url: string }): Promise<boolean> => {
      if (candidateReviewControllerRef.current) return false;
      const controller = new AbortController();
      candidateReviewControllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(
          new URL(PUBLIC_STATION_HANDSHAKE_PATH, candidate.url),
          {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          },
        );
        if (!response.ok) return false;
        const handshake = await readCandidateHandshake(response);
        return (
          typeof handshake?.environmentId === 'string' &&
          handshake.environmentId.length > 0 &&
          handshake.authentication?.scheme === 'bearer' &&
          typeof handshake.authentication.protocolVersion === 'number' &&
          Number.isInteger(handshake.authentication.protocolVersion)
        );
      } catch {
        return false;
      } finally {
        window.clearTimeout(timeout);
        if (candidateReviewControllerRef.current === controller) {
          candidateReviewControllerRef.current = null;
        }
      }
    },
    [],
  );

  const handlePaired = useCallback(
    async (result: PairingResult) => {
      // The pairing exchange itself is untouched — this only decides whether
      // the resulting host is worth saving. A blocked verdict leaves the user
      // on the manager with the reason on screen instead of dropping them into
      // a workspace that will misbehave; re-pairing after the update is the
      // recovery, and it costs one screen.
      if (!(await passesCompatibility(result.endpoint))) {
        setPanel('list');
        return;
      }
      const candidate = addConnection('Paired Station', result.endpoint);
      const connectionId = await completeVerifiedPairing(
        {
          commitVerifiedPairing,
          setActiveConnection,
          setCredential,
          markDeviceSession,
          onPairingSucceeded,
        },
        {
          connectionId: candidate.id,
          name: candidate.name,
          endpoint: result.endpoint,
        },
        result,
      );
      const connection =
        reconcileHandshake(connectionId, {
          environmentId: result.environmentId,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        }) ?? candidate;
      setPanel('list');
      // The join panel already detected the confirmed credential (it only
      // calls onPaired once the exchange succeeds) — close the manager so
      // the app lands in the connected workspace instead of idling on the
      // pairing panel underneath a still-open modal.
      onCloseRef.current();
      void checkOne(connection);
    },
    [
      addConnection,
      checkOne,
      commitVerifiedPairing,
      markDeviceSession,
      onPairingSucceeded,
      passesCompatibility,
      reconcileHandshake,
      setActiveConnection,
      setCredential,
    ],
  );

  const handleRequestedAccess = useCallback(
    async (
      target: { id: string; url: string; name: string },
      result: PairingResult,
    ) => {
      // Same defensive check handlePaired runs, but at a later point in the
      // lifecycle: on this path the connection was already saved+activated by
      // handleAdd, so a failure here only withholds the credential commit (the
      // CompatibilityNotice banner explains the still-saved connection).
      if (!(await passesCompatibility(target.url))) {
        setRequestAccessTarget(null);
        setPanel('list');
        return;
      }
      const connectionId = await completeVerifiedPairing(
        {
          commitVerifiedPairing,
          setActiveConnection,
          setCredential,
          markDeviceSession,
          onPairingSucceeded,
        },
        { connectionId: target.id, name: target.name, endpoint: target.url },
        result,
      );
      const connection =
        reconcileHandshake(connectionId, {
          environmentId: result.environmentId,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        }) ??
        connections.find((item) => item.id === connectionId) ??
        null;
      setRequestAccessTarget(null);
      setPanel('list');
      // Same reasoning as handlePaired: the exchange already confirmed the
      // credential, so close the manager into the connected workspace instead
      // of leaving the pairing panel idling underneath a still-open modal.
      onCloseRef.current();
      if (connection) void checkOne(connection);
    },
    [
      checkOne,
      commitVerifiedPairing,
      connections,
      markDeviceSession,
      onPairingSucceeded,
      passesCompatibility,
      reconcileHandshake,
      setActiveConnection,
      setCredential,
    ],
  );

  return (
    // biome-ignore lint/a11y: Backdrop click dismissal has an equivalent document-level Escape handler; the backdrop itself must not enter the tab order.
    <div
      ref={overlayRef}
      className="station-connect-modal-overlay"
      style={visualViewportStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="station-connect-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="station-connect-modal-title"
      >
        <div className="station-connect-modal-header">
          <div className="station-connect-modal-heading">
            <h2
              id="station-connect-modal-title"
              className="station-connect-modal-title"
            >
              {getConnectionManagerTitle(panel)}
            </h2>
            {/*
             * station#4513: this subtitle and the footer's
             * `station-connect-footer__intro` below were the Stations
             * sheet's two intro sentences — deleted, since the row actions
             * (Select, Check reachability, Edit, Forget) and the footer's
             * own labeled buttons (Request access, Add a Station address,
             * Scan a QR code, Enter a pairing code) already say what they
             * do without a preamble above them.
             */}
          </div>
          <button
            type="button"
            className="station-connect-modal-close"
            onClick={onClose}
            aria-label="Close Station manager"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {compatBlock && (
          <Suspense fallback={null}>
            <CompatibilityNotice
              result={compatBlock}
              onDismiss={() => setCompatBlock(null)}
            />
          </Suspense>
        )}
        {defaultMutationError && (
          <div
            role="status"
            className="station-connect-row__meta station-connect-row__meta--warning"
          >
            {defaultMutationError}
          </div>
        )}
        {selectionError && (
          <div
            role="status"
            className="station-connect-row__meta station-connect-row__meta--warning"
          >
            {selectionError}
          </div>
        )}

        {panel === 'list' && (
          <ConnectionListPanel
            connections={connections}
            activeConnectionId={activeConnection?.id}
            editingId={editingId}
            editName={editName}
            editUrl={editUrl}
            credentialEntry={credentialEntry}
            allowManualCredentials={allowManualCredentials}
            getStatus={statusForConn}
            pendingConnectionId={pendingForConnections?.targetConnectionId}
            onSelect={(connection) => {
              void setActiveConnection(connection.id)
                .then(() => {
                  setSelectionError(null);
                  void checkOne(connection);
                })
                .catch((error) => {
                  setSelectionError(
                    `Could not switch Stations: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                });
            }}
            onCheck={checkOne}
            onStartEdit={startEdit}
            onRemove={removeConnection}
            onEditNameChange={setEditName}
            onEditUrlChange={setEditUrl}
            onCredentialEntryChange={setCredentialEntry}
            onRemoveCredential={(id) => {
              removeCredential(id);
              setCredentialEntry('');
            }}
            onConfirmEndpoint={confirmEndpoint}
            onSaveEdit={saveEdit}
            onCancelEdit={() => {
              setEditingId(null);
              setCredentialEntry('');
            }}
            onAddManual={() => setPanel('add')}
            onRestartInjectedConnection={onRestartInjectedConnection}
            onRequestAccess={(connection) => {
              if (!connection) {
                setRequestAccessTarget(null);
                setPanel('request-access');
                return;
              }
              setRequestAccessTarget({
                id: connection.id,
                url: connection.url,
                name: connection.name,
              });
              setPanel('request-access');
            }}
            onMakeDefaultProfile={
              makeDefaultProfile
                ? (connection) => {
                    void makeDefaultProfile(connection.id).catch((error) => {
                      setDefaultMutationError(
                        `Could not set the CLI default: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      );
                    });
                  }
                : undefined
            }
            onScanQr={() => setPanel('pair-device')}
            enterPairingCodeRef={pairingCodeTriggerRef}
            onEnterPairingCode={() => {
              restorePairingCodeFocusRef.current = true;
              setPanel('pair-code');
            }}
            onViewDevices={() => setPanel('devices')}
            discoveryAvailable={providerCount > 0}
            onDiscover={() => {
              setPanel('discover');
              refreshCandidates();
            }}
          />
        )}

        {panel === 'add' && (
          <ManualAddPanel
            name={newName}
            url={newUrl}
            onNameChange={setNewName}
            onUrlChange={setNewUrl}
            onAdd={() => {
              void handleAdd().catch((error) => {
                setSelectionError(
                  `Could not switch Stations: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              });
            }}
            checking={compatChecking}
            onCancel={() => setPanel('list')}
          />
        )}

        {panel === 'request-access' && (
          <JoinDevicePairingPanel
            initialMode="direct"
            directEndpoint={requestAccessTarget?.url}
            directConnectionId={requestAccessTarget?.id}
            directLabel={requestAccessTarget?.name || requestAccessTarget?.url}
            originIsStation={originIsStation}
            hostAppName={hostAppName}
            onCancel={() => {
              setRequestAccessTarget(null);
              setPanel('list');
            }}
            onPaired={(result) =>
              requestAccessTarget
                ? handleRequestedAccess(requestAccessTarget, result)
                : handlePaired(result)
            }
            onApprovalPending={(pending) => {
              if (!onApprovalPending) return;
              const target = requestAccessTarget
                ? {
                    targetConnectionId: requestAccessTarget.id,
                    targetConnectionLabel:
                      requestAccessTarget.name || requestAccessTarget.url,
                  }
                : resolvePendingTarget(pending.endpoint);
              const persisted = { ...pending, ...target };
              savePendingExchange(persisted);
              onApprovalPending(persisted);
              onCloseRef.current();
            }}
          />
        )}

        {panel === 'pair-device' && (
          <JoinDevicePairingPanel
            initialPairingPayload={initialPairingPayload}
            hostAppName={hostAppName}
            onCancel={() => setPanel('list')}
            onPaired={handlePaired}
            onApprovalPending={(pending) => {
              if (!onApprovalPending) return;
              const persisted = {
                ...pending,
                ...resolvePendingTarget(pending.endpoint),
              };
              savePendingExchange(persisted);
              onApprovalPending(persisted);
              onCloseRef.current();
            }}
          />
        )}

        {panel === 'pair-code' && (
          <JoinDevicePairingPanel
            initialMode="manual"
            hostAppName={hostAppName}
            onCancel={() => setPanel('list')}
            onPaired={handlePaired}
            onApprovalPending={(pending) => {
              if (!onApprovalPending) return;
              const persisted = {
                ...pending,
                ...resolvePendingTarget(pending.endpoint),
              };
              savePendingExchange(persisted);
              onApprovalPending(persisted);
              onCloseRef.current();
            }}
          />
        )}

        {panel === 'devices' && (
          <PairedDevicesPanel
            apiBase={activeConnection?.url ?? window.location.origin}
            getCredential={() =>
              activeConnection
                ? getConnectionCredential(activeConnection.id)
                : undefined
            }
            request={authenticatedRequest}
            allowManualCredentials={allowManualCredentials}
            hostAppName={hostAppName}
            onPairDevice={() => setPanel('pair-host')}
            onBack={() => setPanel('list')}
          />
        )}

        {panel === 'pair-host' && (
          <HostDevicePairingPanel
            apiBase={activeConnection?.url ?? window.location.origin}
            publicEndpoint={window.location.origin}
            getCredential={() =>
              activeConnection
                ? getConnectionCredential(activeConnection.id)
                : undefined
            }
            request={authenticatedRequest}
            onCancel={() => setPanel('devices')}
          />
        )}

        {panel === 'discover' && (
          <ConnectionManagerDiscoverPanel
            discovering={discovering}
            candidates={candidates}
            providers={candidateProviders}
            providerCount={providerCount}
            existingUrls={new Set(connections.map((c) => c.url))}
            onRefresh={refreshCandidates}
            onReview={reviewConnectionCandidate}
            onOpen={(candidate) => window.location.assign(candidate.url)}
            onBack={() => {
              cancelCandidateReview();
              setPanel('list');
            }}
          />
        )}
      </div>
    </div>
  );
}
