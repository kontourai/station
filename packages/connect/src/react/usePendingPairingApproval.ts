import { useEffect, useMemo, useState } from 'react';
import {
  observePendingPairingApproval,
  PENDING_EXCHANGE_CHANGE_EVENT,
  type PendingPairingApproval,
} from '../core/devicePairing';

/**
 * Live view of a locally-tracked pending access/pairing request against
 * `endpoint` (station#1876's local record — the "Request access" or
 * QR/pairing-code flow this device itself started), re-evaluated on a
 * ticking clock so an expired request stops reading as pending without a
 * caller-driven poll.
 *
 * station#4512 review (M2) — the interval is gated on whether a pending
 * record actually EXISTS, not on a caller-supplied `active` flag. The
 * original shape took `active` from the caller's own connection status
 * (`status === 'error'`), which ticked this app-wide-mounted hook's owner
 * (the header toolbar chip) at 1Hz for the ENTIRE duration of any outage —
 * including the ordinary case of a genuinely unreachable host with nothing
 * pending at all, which is most outages. A fresh read decides afresh
 * whenever something might have changed:
 *
 * - `endpoint` changes (a different connection became active).
 * - the underlying store changes — `PENDING_EXCHANGE_CHANGE_EVENT` for a
 *   same-tab write (the pairing flow and this hook's caller are mounted in
 *   the same tab, so the browser's own cross-tab-only `storage` event can't
 *   carry this) and `storage` itself for a genuinely cross-tab one.
 * - the interval's own tick, once armed, so an expiring record is
 *   re-evaluated and the interval stops itself the moment it reads `null`.
 *
 * A fresh read decides, every time: nothing here ticks blind.
 */
export function usePendingPairingApproval(
  endpoint: string,
): PendingPairingApproval | null {
  const [now, setNow] = useState(() => Date.now());
  // Bumped by a same-tab or cross-tab store change — the re-arm signal that
  // forces a fresh read below, independent of `now` (which only a running
  // interval advances).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rearm = () => {
      // station#4512 review (L-new-3): refresh the clock along with the
      // re-arm signal. Without this, a re-arm reuses whatever `now` the
      // last tick left behind — stale by up to the 1s tick interval, or by
      // however long this mount has sat with nothing pending and no
      // interval running at all — and an expiry check against a stale
      // clock is the one thing this hook exists to avoid.
      setNow(Date.now());
      setGeneration((value) => value + 1);
    };
    window.addEventListener(PENDING_EXCHANGE_CHANGE_EVENT, rearm);
    window.addEventListener('storage', rearm);
    return () => {
      window.removeEventListener(PENDING_EXCHANGE_CHANGE_EVENT, rearm);
      window.removeEventListener('storage', rearm);
    };
  }, []);

  // `generation` carries no value of its own — it exists only to force the
  // memo below to recompute (re-read the store) when the effect above
  // observes a change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is an intentional trigger, not read in the body.
  const approval = useMemo(
    () => observePendingPairingApproval(endpoint, now),
    [endpoint, now, generation],
  );
  const hasPending = approval !== null;

  useEffect(() => {
    if (!hasPending) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasPending]);

  return approval;
}
