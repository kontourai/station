/**
 * Publishes connection conditions for Station details.
 *
 * Keeps `useConnectionStatus` mounted (poll consumers hang off this mount)
 * and projects reachability / version-drift failures into `bannerStore`.
 */

import {
  connectionFailureCopy,
  connectionFailureNeedsDecision,
  useConnectionStatus,
  useConnections,
  usePendingPairingApproval,
} from '@kontourai/station-connect';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../contexts/banner-store';
import { recordReplayConnection } from '../../hooks/orchestration/replay/capture-tap';
import { setStreamConnectionState } from '../../hooks/orchestration/streamConnectionState';
import { checkHostCompatibility } from '../../lib/compatibility';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';

/**
 * archive#4470: removing the active connection is
 * destructive and, unlike a rejected credential, this device has no way
 * back to the SAME host without re-pairing from scratch — so it takes two
 * deliberate taps, the same MECHANISM `PairedDeviceList.tsx`'s inline revoke
 * confirm already uses for device access (`confirming ? <Confirm/Cancel> :
 * <normal actions>` — see that file's `DeviceRow`): an explicit Confirm and
 * an explicit Cancel, not just a relabeled single button. An armed confirm
 * that nobody follows through on disarms itself after this long.
 */
const REMOVE_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * archive#4470: a fast double-tap on the same pixel (the
 * "Remove" button, before the arm/confirm swap has visually settled) must
 * arm on the first tap and land on the SECOND control ("Confirm") rather
 * than removing in one gesture — the swap is a genuine two-step confirm
 * only if the confirm tap is a deliberate, separate action. A tap on the
 * (now-armed) control within this window of arming is ignored rather than
 * treated as the confirming tap.
 */
const ARM_DEBOUNCE_MS = 300;

// Guardrailed by proof:repo-governance.
function isLoopbackEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const octets = hostname.split('.');
    const ipv4Loopback =
      octets.length === 4 &&
      octets[0] === '127' &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
    return hostname === 'localhost' || ipv4Loopback || hostname === '[::1]';
  } catch {
    return false;
  }
}

// Guardrailed by proof:repo-governance.
export function ConnectionBannerSource() {
  const { activeConnection, apiBase, removeConnection } = useConnections();
  const { isDesktop } = usePlatformProfile();
  const { status, reason, failureStreak, blocked, recheck } =
    useConnectionStatus({
      checkHealth: checkServerHealth,
      probeEndpoint: probeServerConnection,
      pollInterval: 10_000,
    });
  const endpoint = activeConnection?.url ?? apiBase;
  useEffect(() => {
    if (!blocked) return;
    if (setStreamConnectionState(apiBase, 'closed'))
      recordReplayConnection(apiBase, 'closed');
  }, [apiBase, blocked]);
  // Two-step confirm for "Remove connection" (identity-mismatch banner,
  // below) — armed by a first tap, disarmed by a second tap performing the
  // removal, an explicit Cancel, a blur off the control, a timeout, or the
  // underlying decision changing out from under it (the effect keyed on
  // `reason` further down).
  const [removeArmed, setRemoveArmed] = useState(false);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // archive#4470: timestamp of the arming tap, so a
  // near-simultaneous second tap on the same screen location — now hitting
  // "Confirm" where "Remove" used to be — can be told apart from a
  // deliberate, separate confirming tap. See ARM_DEBOUNCE_MS.
  const armedAtRef = useRef(0);
  const disarm = useCallback(() => {
    if (disarmTimerRef.current !== null) {
      clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
    setRemoveArmed(false);
  }, []);
  useEffect(() => {
    if (reason !== 'identity-mismatch' && removeArmed) disarm();
  }, [reason, removeArmed, disarm]);
  useEffect(
    () => () => {
      if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    },
    [],
  );
  // archive#4512: the hook now decides its own tick from
  // whether a pending record exists, not from this component's `status`.
  const pendingApproval = usePendingPairingApproval(endpoint);

  const showCompat =
    status === 'error' && reason === 'unsupported-capability-version';
  // Credential pairing chrome is owned by OnboardingGate (BANNER_IDS.credential).
  // When the active connection needs pairing, skip the offline strip so the
  // slot does not stack two "credential" stories with different CTAs.
  const credentialOwned = activeConnection?.credentialState === 'required';
  /**
   * A loopback address reached from something that is not the machine hosting
   * it can never resolve — no amount of retrying changes it, and the fix is a
   * different address. That makes it a decision, even though the reason that
   * carried it here ('unreachable'/'timeout') is not one on its own.
   *
   * Deliberately hedged in the copy below ("Connecting from another device?"),
   * because this predicate cannot tell a phone from a browser open on the host
   * itself — the sustained streak is what stops it firing on a dev server that
   * is merely restarting.
   */
  // station#2327: never for `busy` — that reason means the address answered,
  // so "use the host's IP instead of localhost" would be advice against a
  // problem that was just disproved.
  const loopbackFromElsewhere =
    isLoopbackEndpoint(endpoint) &&
    !isDesktop &&
    new URL(endpoint).origin !== window.location.origin &&
    failureStreak >= 3 &&
    reason !== 'busy';

  /**
   * archive#3297 — a banner requires a decision.
   *
   * The previous rule was "every reachability failure banners, once it has
   * missed three probes". That put a paragraph of prose with an address in it
   * on a phone screen for a condition that is usually transient and
   * self-healing, which is what the owner asked to stop. Transient
   * reachability is now carried by the connection indicator, which is exactly
   * as loud as it needs to be and costs no vertical space.
   *
   * The 3-probe streak has NOT been deleted, only narrowed to the one
   * reachability case that is a decision (above): archive#2630's finding that load is
   * this application's normal operating condition still holds.
   */
  const showDecision =
    status === 'error' &&
    !credentialOwned &&
    !pendingApproval &&
    reason !== null &&
    reason !== 'unsupported-capability-version' &&
    reason !== 'awaiting-approval' &&
    (connectionFailureNeedsDecision(reason) || loopbackFromElsewhere);

  const { data: compat } = useQuery({
    queryKey: ['host-compatibility', apiBase],
    queryFn: ({ signal }) => checkHostCompatibility(apiBase, signal),
    enabled: showCompat,
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!showDecision || reason === null) {
      bannerStore.dismiss(BANNER_IDS.offline);
      return;
    }
    const copy = connectionFailureCopy(
      reason,
      activeConnection?.name || apiBase,
      activeConnection?.url || apiBase,
    );
    const hasStaleContext = activeConnection?.lastSuccessAt !== undefined;
    const connectionId = activeConnection?.id;
    // One line stays visible; everything else is a tap away. The split is by
    // what the reader needs to act, not by length: the summary says what
    // happened, the detail says what to do about it and under what caveats.
    const detail = [
      copy.action,
      loopbackFromElsewhere
        ? "Connecting from another device? Use the host's IP address instead of localhost."
        : null,
      blocked ? 'Automatic reconnect is paused until this is resolved.' : null,
      hasStaleContext
        ? 'Last verified context remains available read-only; changes will not be queued.'
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    bannerStore.present({
      id: BANNER_IDS.offline,
      priority: blocked
        ? BANNER_PRIORITY.connectionBlocking
        : BANNER_PRIORITY.connectionTransient,
      tone: blocked ? 'blocked' : 'warning',
      badge: blocked ? 'Approval needed' : undefined,
      message: copy.summary,
      detail: detail || undefined,
      // Every banner that reaches this point names a decision, so none of them
      // is the "transient notice that must not become permanent mobile
      // chrome" the old rule was written for. Blocking credential failures
      // stay non-dismissible for the original reason: dismissing one hides
      // the action needed to resume automatic reconnect.
      dismissible: false,
      dismissAriaLabel: 'Dismiss connection notice',
      actions:
        reason === 'authentication-failed'
          ? [
              // archive#3297: the remedy, first. A rejected credential cannot
              // be rechecked into working — "Try now" was the only action
              // offered here, and it is the one thing that provably does not
              // help. It stays as the secondary, because a host that has since
              // been re-approved out of band recovers on a probe.
              {
                label: 'Pair again',
                onClick: () => openConnectionsModal({ mode: 'request-access' }),
              },
              {
                label: 'Try now',
                variant: 'secondary' as const,
                onClick: () => {
                  recheck();
                },
              },
            ]
          : reason === 'identity-mismatch'
            ? // archive#4470: the `detail` copy above this (from
              // `connectionFailureCopy`) already tells the reader "Pair
              // again, or remove this connection" — the CTA used to offer
              // only "Try now", which cannot recover a host whose identity
              // has genuinely changed (a reset/reinstalled host, or a
              // different machine now answering at this address).
              //
              // Identity changes require pairing or an explicit, cancellable removal.
              (() => {
                const pairAgain = {
                  label: 'Pair again',
                  onClick: () =>
                    openConnectionsModal({ mode: 'request-access' }),
                };
                if (!removeArmed) {
                  return [
                    pairAgain,
                    {
                      label: 'Remove',
                      ariaLabel: 'Remove connection',
                      variant: 'danger' as const,
                      onClick: () => {
                        armedAtRef.current = Date.now();
                        setRemoveArmed(true);
                        disarmTimerRef.current = setTimeout(
                          disarm,
                          REMOVE_CONFIRM_TIMEOUT_MS,
                        );
                      },
                      onBlur: disarm,
                    },
                  ];
                }
                return [
                  pairAgain,
                  {
                    label: 'Confirm',
                    ariaLabel: 'Confirm removing this connection',
                    variant: 'danger' as const,
                    onClick: () => {
                      // a fast double-tap on the same pixel must arm,
                      // not arm-then-remove in one gesture.
                      if (Date.now() - armedAtRef.current < ARM_DEBOUNCE_MS) {
                        return;
                      }
                      disarm();
                      if (connectionId) removeConnection(connectionId);
                    },
                    onBlur: disarm,
                  },
                  {
                    label: 'Cancel',
                    variant: 'secondary' as const,
                    onClick: disarm,
                  },
                ];
              })()
            : [
                {
                  label: 'Try now',
                  onClick: () => {
                    recheck();
                  },
                },
              ],
    });

    return () => {
      bannerStore.dismiss(BANNER_IDS.offline);
    };
  }, [
    showDecision,
    reason,
    blocked,
    activeConnection?.id,
    activeConnection?.name,
    activeConnection?.url,
    activeConnection?.lastSuccessAt,
    apiBase,
    recheck,
    removeConnection,
    removeArmed,
    disarm,
    loopbackFromElsewhere,
  ]);

  useEffect(() => {
    if (!showCompat) {
      bannerStore.dismiss(BANNER_IDS.compat);
      return;
    }
    bannerStore.present({
      id: BANNER_IDS.compat,
      priority: BANNER_PRIORITY.versionMismatch,
      tone: 'error',
      badge: 'Version mismatch',
      message:
        compat?.reason ??
        'This app and this Station host are running incompatible versions. Update whichever is older, then reconnect.',
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.compat);
    };
  }, [showCompat, compat?.reason]);

  return null;
}
