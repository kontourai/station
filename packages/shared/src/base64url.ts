/**
 * Unpadded base64url (RFC 4648 section 5) for bytes, the form every signed
 * token segment, nonce and link fragment in Station uses.
 *
 * Browser-safe: only `btoa`, no Node built-ins, so the SDK client, Connect
 * and this package share one encoder instead of each keeping a private copy.
 */

/** `bytes` as base64url with the trailing `=` padding removed. */
export function encodeBase64Url(bytes: Uint8Array): string {
  // A loop, not `String.fromCharCode(...bytes)`: spreading passes one
  // argument per byte and throws a RangeError on a large input.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
