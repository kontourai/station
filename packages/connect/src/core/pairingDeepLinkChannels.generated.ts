// Generated from config/channel-platform-matrix.json by scripts/channel-platform-matrix.mjs.
export const RELEASE_PAIRING_DEEP_LINK_SCHEMES = {
  stable: 'station-stable',
  beta: 'station-beta',
  nightly: 'station-nightly',
} as const;

/** Normalizes the native bundle suffix and custom-scheme suffix identically. */
export function normalizeDevPairingDeepLinkSuffix(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}

export function devPairingDeepLinkScheme(instance: string): string {
  return `station-dev-${normalizeDevPairingDeepLinkSuffix(instance)}`;
}
