/**
 * Deterministic identicon color for an agent avatar's initials fallback
 * (station#1424). Given the same seed (an agent's slug/id/name), always
 * returns the same hue — no randomness, no server round-trip, stable across
 * reloads and between clients. Purely a display affordance: never used to
 * derive or compare identity, only to give two different agents without
 * uploaded artwork visually distinct initials swatches instead of every
 * unbranded agent rendering the same flat tone.
 *
 * FNV-1a: small, fast, good avalanche behavior for short strings — overkill
 * cryptographically, appropriately lightweight for a UI color pick.
 */
function fnv1aHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Degrees around the hue wheel a deterministic seed maps to (0-359). */
export function identiconHue(seed: string): number {
  return fnv1aHash(seed || 'agent') % 360;
}
