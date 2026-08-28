import { useEffect } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import type { BundledServerStatus } from '../platform/native';

/** Post-boot desktop local-owner state: informative and actionable, never a gate. */
export function BundledServiceBanner({
  status,
  onRestart,
  onOpenConnections,
}: {
  status: BundledServerStatus | null;
  onRestart: () => void;
  onOpenConnections: () => void;
}) {
  useEffect(() => {
    const phase = status?.phase;
    if (!phase || phase === 'running') {
      bannerStore.dismiss(BANNER_IDS.bundledService);
      return;
    }
    // A durable service owning this home is NOT "your local Station stopped"
    // (archive#3079). That state became reachable when the supervisor began
    // publishing liveness (#3064), and the host already narrates it
    // accurately — this component was discarding that narration for
    // `stopped` and substituting a generic line, then offering a Restart
    // button that can only return an error, because restart_bundled_server
    // correctly refuses for a non-sidecar owner.
    const serviceOwnsHome = status.ownership === 'service';
    // A durable service owning this home is the steady state the user
    // INSTALLED, not a notice (archive#3476). The desktop's own sidecar is
    // never `running` in that configuration — that is the point of it — so
    // the `running` dismiss above could never fire and this banner sat
    // permanently across the top of the window, in the *transient* band,
    // narrating a healthy deliberate configuration. Its only action, "Manage
    // Stations", is the header connection chip, which is always on screen and
    // says which Station this is; nothing is lost by staying quiet.
    //
    // `failed` is excluded: no producer emits it with this ownership today
    // (`attached_service_status` hardcodes `stopped`), but a service owner
    // that DID fail is a fault, and this fix removes noise, not faults.
    if (serviceOwnsHome && phase !== 'failed') {
      bannerStore.dismiss(BANNER_IDS.bundledService);
      return;
    }
    // Two different questions, and conflating them was the first version's
    // defect. `serviceOwnsHome` decides what to SAY. What to OFFER depends
    // on whether the sidecar owns the home, because restart_bundled_server
    // refuses for any owner that is not the sidecar — and `none` is such an
    // owner. `none` is reachable and ordinary: ambiguous registry, untrusted
    // registry, a second Desktop that lost the atomic claim. In that state
    // the old code rendered "Local Station stopped" over a button whose
    // error string is discarded by the caller, so clicking it did visibly
    // nothing at all.
    // Ownership AND reachability. A fail-closed home (wrong schema version)
    // accepts the restart call and deterministically fails again, under a
    // message that literally reads "Restarting cannot fix this" — the fix's
    // own principle, one condition short of where it applies.
    const canRestart = status.ownership === 'sidecar' && !status.failClosed;
    const message =
      phase === 'failed'
        ? [
            status.message ||
              "Station's local Station stopped. Restart it or connect to a remote Station.",
            // ONLY for a non-sidecar owner. There `detail` is a curated
            // sentence naming why ownership could not be established, and
            // dropping it was the same narration-discarding defect this
            // component was fixed for. On the SIDECAR crash path the host
            // puts the last 16 lines of the child's stderr in this field —
            // stack traces, log lines, absolute home paths — and the banner
            // has no clamp, so appending it there would paste a crash dump
            // into chrome. Two producers, one field, different kinds of
            // thing.
            canRestart ? null : status.detail,
          ]
            .filter(Boolean)
            .join(' ')
        : phase === 'stopped'
          ? // No service arm: a service-owned home never reaches here (the
            // early return above takes every non-`failed` phase), and a
            // branch that cannot run is a branch the next reader trusts.
            "Station's local Station is stopped. Restart it to use local server actions."
          : phase === 'starting'
            ? 'Starting Station on this device. Settings and saved Stations remain available.'
            : 'Restarting Station on this device. Settings and saved Stations remain available.';
    bannerStore.present({
      id: BANNER_IDS.bundledService,
      // Required, not decorative, because this banner is now dismissible for
      // its non-blocking states. The store keys user-dismissal suppression by
      // `id` + `occurrence`, and a dismissible banner with NO occurrence stays
      // suppressed until `clear` — so dismissing "local Station stopped"
      // would have swallowed the `failed` banner that follows it, which is a
      // real fault reported to nobody. Keyed on the two fields that decide
      // what this banner says, so any change of state is a new occurrence.
      occurrence: `${status.ownership}:${phase}`,
      priority:
        phase === 'failed'
          ? BANNER_PRIORITY.connectionBlocking
          : BANNER_PRIORITY.connectionTransient,
      tone: phase === 'failed' ? 'error' : 'info',
      badge: serviceOwnsHome
        ? 'Service owns this home'
        : // 'none' is not "stopped": in the ambiguous-registry case a service
          // may well be running, and nothing here observed it either way.
          // Asserting a state nothing computed is the defect #3079 was filed
          // about — the fix had removed it from the message and left it in
          // the badge directly above.
          status.ownership === 'none'
          ? 'Local owner unresolved'
          : phase === 'failed'
            ? 'Local Station stopped'
            : 'Local Station',
      message,
      // Everything this banner still presents that is NOT connection-blocking
      // is a notice the reader may reasonably be done with — it costs a band
      // of vertical space at the top of the window for as long as it is up.
      // The `failed` band stays non-dismissible for archive#3432's reason:
      // dismissing it hides the action needed to get a Station back. Same
      // shape, and the same reason, as ConnectionBannerSource's
      // `dismissible: !blocked`.
      dismissible: phase !== 'failed',
      dismissAriaLabel: 'Dismiss local Station notice',
      ariaLive: 'polite',
      actions: [
        // Restart only when the SIDECAR owns the home. The command fails
        // closed for every other owner, so the button's only possible
        // outcome is an error string — and the caller discards it, so the
        // user sees nothing happen. Gating on `!serviceOwnsHome` left it
        // rendered for `none`, where it is equally dead.
        ...(canRestart
          ? [{ label: 'Restart Station', onClick: onRestart }]
          : []),
        {
          label: 'Manage Stations',
          variant: 'secondary',
          onClick: onOpenConnections,
        },
      ],
    });
    return () => bannerStore.dismiss(BANNER_IDS.bundledService);
  }, [onOpenConnections, onRestart, status]);

  return null;
}
