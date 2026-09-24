import { isLoopbackUrl } from './connectionProfile';

/**
 * #2228 slice 3 — "Station server address your phone can reach" should not
 * make the operator re-derive a reachable address every time they open the
 * pairing panel. When an operator types a reachable address once (a tailnet
 * serve URL, a LAN address) and creates an offer with it, remember it per
 * host connection and offer it back as the field's starting value; the
 * loopback URL of the active connection stays the fallback, because pairing a
 * browser on this same machine over the loopback address is a real flow.
 *
 * Storage lives beside the connect package's other webview-local records and
 * is best effort, exactly like the pending-exchange record: private or
 * restricted browser contexts skip remembering and fall back to the loopback
 * default for the session — a degradation, never a crash. Values are
 * shape-checked on both write and read: the suggestion renders into an input
 * whose content is submitted to a Station, so junk in storage must never
 * become junk in the field.
 */

const SUGGESTION_STORAGE_PREFIX = 'station-pairing-endpoint-suggestion:v1:';
const MAX_ENDPOINT_LENGTH = 2048;

interface SuggestionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storageKey(apiBase: string): string {
  return `${SUGGESTION_STORAGE_PREFIX}${new URL(apiBase).origin}`;
}

function isValidReachableEndpoint(value: string): boolean {
  if (!value || value.length > MAX_ENDPOINT_LENGTH) return false;
  try {
    const parsed = new URL(value);
    // An offer endpoint this panel can create must be https, or http on a
    // private/loopback host (the server enforces the same split). A loopback
    // suggestion would only ever restate the default, so it is not worth
    // remembering.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    return !isLoopbackUrl(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Records the endpoint an offer was just created with for the host at
 * `apiBase`, when it is a reachable (non-loopback) address. A loopback
 * endpoint clears any previous suggestion instead: the operator just chose
 * loopback deliberately, and an old tailnet URL resurfacing over that choice
 * would be its own surprise.
 */
export function rememberPairingEndpoint(
  apiBase: string,
  endpoint: string,
  storage?: SuggestionStorage,
): void {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    if (!selectedStorage) return;
    const trimmed = endpoint.trim();
    if (!isValidReachableEndpoint(trimmed)) {
      // The operator just chose a loopback (or unusable) address deliberately;
      // an old reachable URL resurfacing over that choice would be its own
      // surprise, so forget whatever was remembered.
      selectedStorage.removeItem?.(storageKey(apiBase));
      return;
    }
    selectedStorage.setItem(storageKey(apiBase), trimmed);
  } catch {
    // Storage unavailable — this session simply does not remember.
  }
}

/**
 * The remembered reachable address for the host at `apiBase`, or `undefined`
 * when nothing usable is stored. A stored value that no longer parses, or
 * that has become loopback (impossible through {@link rememberPairingEndpoint},
 * but possible through hand-edited storage), reads as absent.
 */
export function suggestPairingEndpoint(
  apiBase: string,
  storage?: SuggestionStorage,
): string | undefined {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    const stored = selectedStorage?.getItem(storageKey(apiBase)) ?? undefined;
    if (!stored) return undefined;
    if (!isValidReachableEndpoint(stored)) return undefined;
    return stored;
  } catch {
    return undefined;
  }
}

/** Test seam: forget the remembered address for one host connection. */
export function forgetPairingEndpoint(
  apiBase: string,
  storage?: SuggestionStorage,
): void {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    selectedStorage?.removeItem?.(storageKey(apiBase));
  } catch {
    // Storage unavailable — nothing to forget.
  }
}
