/**
 * Lazy access to the compatibility verdict module.
 *
 * The verdict copy is deliberately long — it has to name which side to update
 * and how — and version drift is rare, so none of it belongs in the bundle
 * every user downloads on first paint. This keeps `compatibility.ts` in its
 * own chunk, fetched the first time a handshake is actually evaluated.
 *
 * A chunk that cannot be fetched leaves compatibility unverified. That is a
 * blocking state: callers must surface the load failure and offer retry rather
 * than silently treating an unevaluated host as compatible.
 */

import type { StationCompatibilityResult } from '@kontourai/station-contracts';

let modulePromise: Promise<typeof import('./compatibility')> | null = null;

function loadCompatibility(): Promise<typeof import('./compatibility')> {
  modulePromise ??= import('./compatibility').catch((error) => {
    // Do not cache a transient chunk-load failure forever.
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

/** True when this client must refuse the host that returned `advertised`. */
export async function isBlockingCompatibility(
  advertised: unknown,
): Promise<boolean> {
  try {
    const { CLIENT_COMPATIBILITY_POLICY, evaluateCompatibility } =
      await loadCompatibility();
    return evaluateCompatibility(CLIENT_COMPATIBILITY_POLICY, advertised)
      .blocking;
  } catch {
    return true;
  }
}

/** Handshake a host and evaluate it, without saving anything. */
export async function checkHostCompatibility(
  url: string,
  signal?: AbortSignal,
): Promise<StationCompatibilityResult> {
  const module = await loadCompatibility();
  return module.checkHostCompatibility(url, signal);
}
