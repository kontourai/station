import { authenticatedFetch } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { nativePlatformPromise } from './index';
import type { NativeCommandResult, NativeConsentOutcome } from './types';

export type NativeConsentReviewer = (
  requestId: string,
) => Promise<NativeCommandResult<NativeConsentOutcome>>;

/**
 * Resolves the native consent broker when — and only when — BOTH halves of
 * the answer say yes (archive#3677):
 *
 * - the HOST capability (`native-consent-broker`): can this shell draw an OS
*   dialog at all? Web hosts cannot.
 * - the SERVER's eligibility answer for THIS connection: may this credential
*   decide? Only a local-grant-minted credential may, and a shell cannot
*   know its own mint — a phone, or a desktop app connected to a REMOTE
*   Station, reports the capability while pairing through the ordinary
*   exchange, which stamps no mint at all. In practice that scopes the
*   native dialog to the desktop app talking to the Station on its own
*   machine; every other caller keeps using the consent page.
 *
 * `null` means "use the distinct-origin consent page", a function means
 * "hand the transaction to native OS chrome", and consumers read it
 * synchronously — the web fallback's `window.open` must run inside the
 * click's transient activation, so the branch cannot await anything.
 *
 * Two states resolve to `null` and are NOT the same as "ineligible", which
 * is why this hook does not pretend to be an authority oracle: eligibility
 * that has not answered yet, and a connection change whose answer is still
 * pending. Both take the consent page, the path that works wherever the
 * listener does. What matters is the direction of every uncertainty — an
 * unanswered, failed, or superseded read never leaves a previous
 * connection's authority exposed ( 2 found exactly that: the
 * reviewer was never cleared, so switching to a Station that refuses left a
 * stale approve-capable function in place).
 */
export function useNativeConsentBroker(): NativeConsentReviewer | null {
  const { apiBase } = useApiBase();
  const [reviewer, setReviewer] = useState<NativeConsentReviewer | null>(null);
  useEffect(() => {
    let disposed = false;
// Drop any previous connection's authority IMMEDIATELY, before this
// connection's answer is known. Anything else keeps an approve-capable
// function alive across a switch the server would refuse.
    setReviewer(null);
    void (async () => {
      const adapter = await nativePlatformPromise;
      if (disposed) return;
      if (adapter.capability('native-consent-broker').state !== 'enabled') {
        return;
      }
      let eligible = false;
      try {
        const response = await authenticatedFetch(
          `${apiBase}/api/consent/native-eligibility`,
        );
        if (response.ok) {
          const body = (await response.json()) as { eligible?: unknown };
          eligible = body.eligible === true;
        }
      } catch {
// Unreachable or refused: stay on the consent page rather than
// assume an authority the server never granted.
        eligible = false;
      }
      if (disposed) return;
      setReviewer(
        eligible
          ? () => (requestId: string) =>
              adapter.reviewConsentNatively(requestId)
          : null,
      );
    })();
    return () => {
      disposed = true;
    };
  }, [apiBase]);
  return reviewer;
}
