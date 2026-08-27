import { decodeDevicePairingPayload } from '@kontourai/station-connect';

const PAIRING_SCHEME = 'station:';

/**
 * Accept the one URL association Station owns, and no browser-style fallback.
 * The payload is subsequently decoded by the same protocol validator used by
 * QR scanning; this function never fetches or navigates to a link target.
 */
export function parsePairingDeepLink(
  url: string,
): { status: 'ok'; payload: string } | { status: 'error'; message: string } {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== PAIRING_SCHEME ||
      parsed.hostname !== 'pair' ||
      (parsed.pathname !== '' && parsed.pathname !== '/') ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => key !== 'payload')
    ) {
      return {
        status: 'error',
        message: 'This is not a Station pairing link.',
      };
    }
    const payloads = parsed.searchParams.getAll('payload');
    if (payloads.length !== 1 || !payloads[0]) {
      return {
        status: 'error',
        message: 'This Station pairing link has no usable offer.',
      };
    }
    if (!decodeDevicePairingPayload(payloads[0])) {
      return {
        status: 'error',
        message: 'This Station pairing offer is invalid or expired.',
      };
    }
    return { status: 'ok', payload: payloads[0] };
  } catch {
    return {
      status: 'error',
      message: 'This is not a valid Station pairing link.',
    };
  }
}
