import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';

const FRAGMENT_KEY = 'station-ui-bootstrap';
let captured = false;
let sessionResolution: Promise<LocalUiSessionResolution> | undefined;

export type LocalUiSessionResolution =
  | { kind: 'authenticated' }
  | { kind: 'access-required'; message?: string };

export function captureLocalUiBootstrapToken(): string | undefined {
  if (captured) return undefined;
  const token = new URLSearchParams(window.location.hash.slice(1)).get(
    FRAGMENT_KEY,
  );
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return undefined;
  captured = true;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

/** Exchange an explicit launcher capability exactly once before protected UI work begins. */
export async function bootstrapLocalUiSession(
  apiBase: string,
): Promise<boolean> {
  const token = captureLocalUiBootstrapToken();
  if (!token) return false;
  const response = await fetch(
    `${apiBase}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Local UI bootstrap was refused (${response.status}). Open a fresh Station start link.`,
    );
  }
  return true;
}

/**
 * Resolve the local browser's session once per page lifetime. React StrictMode
 * may mount a gate twice during Vite development, but a missing session must
 * not turn that into repeated protected requests or auth-rate-limit traffic.
 */
export function resolveLocalUiSession(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  sessionResolution ??= (async () => {
    try {
      if (await bootstrapLocalUiSession(apiBase)) {
        return { kind: 'authenticated' };
      }
      const response = await fetch(`${apiBase}/api/system/identity`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      return response.ok
        ? { kind: 'authenticated' }
        : { kind: 'access-required' };
    } catch (error) {
      return {
        kind: 'access-required',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  return sessionResolution;
}

/**
 * A completed pairing may have set the HttpOnly session cookie after the gate
 * cached an access-required result. Only that explicit success signal may
 * discard the cached result; ordinary failures remain deduplicated.
 */
export function recheckLocalUiSessionAfterPairing(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  sessionResolution = undefined;
  return resolveLocalUiSession(apiBase);
}

export function resetLocalUiBootstrapForTests(): void {
  captured = false;
  sessionResolution = undefined;
}
