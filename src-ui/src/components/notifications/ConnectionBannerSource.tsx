/**
 * Connection chrome source for BannerHost.
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
// fallow-ignore-next-line unused-export
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
// fallow-ignore-next-line unused-export
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
  // Two-step confirm for "Remove connection" (identity-mismatch banner,
  // below) — armed by a first tap, disarmed by a second tap performing the
  // removal, an explicit Cancel, a blur off the control, a timeout, or the
  // underlying decision changing out from under it (the effect keyed on
  // `reason` further down).
  const [removeArmed, setRemoveArmed] = useState(false);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // archive#4470: a destructive confirm has to stay VISIBLE
  // to be cancellable — a two-step control armed from a COLLAPSED banner
  // (archive#4470 kept the collapsed card's actions live, not hidden)
  // would otherwise sit one tap from removing a connection behind a 52px
  // bar with no way to see, let alone cancel, the pending confirm. Arming
  // force-expands the card if it was collapsed; this ref remembers whether
  // THIS confirm did that, so disarming (by any path) restores collapsed
  // only when arming is what changed it — a card the reader expanded
  // themselves stays expanded.
  const forcedExpandRef = useRef(false);
  // archive#4470: timestamp of the arming tap, so a
  // near-simultaneous second tap on the same screen location — now hitting
  // "Confirm" where "Remove" used to be — can be told apart from a
  // deliberate, separate confirming tap. See ARM_DEBOUNCE_MS.
  const armedAtRef = useRef(0);
  // archive#4470: hoisted so every disarm path — the
  // reason-change effect below, the armed actions' own onClick/onBlur, and
  // the collapse-chevron interaction (further down) — shares ONE
  // definition instead of each restating "clear the timer, restore
  // collapsed if we forced it, clear armed" and drifting apart. Stable
  // across renders (only refs and the `setRemoveArmed` dispatch inside),
  // so it is safe as an effect dependency and as a long-lived callback
  // handed to `bannerStore.present`.
  const disarm = useCallback(() => {
    if (disarmTimerRef.current !== null) {
      clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
    if (forcedExpandRef.current) {
      bannerStore.setCollapsed(BANNER_IDS.offline, true);
      forcedExpandRef.current = false;
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
  const loopbackFromElsewhere =
    isLoopbackEndpoint(endpoint) && !isDesktop && failureStreak >= 3;

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
      badge: blocked ? 'Credential required' : undefined,
      /**
       * #1132: this banner is critical chrome, so a maximized region does not
       * bury it (`BannerHost.css`). Unconditional, not `blocked ? …`: the
       * `blocked` half already qualified through the `connectionBlocking`
       * priority band (`requiresCriticalChrome`), and it is the OTHER half —
       * an unreachable or mismatched host at `connectionTransient` — that the
       * measurement in #1132 found buried under a maximized dock.
       *
       * Scoped to THIS banner, not to this component: the compatibility strip
       * below (`BANNER_IDS.compat`) is published by the same source and is
       * deliberately not marked — it carries no action at all, so there is
       * nothing under the dock for a reader to fail to reach.
       *
       * What makes this one critical is the state, not the actions. Only
       * `authentication-failed` and `identity-mismatch` are given real
       * remedies here; the rest fall to a single "Try now", and the loopback
       * case's actual remedy is a sentence in `detail`. But `showDecision`
       * above admits this banner only when the connection is DOWN and a person
       * has to decide something about it (archive#3297 narrowed ordinary
       * transient reachability out of this strip entirely), and a notice like
       * that — dismissible or not, however thin its CTA — is the one the reader
       * has to be able to read and dismiss to get on with anything. Buried
       * under a maximized dock it is the worst of the three outcomes #1132
       * lists. Ordinary notices (an available update, a redirect explanation)
       * stay below the dock, keeping the maximized occupant's own header and
       * search reachable (#919).
       */
      criticalChrome: true,
      message: copy.summary,
      detail: detail || undefined,
      // Every banner that reaches this point names a decision, so none of them
      // is the "transient notice that must not become permanent mobile
      // chrome" the old rule was written for. Blocking credential failures
      // stay non-dismissible for the original reason: dismissing one hides
      // the action needed to resume automatic reconnect.
      dismissible: !blocked,
      // archive#4470: the collapse chevron is gated only
      // on the exit animation (BannerHost.tsx), never on this banner's own
      // armed state — a reader can arm "Remove", then tap the chevron, and
      // land the SAME overflow this whole feature exists to avoid
      // (message clipped to 0px, Cancel/dismiss pushed outside the clipped
      // card) for up to REMOVE_CONFIRM_TIMEOUT_MS. Collapsing while armed
      // now disarms — a reader collapsing a pending destructive confirm is
      // read as cancelling it, not as asking to keep it live off screen.
      onCollapse: disarm,
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
              // A third action ("Try now") does not fit
              // this banner collapsed at a phone viewport — measured with a
              // real Chromium page at 390px, three non-shrinkable
              // `.banner-host__action`s in the collapsed 52px bar clip the
              // message to 0px width and push the dismiss control off the
              // clipped card entirely, leaving it unreachable for the rest
              // of the session. Two actions fit (the same shape
              // authentication-failed already ships), and retrying is not
              // the remedy here the way it stayed one for a rejected
              // credential that might since have been re-approved out of
              // band — the owner named exactly two remedies for THIS
              // reason, so retry is dropped rather than demoted.
              //
              // "Remove connection"/"Confirm removal" as the UNARMED
              // labels (the first tried) STILL broke the same collapsed
              // row even at two actions: `.banner-host__action`s wrap
              // under `index.css`'s global mobile "legacy action rows" net
              // (`[class*="__actions"] { flex-wrap: wrap; }`), and the two
              // buttons' combined natural width didn't fit the ~244px this
              // row has left once the message/controls columns take their
              // share — the second button wrapped to a row the fixed 52px
              // collapsed height then clips away entirely (measured:
              // message AND the wrapped button both landed outside the
              // card). "Pair again" is the established width from
              // authentication-failed; "Remove"/"Confirm" are the short
              // VISIBLE form that measures back down to a single row with
              // the message column comfortably visible — `ariaLabel` below
              // carries the full sentence for anyone not reading the
              // banner's own message, which already names what is being
              // removed.
              //
              // An armed confirm has to stay reachable
              // AND cancellable, which a relabeled single button sitting
              // inside a possibly-collapsed 52px bar was neither — arming
              // force-expands the card (forcedExpandRef, above) so the
              // confirm is never hidden, and the armed state renders an
              // explicit "Cancel" beside "Confirm" rather than only a
              // relabel, mirroring `PairedDeviceList.tsx`'s
              // `confirming ? <Confirm/Cancel> : <normal actions>` shape.
              // Three actions ("Pair again"/"Confirm"/"Cancel") measured
              // 262.6px of content in the 345px the expanded row has at
              // 390px (31% headroom) — unlike collapsed 52px bar,
              // this fits comfortably. That measurement is only ever taken
              // EXPANDED: arming force-expands a collapsed card, and
              // closed the other way in — collapsing
              // the chevron while armed now disarms (`onCollapse: disarm`
              // above) instead of leaving the three-action row reachable
              // behind the collapsed 52px bar, so this row is never
              // rendered collapsed by either path.
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
                        const current = bannerStore
                          .getSnapshot()
                          .find((item) => item.id === BANNER_IDS.offline);
                        if (current?.collapsed) {
                          bannerStore.setCollapsed(BANNER_IDS.offline, false);
                          forcedExpandRef.current = true;
                        }
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
