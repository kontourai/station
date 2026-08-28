import { decodeDevicePairingPayload } from './devicePairing';
import {
  devPairingDeepLinkScheme,
  RELEASE_PAIRING_DEEP_LINK_SCHEMES,
} from './pairingDeepLinkChannels.generated';

/** The client build selected by a pairing link, never the Station backend. */
export type PairingDeepLinkChannel = 'stable' | 'beta' | 'nightly' | 'dev';

export const PAIRING_DEEP_LINK_VERSION = '1';
export const PAIRING_LINK_REMEDY =
  'Create a current pairing link for the intended Station channel. If that app is not installed, install it or select another channel; otherwise paste the raw pairing payload into Join.';

function pairingLinkError(message: string): PairingDeepLinkParseResult {
  return { status: 'error', message: `${message} ${PAIRING_LINK_REMEDY}` };
}

export function pairingDeepLinkScheme(
  channel: PairingDeepLinkChannel,
  devScheme?: string,
): string | null {
  if (channel === 'dev') return devScheme ?? null;
  return RELEASE_PAIRING_DEEP_LINK_SCHEMES[channel];
}

export { devPairingDeepLinkScheme };

export function encodePairingDeepLink(input: {
  payload: string;
  clientChannel: PairingDeepLinkChannel;
  /** Required only for a worktree-scoped development shell. */
  devScheme?: string;
}): string {
  const scheme = pairingDeepLinkScheme(input.clientChannel, input.devScheme);
  if (!scheme) {
    throw new Error('A development pairing link requires its native scheme.');
  }
  const params = new URLSearchParams([
    ['linkVersion', PAIRING_DEEP_LINK_VERSION],
    ['clientChannel', input.clientChannel],
    ['payload', input.payload],
  ]);
  return `${scheme}://pair?${params}`;
}

export type PairingDeepLinkParseResult =
  | { status: 'ok'; payload: string }
  | { status: 'error'; message: string };

/**
 * Total, side-effect-free admission for the native URL association. The
 * payload's environment identity is deliberately not related to the client
 * channel: any current channel may pair with any valid Station backend.
 */
export function parsePairingDeepLink(
  url: string,
  expected: {
    clientChannel: PairingDeepLinkChannel;
    devScheme?: string;
  },
): PairingDeepLinkParseResult {
  try {
    const parsed = new URL(url);
    const scheme = pairingDeepLinkScheme(
      expected.clientChannel,
      expected.devScheme,
    );
    if (
      !scheme ||
      parsed.protocol !== `${scheme}:` ||
      parsed.hostname !== 'pair' ||
      parsed.pathname !== '' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return pairingLinkError('This is not a current Station pairing link.');
    }
    const allowed = new Set(['linkVersion', 'clientChannel', 'payload']);
    const keys = [...parsed.searchParams.keys()];
    if (
      keys.length !== 3 ||
      keys.some((key) => !allowed.has(key)) ||
      [...allowed].some((key) => parsed.searchParams.getAll(key).length !== 1)
    ) {
      return pairingLinkError('This Station pairing link is malformed.');
    }
    if (
      parsed.searchParams.get('linkVersion') !== PAIRING_DEEP_LINK_VERSION ||
      parsed.searchParams.get('clientChannel') !== expected.clientChannel
    ) {
      return pairingLinkError(
        'This pairing link is for a different or unsupported Station app.',
      );
    }
    const payload = parsed.searchParams.get('payload');
    if (
      !payload ||
      !decodeDevicePairingPayload(payload, { rejectCredentialFields: true })
    ) {
      return pairingLinkError(
        'This Station pairing offer is invalid, expired, or contains unsupported credentials.',
      );
    }
    return { status: 'ok', payload };
  } catch {
    return pairingLinkError('This Station pairing link is malformed.');
  }
}
