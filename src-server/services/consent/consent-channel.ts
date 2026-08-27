/**
 * ConsentChannelService — the runtime's handle on the distinct-origin consent
 * surface (station#3677).
 *
 * It owns the {@link ConsentTransactionStore} (shared between the main API,
 * which CREATES transactions and answers status polls, and the consent
 * listener, which renders reviews and accepts decisions) plus the truthful
 * availability state of the listener itself.
 *
 * Failure policy (owner decision 3): the consent listener being down makes
 * every authority-bearing approval UNAVAILABLE — reported truthfully, never
 * degraded open — while Station's main surface stays usable. The state here
 * is what the approval-request routes consult before minting a review URL.
 */
import {
  ConsentTransactionStore,
  LOCAL_CONSENT_TENANT,
} from './consent-transactions.js';

/**
 * Transaction-bound decision session cookie (the bearer-only-UI path): the
 * main API mints it when it creates a transaction for a verified principal.
 * It carries exactly "may decide this transaction" — never a general bearer.
 * Cookies are host-scoped, not port-scoped, so it reaches the consent
 * listener on the same hostname.
 */
export const CONSENT_SESSION_COOKIE = 'station-consent';

export type ConsentChannelState =
  | { readonly status: 'listening'; readonly port: number }
  | { readonly status: 'unavailable'; readonly reason: string };

/** The path the consent listener serves a review at, for URL construction. */
export function consentReviewPath(transactionId: string): string {
  return `/consent/${encodeURIComponent(transactionId)}`;
}

export class ConsentChannelService {
  readonly store: ConsentTransactionStore;
  readonly tenantId = LOCAL_CONSENT_TENANT;
  #state: ConsentChannelState = {
    status: 'unavailable',
    reason: 'The consent listener has not started.',
  };

  constructor(options: { now?: () => number } = {}) {
    this.store = new ConsentTransactionStore(options);
  }

  state(): ConsentChannelState {
    return this.#state;
  }

  markListening(port: number): void {
    this.#state = { status: 'listening', port };
  }

  markUnavailable(reason: string): void {
    this.#state = { status: 'unavailable', reason };
  }

  /**
   * The absolute review URL for a transaction, preserving the REQUEST-VISIBLE
   * hostname and changing only the port (owner decision 4): `localhost`,
   * `127.0.0.1`, a LAN IP, and a MagicDNS name are different cookie hosts and
   * must not be collapsed to any one of them.
   *
   * `requestHostHeader` is the `Host` header of the request that asked for
   * the URL. `null` when the listener is unavailable or the header is
   * unusable — callers must refuse rather than guess a hostname.
   */
  reviewUrlFor(
    requestHostHeader: string | undefined,
    transactionId: string,
  ): string | null {
    const state = this.#state;
    if (state.status !== 'listening') return null;
    if (!requestHostHeader) return null;
    let hostname: string;
    try {
      hostname = new URL(`http://${requestHostHeader}`).hostname;
    } catch {
      return null;
    }
    if (!hostname) return null;
    // WHATWG URL keeps IPv6 hostnames bracketed (`[::1]`), so the value is
    // already authority-ready.
    return `http://${hostname}:${state.port}${consentReviewPath(transactionId)}`;
  }
}
