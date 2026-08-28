import {
  DEFAULT_PAIRING_SCOPE_PRESET,
  type DevicePairingOffer,
  type DevicePairingRequest,
  type PairedDevice,
  type PairingScope,
  type PairingScopePreset,
  pairingScopePresetString,
  type StationProfileCredentialRef,
} from '@kontourai/station-contracts';
import { pairingStateCopy } from '@kontourai/station-contracts/pairing-copy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeDeviceScope, deviceRevokeError } from '../core/deviceActivity';
import {
  deriveDefaultDeviceName,
  type NavigatorUAData,
} from '../core/deviceLabel';
import {
  clearPendingExchange,
  decodeDevicePairingPayload,
  describePairingRequestFailure,
  encodeDevicePairingPayload,
  loadPendingExchange,
  type PendingPairingExchange,
  requestCurrentStationAccess,
  requestDevicePairing,
  type ScannedPairingOffer,
  savePendingExchange,
} from '../core/devicePairing';
import { normalizeHostInput } from '../core/hostInput';
import {
  encodePairingDeepLink,
  type PairingDeepLinkChannel,
} from '../core/pairingDeepLink';
import { completePendingPairing } from '../core/pendingPairingCompletionLoader';
import { PairedDeviceList } from './connection-manager-modal/PairedDeviceList';
import {
  inputStyle,
  primaryBtnStyle,
  secondaryBtnStyle,
} from './connection-manager-modal/styles';
import { HttpsPreferenceHint } from './HttpsPreferenceHint';
import { QRDisplay } from './QRDisplay';
import { QRScanner } from './QRScanner';

export interface PairingResult {
  endpoint: string;
  environmentId: string;
  /** Exact UUID sent in the pairing exchange and recorded by the host grant. */
  clientInstanceId: string;
  device: PairedDevice;
  credential?: string;
  /** Native-only opaque handle; never a bearer value. */
  credentialHandle?: string;
  /** Native host-allocated target keyring reference. */
  credentialRef?: StationProfileCredentialRef;
  browserSession: boolean;
}

function canUseBrowserSession(endpoint: string): boolean {
  return (
    typeof window !== 'undefined' &&
    new URL(endpoint).origin === window.location.origin
  );
}

/**
 * station#1711 — the approve command used to be selectable-monospace-text
 * only, which is not a real affordance on a phone. `command` is always the
 * full, untruncated string; any visual elision (the sibling `<code>`'s CSS
 * ellipsis) is display-only and never affects what gets copied.
 */
function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!showFallback) return;
    fallbackRef.current?.focus();
    fallbackRef.current?.select();
  }, [showFallback]);

  const handleCopy = () => {
    const clipboard =
      typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      // No Clipboard API — most commonly a non-secure context. Select the
      // full command in a visible field so the platform's own copy
      // affordance (long-press on mobile, Ctrl/Cmd+C on desktop) can take it
      // from here. Deliberately never falls back to the deprecated,
      // unreliable `document.execCommand('copy')`.
      setShowFallback(true);
      return;
    }
    clipboard
      .writeText(command)
      .then(() => {
        setShowFallback(false);
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setShowFallback(true));
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <button
        type="button"
        onClick={handleCopy}
        style={{ ...secondaryBtnStyle, whiteSpace: 'nowrap' }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {showFallback && (
        <textarea
          ref={fallbackRef}
          readOnly
          value={command}
          aria-label="Command to copy"
          rows={2}
          onFocus={(event) => event.currentTarget.select()}
          style={{
            width: '100%',
            fontFamily: 'monospace',
            fontSize: 12,
            resize: 'none',
          }}
        />
      )}
    </div>
  );
}

export function JoinDevicePairingPanel({
  onPaired,
  onCancel,
  onApprovalPending,
  initialMode = 'scan',
  originIsStation = true,
  hostAppName,
  directEndpoint,
  directConnectionId,
  directLabel,
  initialPairingPayload,
}: {
  onPaired: (result: PairingResult) => void | Promise<void>;
  onCancel: () => void;
  /**
   * Hand a persisted approval request to persistent connection chrome. The
   * caller can close its fixed-geometry chooser without abandoning the
   * bounded exchange.
   */
  onApprovalPending?: (pending: PendingPairingExchange) => void;
  initialMode?: 'direct' | 'scan' | 'manual';
  /**
   * True when the page was served by a Station host, so `window.location.origin`
   * is a usable direct-request target (the web case). Defaults to true to keep
   * the served-from-Station behavior back-compatible. In a native shell (or any
   * context where the origin is not a Station host — e.g. `tauri://localhost`),
   * the app layer passes false so the direct "Request access" flow collects a
   * host address first instead of failing against a non-Station origin.
   * Ignored when `directEndpoint` is set.
   */
  originIsStation?: boolean;
  /**
   * Name of the native shell hosting this UI, when it is not a browser. Inside
   * the desktop/mobile shells the WebView's brand is an implementation detail
   * the user should never see in their own device name.
   */
  hostAppName?: string;
  /**
   * Send the direct access request straight to this host instead of the page
   * origin or a manually entered address. Set when the caller already knows
   * the target — continuing straight from "Add a Station" into pairing, or
   * re-authorising one existing connection from its row — so the panel never
   * asks the user to re-enter (or disambiguate) a host it already has.
   * Takes precedence over `originIsStation`.
   */
  directEndpoint?: string;
  /** Saved connection identity for a direct request-access target. */
  directConnectionId?: string;
  /**
   * Host name shown in place of "this Station" when `directEndpoint` is set,
   * so the request names what it targets even outside a browser (where no
   * page origin exists to imply it).
   */
  directLabel?: string;
  /** A protocol-validated QR/CLI payload that still requires confirmation. */
  initialPairingPayload?: string;
}) {
  const [mode, setMode] = useState<'direct' | 'scan' | 'manual'>(initialMode);
  const [deviceName, setDeviceName] = useState(
    hostAppName ? 'This device' : 'This browser',
  );
  // Device detection is only allowed to own this value until the user begins
  // interacting with the field. Claim ownership on focus, before a browser's
  // multi-step fill/edit sequence starts: the async Client Hints promise can
  // otherwise resolve between focus/selection and the input event, replacing
  // the selected value so the user's text is appended to the detected label.
  const deviceNameOwnedByUserRef = useRef(false);
  const [manualEndpoint, setManualEndpoint] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [reviewOffer, setReviewOffer] = useState<ScannedPairingOffer | null>(
    () =>
      initialPairingPayload
        ? decodeDevicePairingPayload(initialPairingPayload)
        : null,
  );
  // station#1711 — a caller-known endpoint (a re-authorize target, or
  // the page origin itself) is the only kind of endpoint this panel can know
  // before any user action, so it is the only one restoration can check at
  // mount. The QR/manual-code flows persist their own pending exchange too
  // (see `begin`/`beginManual` below), but restoring THOSE requires the user
  // to re-enter the same endpoint first — there is nothing to look up yet.
  //
  // Gated on `initialMode === 'direct'` for that reason alone now: the
  // pending-exchange storage key is origin-AND-kind-scoped
  // (`pendingExchangeStorageKey`), so a scan/manual panel mounted at the same
  // origin a direct request-access panel already used
  // (`ConnectionManagerModalContent`'s 'pair-device' and 'request-access'
  // panels both default to `window.location.origin`) computes a different
  // key and cannot restore or delete the direct flow's record even if it
  // tried. A caller mounted in any other mode simply has no restorable
  // endpoint to look up yet.
  const restorableEndpoint =
    initialMode === 'direct'
      ? directEndpoint
        ? directEndpoint
        : originIsStation && typeof window !== 'undefined'
          ? window.location.origin
          : undefined
      : undefined;
  const [pending, setPending] = useState<PendingPairingExchange | null>(() =>
    restorableEndpoint
      ? loadPendingExchange(restorableEndpoint, 'direct')
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  // Set while the exchange is retrying something worth waiting out, so the
  // panel says why nothing is happening instead of sitting mute.
  const [waitingOnConnection, setWaitingOnConnection] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // Default the device-name field from the browser's own identity so the
  // approver can recognize the request at a glance; the field stays
  // user-editable and this never overwrites a name the user already typed.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    let cancelledEffect = false;
    void deriveDefaultDeviceName({
      userAgentData: (
        navigator as Navigator & { userAgentData?: NavigatorUAData }
      ).userAgentData,
      userAgent: navigator.userAgent,
      ...(hostAppName ? { hostAppName } : {}),
    }).then((label) => {
      if (!cancelledEffect && !deviceNameOwnedByUserRef.current) {
        setDeviceName(label);
      }
    });
    return () => {
      cancelledEffect = true;
    };
  }, [hostAppName]);

  useEffect(() => {
    if (!initialPairingPayload) return;
    const offer = decodeDevicePairingPayload(initialPairingPayload);
    if (offer) setReviewOffer(offer);
    else setError('This Station pairing offer is invalid or expired.');
  }, [initialPairingPayload]);

  useEffect(() => {
    if (!pending) return;
    let disposed = false;
    let resumedAfterSharedAbort = false;
    const abort = new AbortController();
    const runCompletion = () => {
      void completePendingPairing(pending, {
        signal: abort.signal,
        onProgress: ({ status }) => {
          if (disposed) return;
          setWaitingOnConnection(status === 'waiting-for-connection');
        },
        completePaired: async (result) => {
          try {
            await onPaired({ ...result, endpoint: pending.endpoint });
            return { status: 'completed' } as const;
          } catch {
            return { status: 'failed', failure: null } as const;
          }
        },
      }).then((completion) => {
        if (disposed || cancelled.current || completion.status === 'aborted') {
          // A different subscriber can have cancelled an unspent shared flight
          // between this panel mounting and its subscription. Its settlement
          // removes that flight; retry once through the normal Interface so this
          // still-live panel resumes its persisted request rather than stranding
          // it behind somebody else's lifecycle.
          if (
            !disposed &&
            !cancelled.current &&
            completion.status === 'aborted' &&
            !abort.signal.aborted &&
            !resumedAfterSharedAbort
          ) {
            resumedAfterSharedAbort = true;
            runCompletion();
          }
          return;
        }
        if (completion.status === 'paired') {
          setWaitingOnConnection(false);
          setPending(null);
          return;
        }
        if (completion.status === 'post-exchange-failed') {
          setError(
            'This device was paired, but the Station could not be saved here.',
          );
          setPending(null);
          return;
        }

        // The shared pairing-state map (station#3849) — this surface is the
        // dialog the reader opened for ONE request, so it takes the
        // request-subject decline; `PendingPairingReconciler` renders chrome
        // about a device and takes the other. The two states this map does
        // not carry stay here.
        const message =
          completion.status === 'declined'
            ? pairingStateCopy('declined-access-request', directLabel).message
            : completion.status === 'expired'
              ? pairingStateCopy(
                  pending.requestKind === 'direct'
                    ? 'expired-access-request'
                    : 'expired-pairing-code',
                  directLabel,
                ).message
              : completion.status === 'identity-changed'
                ? 'The Station identity changed during pairing.'
                : 'Pairing failed. Check the code and try again.';
        setError(message);
        setPending(null);
      });
    };
    runCompletion();

    return () => {
      disposed = true;
      abort.abort();
    };
  }, [directLabel, onPaired, pending]);

  const begin = async (offer: ScannedPairingOffer) => {
    setError(null);
    setWaitingOnConnection(false);
    try {
      const request = await requestDevicePairing({
        endpoint: offer.endpoint,
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName,
      });
      const nextPending: PendingPairingExchange = {
        // station#1876: stamped so the app-level gate can show a real
        // progress bar during the approval wait instead of a spinner.
        requestedAt: Date.now(),
        endpoint: offer.endpoint,
        offerId: request.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        expiresAt: offer.expiresAt,
        expectedEnvironmentId: offer.environmentId,
        browserSession: canUseBrowserSession(offer.endpoint),
        requestKind: 'code',
      };
      // station#1711 — persisted before the poll starts, so the exchange
      // survives an unmount from this point on.
      savePendingExchange(nextPending);
      setPending(nextPending);
      onApprovalPending?.(nextPending);
    } catch (requestError) {
      setError(describePairingRequestFailure(requestError));
    }
  };

  const beginManual = async () => {
    setError(null);
    setWaitingOnConnection(false);
    let endpoint: string;
    try {
      endpoint = new URL(normalizeHostInput(manualEndpoint)).origin;
    } catch {
      // Parsed before the request so this message covers only the one thing
      // it can honestly claim. Everything the host itself refuses is named by
      // `describePairingRequestFailure` below, instead of being blamed on an
      // address that was fine.
      setError('The server address is not valid.');
      return;
    }
    try {
      const request = await requestDevicePairing({
        endpoint,
        offerId: '',
        proof: manualCode.trim().toUpperCase(),
        deviceName,
      });
      const nextPending: PendingPairingExchange = {
        // station#1876: stamped so the app-level gate can show a real
        // progress bar during the approval wait instead of a spinner.
        requestedAt: Date.now(),
        endpoint,
        offerId: request.offerId,
        proof: manualCode.trim().toUpperCase(),
        requestId: request.requestId,
        expiresAt: Date.now() + 5 * 60_000,
        browserSession: canUseBrowserSession(endpoint),
        requestKind: 'code',
      };
      savePendingExchange(nextPending);
      setPending(nextPending);
      onApprovalPending?.(nextPending);
    } catch (requestError) {
      setError(describePairingRequestFailure(requestError));
    }
  };

  const reviewPayload = (payload: string) => {
    const offer = decodeDevicePairingPayload(payload.trim());
    if (!offer) {
      setError('This is not a valid Station pairing code.');
      return;
    }
    setError(null);
    setReviewOffer(offer);
  };

  const pastePairingPayload = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      setError(
        'Clipboard paste is unavailable. Enter the Station address and code manually.',
      );
      return;
    }
    void navigator.clipboard
      .readText()
      .then(reviewPayload)
      .catch(() =>
        setError(
          'Clipboard paste is unavailable. Enter the Station address and code manually.',
        ),
      );
  };

  // A caller-supplied target wins outright: it already names the exact host
  // to request access from, so neither the page origin nor a typed address
  // applies. Otherwise fall back to the existing origin/manual-entry split.
  const knowsEndpoint = Boolean(directEndpoint) || originIsStation;

  const beginDirect = async () => {
    setError(null);
    setWaitingOnConnection(false);
    try {
      // When the page was served by a Station, the origin is the host itself
      // (web case). Otherwise (native shell), target the host the user entered
      // in the address field this panel now presents up front.
      const endpoint = directEndpoint
        ? directEndpoint
        : originIsStation
          ? window.location.origin
          : new URL(normalizeHostInput(manualEndpoint)).origin;
      const request = await requestCurrentStationAccess({
        endpoint,
        deviceName,
      });
      if (
        !request.offerId ||
        !request.proof ||
        !request.requestId ||
        request.expiresAt === undefined
      ) {
        setError(
          'This Station returned an unexpected access-request response.',
        );
        return;
      }
      const nextPending: PendingPairingExchange = {
        // station#1876: stamped so the app-level gate can show a real
        // progress bar during the approval wait instead of a spinner.
        requestedAt: Date.now(),
        endpoint,
        offerId: request.offerId,
        proof: request.proof,
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        expectedEnvironmentId: request.environmentId,
        // A served-from-Station request keeps its same-origin browser session;
        // a request to an entered or caller-supplied host uses the same origin
        // check the coded flows use (cross-origin → the host issues a bearer
        // credential). `originIsStation` only applies to the page-origin case,
        // so a direct target decides this for itself instead of inheriting
        // that flag's `true` default.
        browserSession: directEndpoint
          ? canUseBrowserSession(endpoint)
          : originIsStation || canUseBrowserSession(endpoint),
        requestKind: 'direct',
        ...(directConnectionId
          ? {
              targetConnectionId: directConnectionId,
              targetConnectionLabel: directLabel || endpoint,
            }
          : {}),
      };
      savePendingExchange(nextPending);
      setPending(nextPending);
      onApprovalPending?.(nextPending);
    } catch (requestError) {
      const status = (requestError as { status?: number }).status;
      setError(
        status === 403
          ? 'This Station does not allow access requests from this app address.'
          : status === 429
            ? 'Too many access requests. Wait a moment, then try again.'
            : 'This Station could not create an access request. Try again.',
      );
    }
  };

  if (pending) {
    const target = directLabel || 'this Station';
    const approveCommand = `station environment access approve ${pending.requestId}`;
    return (
      <div role="status" style={{ display: 'grid', gap: 12 }}>
        <strong>
          {waitingOnConnection
            ? `Waiting to reach ${target}…`
            : pairingStateCopy(
                pending.requestKind === 'direct'
                  ? 'waiting-for-approval'
                  : 'waiting-for-code-approval',
                directLabel,
              ).message}
        </strong>
        {waitingOnConnection && (
          <span style={{ color: 'var(--text-secondary, #999)', fontSize: 13 }}>
            The request is still open and will continue as soon as this device
            can reach {target} again.
          </span>
        )}
        {/*
         * station#1776/#1711 — one actionable sentence naming the device and
         * the host. The prior second sentence ("This request cannot approve
         * itself or reveal a reusable credential") described our own
         * security design, not something the person reading it could act
         * on — deleted from this screen.
         */}
        <span style={{ color: 'var(--text-secondary, #999)', fontSize: 13 }}>
          Approve “{deviceName}” on {target} to finish.
        </span>
        {pending.requestKind === 'direct' && (
          // Closed by default: this is available when no other
          // trusted session is available, not the instruction. The command
          // itself gets a Copy button — the wrapped monospace text beneath
          // it used to be the only way to grab it, which is unselectable on
          // a phone (station#1711).
          <details>
            <summary
              style={{
                color: 'var(--text-secondary, #999)',
                fontSize: 13,
                cursor: 'pointer',
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Approve from the Station instead
            </summary>
            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'stretch',
                }}
              >
                <code
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    display: 'block',
                    padding: '6px 8px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    border: '1px solid var(--border-primary, #333)',
                    borderRadius: 4,
                  }}
                  title={approveCommand}
                >
                  {approveCommand}
                </code>
                <CopyCommandButton command={approveCommand} />
              </div>
              <small style={{ color: 'var(--text-secondary, #999)' }}>
                Run this on the Station or over SSH. From a source checkout, use{' '}
                <code>./station</code>.
              </small>
            </div>
          </details>
        )}
        {pending.browserSession && (
          <span style={{ color: 'var(--text-secondary, #999)', fontSize: 13 }}>
            After approval, this browser stays paired until you revoke it or
            clear its site data.
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            // station#1711 — a deliberate "stop waiting" is a genuine
            // terminal outcome, distinct from the unmounts (closing the
            // whole dialog, navigating away, the app being backgrounded or
            // killed) this persistence exists to survive: only THIS action
            // is the user explicitly abandoning the request, so only this
            // action clears the stored record.
            clearPendingExchange(pending.endpoint, pending.requestKind);
            onCancel();
          }}
          style={secondaryBtnStyle}
        >
          Stop waiting
        </button>
      </div>
    );
  }

  if (reviewOffer) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <strong>Review pairing offer</strong>
        <dl
          aria-label="Pairing offer details"
          style={{
            color: 'var(--text-secondary, #999)',
            display: 'grid',
            fontSize: 13,
            gap: 4,
            margin: 0,
          }}
        >
          <dt>Backend environment identity</dt>
          <dd style={{ margin: 0 }}>
            <code>{reviewOffer.environmentId}</code>
          </dd>
          <dt>Endpoint</dt>
          <dd style={{ margin: 0 }}>{reviewOffer.endpoint}</dd>
          <dt>Expires at</dt>
          <dd style={{ margin: 0 }}>
            {new Date(reviewOffer.expiresAt).toLocaleTimeString()}
          </dd>
        </dl>
        <button
          type="button"
          onClick={() => void begin(reviewOffer)}
          style={primaryBtnStyle}
        >
          Request access
        </button>
        <button
          type="button"
          onClick={() => setReviewOffer(null)}
          style={secondaryBtnStyle}
        >
          Choose another method
        </button>
        {error && <div role="alert">{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
        Device name
        <input
          value={deviceName}
          maxLength={64}
          onFocus={() => {
            deviceNameOwnedByUserRef.current = true;
          }}
          onChange={(event) => {
            deviceNameOwnedByUserRef.current = true;
            setDeviceName(event.target.value);
          }}
          style={inputStyle}
        />
      </label>
      {mode !== 'direct' && (
        <fieldset
          style={{ border: 0, display: 'grid', gap: 6, margin: 0, padding: 0 }}
        >
          <legend
            style={{ color: 'var(--text-secondary, #999)', fontSize: 12 }}
          >
            Pairing method
          </legend>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setMode('scan')}
              aria-pressed={mode === 'scan'}
              style={mode === 'scan' ? primaryBtnStyle : secondaryBtnStyle}
            >
              Scan code
            </button>
            <button
              type="button"
              onClick={() => setMode('manual')}
              aria-pressed={mode === 'manual'}
              style={mode === 'manual' ? primaryBtnStyle : secondaryBtnStyle}
            >
              Enter manually
            </button>
          </div>
        </fieldset>
      )}
      {mode === 'direct' ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary, #999)',
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            {directLabel
              ? `Send a short-lived request to ${directLabel}. Approve it once from an already trusted session; this device will reconnect automatically afterward.`
              : originIsStation
                ? 'Send a short-lived request to this Station. Approve it once from an already trusted session; this device will reconnect automatically afterward.'
                : 'Enter your Station address, then send a short-lived access request. Approve it once from an already trusted session; this device reconnects automatically afterward.'}
          </p>
          {!knowsEndpoint && (
            <input
              aria-label="Station server address"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://station.example.ts.net"
              value={manualEndpoint}
              onChange={(event) => setManualEndpoint(event.target.value)}
              style={inputStyle}
            />
          )}
          {!knowsEndpoint && <HttpsPreferenceHint address={manualEndpoint} />}
          <button type="button" onClick={beginDirect} style={primaryBtnStyle}>
            Request access
          </button>
          <button type="button" onClick={onCancel} style={secondaryBtnStyle}>
            Back
          </button>
        </div>
      ) : mode === 'scan' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <p
            style={{
              margin: 0,
              color: 'var(--text-secondary, #999)',
              fontSize: 12,
            }}
          >
            Camera scanning requires HTTPS or localhost. Enter the Station
            address and code manually if camera access is unavailable.
          </p>
          <button
            type="button"
            onClick={pastePairingPayload}
            style={secondaryBtnStyle}
          >
            Paste pairing code
          </button>
          <QRScanner
            onScan={(payload) => {
              reviewPayload(payload);
            }}
            onCancel={onCancel}
            onManualEntry={() => {
              setError(null);
              setMode('manual');
            }}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <button
            type="button"
            onClick={pastePairingPayload}
            style={secondaryBtnStyle}
          >
            Paste pairing code
          </button>
          <input
            aria-label="Station server address"
            inputMode="url"
            autoCapitalize="none"
            placeholder="https://station.example.ts.net"
            value={manualEndpoint}
            onChange={(event) => setManualEndpoint(event.target.value)}
            style={inputStyle}
          />
          <HttpsPreferenceHint address={manualEndpoint} />
          <input
            aria-label="Pairing code"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            placeholder="10-character code"
            value={manualCode}
            onChange={(event) => setManualCode(event.target.value)}
            style={inputStyle}
          />
          <button type="button" onClick={beginManual} style={primaryBtnStyle}>
            Request access
          </button>
          <button type="button" onClick={onCancel} style={secondaryBtnStyle}>
            Back
          </button>
        </div>
      )}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

function authHeaders(credential: string | undefined): HeadersInit {
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

async function pairingOfferError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: string | { code?: string } }
    | undefined;
  const code = typeof body?.error === 'string' ? body.error : body?.error?.code;

  if (response.status === 401 || code === 'authentication_required') {
    return "This device's access to this Station needs review. Reconnect it, then try again.";
  }
  if (response.status === 403 || code === 'origin_forbidden') {
    return 'This Station does not allow pairing from the current app address. Update its trusted app address, then try again.';
  }
  if (response.status === 429 || code === 'rate_limited') {
    const retryAfter = response.headers.get('Retry-After');
    const retryAfterSeconds =
      retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : 0;
    return retryAfterSeconds > 0 && retryAfterSeconds <= 86_400
      ? `Too many pairing attempts. Try again in ${retryAfterSeconds} seconds.`
      : 'Too many pairing attempts. Wait a moment, then try again.';
  }
  if (
    response.status === 400 ||
    response.status === 422 ||
    code === 'invalid_request'
  ) {
    return 'Use a valid HTTPS address that the other device can reach.';
  }
  return `This Station could not create a pairing code (HTTP ${response.status}).`;
}

function isDevicePairingOffer(value: unknown): value is DevicePairingOffer {
  if (!value || typeof value !== 'object') return false;
  const offer = value as Partial<DevicePairingOffer>;
  return (
    typeof offer.protocolVersion === 'number' &&
    typeof offer.environmentId === 'string' &&
    typeof offer.offerId === 'string' &&
    typeof offer.challenge === 'string' &&
    typeof offer.manualCode === 'string' &&
    typeof offer.endpoint === 'string' &&
    typeof offer.scope === 'string' &&
    typeof offer.expiresAt === 'number'
  );
}

/**
 * The presets THIS interactive device-pairing UI offers. Standard is the
 * default — the read-only preset is an explicit opt-in for a device the
 * operator wants to intentionally under-power (e.g. "pair my phone
 * read-only" from the issue's story).
 *
 * station#1123 slice 1 added a third preset, `'delegation'`, to
 * `PAIRING_SCOPE_PRESETS` — deliberately NOT offered here. This flow pairs
 * an interactive device a human is holding (QR/manual code, joiner names
 * itself); a delegation grant is for a PEER STATION and is minted through
 * the dedicated provisioning path (`station environment peers add` /
 * `POST /api/environments/peers`), not this UI. Slice 5 ("Add a peer" UI)
 * is where a delegation-producing flow would live, if one is ever built
 * here at all. Iterating a fixed tuple rather than
 * `Object.keys(PAIRING_SCOPE_PRESETS)` keeps this screen byte-identical as
 * the preset set grows.
 */
const OFFERED_SCOPE_PRESETS = [
  'standard',
  'read-only',
] as const satisfies readonly PairingScopePreset[];

const SCOPE_PRESET_COPY: Record<
  (typeof OFFERED_SCOPE_PRESETS)[number],
  { label: string; description: string }
> = {
  standard: {
    label: 'Standard',
    description: 'Can read, operate, and open a terminal.',
  },
  'read-only': {
    label: 'Read-only',
    description:
      'Can view and stream state. Cannot mutate anything or open a terminal.',
  },
};

function requestExpiryLabel(expiresAt: number, now: number): string {
  if (!Number.isFinite(expiresAt)) return 'Short-lived request';
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (remainingSeconds === 0) return 'Expiring now';
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return minutes > 0
    ? `Expires in ${minutes}m ${seconds.toString().padStart(2, '0')}s`
    : `Expires in ${seconds}s`;
}

export function HostDevicePairingPanel({
  apiBase,
  publicEndpoint,
  getCredential,
  request = fetch,
  onCancel,
  initialClientChannel = 'stable',
}: {
  apiBase: string;
  publicEndpoint: string;
  getCredential: () => string | undefined;
  request?: typeof fetch;
  onCancel: () => void;
  /** Host-facing route selector; it never constrains the paired backend. */
  initialClientChannel?: Exclude<PairingDeepLinkChannel, 'dev'>;
}) {
  const [offer, setOffer] = useState<DevicePairingOffer | null>(null);
  const [requests, setRequests] = useState<DevicePairingRequest[]>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState(publicEndpoint);
  const [scopePreset, setScopePreset] = useState<PairingScopePreset>(
    DEFAULT_PAIRING_SCOPE_PRESET,
  );
  const [clientChannel, setClientChannel] =
    useState<Exclude<PairingDeepLinkChannel, 'dev'>>(initialClientChannel);
  const [requestActionIds, setRequestActionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [deviceActionIds, setDeviceActionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [now, setNow] = useState(Date.now());
  const refreshGeneration = useRef(0);
  const requestActionIdsRef = useRef(new Set<string>());
  const deviceActionIdsRef = useRef(new Set<string>());
  const payload = useMemo(
    () => (offer ? encodeDevicePairingPayload(offer) : ''),
    [offer],
  );
  const pairingLink = useMemo(
    () =>
      payload ? encodePairingDeepLink({ payload, clientChannel }) : undefined,
    [clientChannel, payload],
  );

  const authenticatedFetch = useCallback(
    async (path: string, init: RequestInit = {}) =>
      request(new URL(path, apiBase), {
        ...init,
        headers: { ...authHeaders(getCredential()), ...init.headers },
      }),
    [apiBase, getCredential, request],
  );

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const [requestResponse, deviceResponse] = await Promise.all([
        authenticatedFetch('/api/pairing/requests'),
        authenticatedFetch('/api/pairing/devices'),
      ]);
      const [requestBody, deviceBody] = await Promise.all([
        requestResponse.ok ? requestResponse.json() : undefined,
        deviceResponse.ok ? deviceResponse.json() : undefined,
      ]);
      if (generation !== refreshGeneration.current) return;
      if (requestBody) setRequests(requestBody.requests ?? []);
      if (deviceBody) setDevices(deviceBody.devices ?? []);
    } catch {
      // Polling is best-effort. A later generation retries without allowing a
      // slow or failed response to overwrite newer inbox state.
    }
  }, [authenticatedFetch]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 1_000);
    return () => {
      clearInterval(timer);
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  const actOnRequest = async (
    request: DevicePairingRequest,
    action: 'approve' | 'deny',
  ) => {
    if (requestActionIdsRef.current.has(request.requestId)) return;
    setError(null);
    refreshGeneration.current += 1;
    requestActionIdsRef.current.add(request.requestId);
    setRequestActionIds(new Set(requestActionIdsRef.current));
    try {
      const response = await authenticatedFetch(
        `/api/pairing/requests/${request.requestId}${
          action === 'approve' ? '/confirm' : ''
        }`,
        { method: action === 'approve' ? 'POST' : 'DELETE' },
      );
      if (!response.ok) {
        setError(
          response.status === 401
            ? "This device's access to this Station needs review. Reconnect it, then try again."
            : // station#1490: this Station refuses to approve THIS request from
              // a session that presented no credential — the "a request cannot
              // approve itself" line this panel already prints to the joiner,
              // now enforced by the pairing service rather than implied. The
              // remedy is a different, credentialed session, so name the one
              // that always exists on the host.
              response.status === 403 && action === 'approve'
              ? `Approving “${request.deviceName}” needs a trusted Station session. Run this on the Station: station environment access approve ${request.requestId} --force`
              : response.status === 404 || response.status === 410
                ? 'That access request has already expired or been removed.'
                : `This Station could not ${action} that access request. Try again.`,
        );
        return;
      }
      await refresh();
    } catch {
      setError(
        `This Station could not ${action} that access request. Try again.`,
      );
    } finally {
      requestActionIdsRef.current.delete(request.requestId);
      setRequestActionIds(new Set(requestActionIdsRef.current));
    }
  };

  /**
   * Revocation used to ignore the response entirely, so a rejected revoke —
   * an expired credential, a device already gone — refreshed the list and left
   * the user believing access had been cut. It reports failure now.
   */
  /** station#3816: same authority and error shape as revoking. */
  const changeDeviceScope = async (
    device: PairedDevice,
    scope: PairingScope[],
    expectedScope: string,
  ) => {
    if (deviceActionIdsRef.current.has(device.id)) return;
    setError(null);
    deviceActionIdsRef.current.add(device.id);
    setDeviceActionIds(new Set(deviceActionIdsRef.current));
    try {
      const response = await authenticatedFetch(
        `/api/pairing/devices/${device.id}/scope`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope, expectedScope }),
        },
      );
      if (!response.ok) {
        setError(
          `This Station refused the access change (HTTP ${response.status}). The device keeps its current access.`,
        );
        return;
      }
      await refresh();
    } catch {
      setError(
        `This Station could not change access for “${device.name}”. Check the connection — its current access is unchanged.`,
      );
    } finally {
      deviceActionIdsRef.current.delete(device.id);
      setDeviceActionIds(new Set(deviceActionIdsRef.current));
    }
  };

  const revokeDevice = async (device: PairedDevice) => {
    if (deviceActionIdsRef.current.has(device.id)) return;
    setError(null);
    deviceActionIdsRef.current.add(device.id);
    setDeviceActionIds(new Set(deviceActionIdsRef.current));
    try {
      const response = await authenticatedFetch(
        `/api/pairing/devices/${device.id}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        setError(deviceRevokeError(response.status));
        return;
      }
      await refresh();
    } catch {
      setError(
        `This Station could not revoke “${device.name}”. Check the connection, then try again.`,
      );
    } finally {
      deviceActionIdsRef.current.delete(device.id);
      setDeviceActionIds(new Set(deviceActionIdsRef.current));
    }
  };

  const removeRevokedDevice = async (device: PairedDevice) => {
    if (deviceActionIdsRef.current.has(device.id)) return;
    setError(null);
    deviceActionIdsRef.current.add(device.id);
    setDeviceActionIds(new Set(deviceActionIdsRef.current));
    try {
      const response = await authenticatedFetch(
        `/api/pairing/devices/${device.id}/record`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        setError(
          `This Station could not remove the revoked record for “${device.name}” (HTTP ${response.status}).`,
        );
        return;
      }
      await refresh();
    } catch {
      setError(
        `This Station could not remove the revoked record for “${device.name}”. Check the connection, then try again.`,
      );
    } finally {
      deviceActionIdsRef.current.delete(device.id);
      setDeviceActionIds(new Set(deviceActionIdsRef.current));
    }
  };

  const createOffer = async () => {
    setError(null);
    try {
      const response = await authenticatedFetch('/api/pairing/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint,
          scope: pairingScopePresetString(scopePreset),
        }),
      });
      if (!response.ok) {
        setError(await pairingOfferError(response));
        return;
      }
      const value: unknown = await response.json();
      if (!isDevicePairingOffer(value)) throw new Error('Invalid offer');
      setOffer(value);
    } catch {
      setError(
        'This Station could not create a pairing code. Check the connection, then try again.',
      );
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {requests.length > 0 && (
        <section
          aria-label="Device access requests"
          style={{ display: 'grid', gap: 10 }}
        >
          <strong>Access requests</strong>
          {requests.map((request) => (
            <div
              key={request.requestId}
              style={{
                display: 'grid',
                gap: 8,
                padding: 12,
                border: '1px solid var(--border-primary, #333)',
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <strong>{request.deviceName}</strong>
                {request.source === 'tailnet' && request.requester && (
                  <span
                    style={{
                      color: 'var(--text-secondary, #999)',
                      fontSize: 13,
                    }}
                  >
                    {request.requester.displayName ?? request.requester.login}
                  </span>
                )}
              </div>
              <span style={{ color: 'var(--text-secondary, #999)' }}>
                Requests {describeDeviceScope(request.scope)}
              </span>
              <small style={{ color: 'var(--text-secondary, #999)' }}>
                {request.source === 'tailnet'
                  ? `Verified by Tailscale${
                      request.requester?.displayName
                        ? ` · ${request.requester.displayName}`
                        : ''
                    }`
                  : request.source === 'same-origin'
                    ? 'Requested from this Station address'
                    : 'Requested with a pairing code'}
              </small>
              {request.source === 'tailnet' && request.requester?.login && (
                <small style={{ color: 'var(--text-secondary, #999)' }}>
                  {request.requester.login}
                </small>
              )}
              <small style={{ color: 'var(--text-secondary, #999)' }}>
                {requestExpiryLabel(request.expiresAt, now)}
              </small>
              {request.status === 'pending' ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                    gap: 8,
                  }}
                >
                  <button
                    type="button"
                    style={primaryBtnStyle}
                    disabled={requestActionIds.has(request.requestId)}
                    onClick={() => void actOnRequest(request, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    style={secondaryBtnStyle}
                    disabled={requestActionIds.has(request.requestId)}
                    onClick={() => void actOnRequest(request, 'deny')}
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <>
                  <span role="status">Approved — waiting for device</span>
                  <button
                    type="button"
                    style={secondaryBtnStyle}
                    disabled={requestActionIds.has(request.requestId)}
                    onClick={() => void actOnRequest(request, 'deny')}
                  >
                    Cancel approval
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {!offer ? (
        <>
          <p style={{ margin: 0, color: 'var(--text-secondary, #999)' }}>
            The easiest path is to open this Station on the other device and
            choose <strong>Request access</strong>. Create a five-minute code
            only when that is not available. The other device receives a
            credential only after you confirm its name here.
          </p>
          <fieldset
            style={{
              display: 'grid',
              gap: 8,
              border: '1px solid var(--border-primary, #333)',
              borderRadius: 8,
              padding: 12,
              margin: 0,
            }}
          >
            <legend
              style={{ color: 'var(--text-secondary, #999)', padding: '0 4px' }}
            >
              Access
            </legend>
            {OFFERED_SCOPE_PRESETS.map((preset) => (
              <label
                key={preset}
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}
              >
                <input
                  type="radio"
                  name="pairing-scope-preset"
                  value={preset}
                  checked={scopePreset === preset}
                  onChange={() => setScopePreset(preset)}
                />
                <span>
                  <strong>{SCOPE_PRESET_COPY[preset].label}</strong>
                  <br />
                  <small style={{ color: 'var(--text-secondary, #999)' }}>
                    {SCOPE_PRESET_COPY[preset].description}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" onClick={createOffer} style={primaryBtnStyle}>
            Create pairing code
          </button>
          <details>
            <summary
              style={{
                color: 'var(--text-secondary, #999)',
                cursor: 'pointer',
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Use a different Station address
            </summary>
            <label style={{ display: 'grid', gap: 6 }}>
              Address the other device can reach
              <input
                aria-label="Pairing endpoint"
                inputMode="url"
                autoCapitalize="none"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                style={inputStyle}
              />
            </label>
          </details>
        </>
      ) : (
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10 }}>
          <QRDisplay
            url={payload}
            size={200}
            label="Single-use Station offer"
          />
          <div>
            Manual code: <strong>{offer.manualCode}</strong>
          </div>
          <small style={{ color: 'var(--text-secondary, #999)' }}>
            Access: {describeDeviceScope(offer.scope)}
          </small>
          <small>
            Expires {new Date(offer.expiresAt).toLocaleTimeString()}
          </small>
          <label style={{ display: 'grid', gap: 6, width: '100%' }}>
            Open this installed Station client
            <select
              aria-label="Pairing client channel"
              value={clientChannel}
              onChange={(event) =>
                setClientChannel(
                  event.target.value as Exclude<PairingDeepLinkChannel, 'dev'>,
                )
              }
              style={inputStyle}
            >
              <option value="stable">Station</option>
              <option value="beta">Station Beta</option>
              <option value="nightly">Station Nightly</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(pairingLink ?? '')
            }
            style={secondaryBtnStyle}
          >
            Copy pairing link
          </button>
          <small style={{ color: 'var(--text-secondary, #999)' }}>
            The QR code remains the raw pairing payload for scanners. If no app
            handles the copied custom scheme, install the selected channel,
            select another channel, or paste the raw payload into Join.
          </small>
        </div>
      )}

      {devices.length > 0 && (
        <section aria-label="Paired devices">
          <PairedDeviceList
            devices={devices}
            now={now}
            onRevoke={(device) => void revokeDevice(device)}
            onRemoveRevoked={(device) => void removeRevokedDevice(device)}
            onChangeScope={(device, scope, expectedScope) =>
              void changeDeviceScope(device, scope, expectedScope)
            }
            busyIds={deviceActionIds}
          />
        </section>
      )}
      {error && <div role="alert">{error}</div>}
      <button
        type="button"
        onClick={async () => {
          if (offer) {
            await authenticatedFetch(`/api/pairing/offers/${offer.offerId}`, {
              method: 'DELETE',
            });
          }
          onCancel();
        }}
        style={secondaryBtnStyle}
      >
        Back
      </button>
    </div>
  );
}
