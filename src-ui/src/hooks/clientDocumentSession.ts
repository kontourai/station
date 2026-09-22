import { randomCorrelationId } from '@kontourai/station-shared/random-id';

/**
 * One UUID per browser document, sent as `X-Station-Client-Session` on this
 * document's long-lived streams. It changes on every reload or app restart and
 * stays fixed across a document's reconnects, which is what lets a server log
 * tell "the same client reconnected" from "a fresh JS context connected"
 * (station#2301).
 *
 * Do not use sessionStorage: a window opened from another can clone its tab
 * state and collapse two live tabs into one.
 */
export const CLIENT_DOCUMENT_SESSION_ID = randomCorrelationId();
