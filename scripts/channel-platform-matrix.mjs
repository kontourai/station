import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

export function readChannelPlatformMatrix() {
  return JSON.parse(
    readFileSync(resolve(root, 'config/channel-platform-matrix.json'), 'utf8'),
  ).channels;
}

/** The one static authority for every shipped pairing-scheme registration. */
export function pairingSchemeForChannel(matrix, channel) {
  const scheme = matrix[channel]?.pairingDeepLinkScheme;
  if (
    typeof scheme !== 'string' ||
    !/^station-(stable|beta|nightly)$/.test(scheme)
  ) {
    throw new Error(`Channel ${channel} has no valid release pairing scheme.`);
  }
  return scheme;
}

export function normalizeDevPairingDeepLinkSuffix(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'instance'
  );
}

export function devPairingDeepLinkScheme(instance) {
  return `station-dev-${normalizeDevPairingDeepLinkSuffix(instance)}`;
}
