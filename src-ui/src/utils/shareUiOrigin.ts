import { isStationNativeShellOrigin } from '@kontourai/station-shared/native-shell-origin';

export type ShareUiOriginDecision =
  | { verified: true; origin: string }
  | { verified: false; explanation: string };

const UNSHAREABLE_ORIGIN_EXPLANATION =
  'Sharing is unavailable from this app address. Open Station from a reachable HTTP(S) address before sharing.';

/**
 * The one UI-origin trust decision for answer-share links. This verifies only
 * that the address is a network HTTP(S) origin; it deliberately does not infer
 * a backend, public, LAN, tailnet, or otherwise advertised origin.
 */
export function deriveShareUiOrigin(origin: string): ShareUiOriginDecision {
  if (isStationNativeShellOrigin(origin)) {
    return {
      verified: false,
      explanation: UNSHAREABLE_ORIGIN_EXPLANATION,
    };
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === origin
    ) {
      return { verified: true, origin };
    }
  } catch {
    // The same fail-closed explanation covers opaque and malformed origins.
  }
  return {
    verified: false,
    explanation: UNSHAREABLE_ORIGIN_EXPLANATION,
  };
}
