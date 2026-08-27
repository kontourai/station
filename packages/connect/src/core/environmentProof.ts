import {
  buildStationProofMessage,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts';

function decodeBase64url(value: string): ArrayBuffer {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function createStationProofNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function verifyStationEnvironmentProof(input: {
  credential: string;
  environmentId: string;
  nonce: string;
  response: unknown;
}): Promise<boolean> {
  const response = input.response as Record<string, unknown>;
  if (
    !response ||
    typeof response !== 'object' ||
    response.protocolVersion !== STATION_PROOF_PROTOCOL_VERSION ||
    response.environmentId !== input.environmentId ||
    response.nonce !== input.nonce ||
    typeof response.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(response.signature)
  ) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decodeBase64url(input.credential),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64url(response.signature),
      new TextEncoder().encode(
        buildStationProofMessage(input.environmentId, input.nonce),
      ),
    );
  } catch {
    return false;
  }
}
