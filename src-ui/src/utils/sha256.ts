/**
 * The UI's one SHA-256 digest: lowercase hex, from the platform's WebCrypto
 * when the context offers it, from `@noble/hashes` when it does not (an
 * insecure origin exposes no `crypto.subtle`), so a content digest — a
 * downloaded task output's integrity check, an imported document's identity —
 * never depends on where Station is running.
 */

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : (await import('@noble/hashes/sha2.js')).sha256(bytes);
  return toHex(digest);
}

/**
 * WebCrypto's SubtleCrypto, or throw: a starter operation id is only a
 * stable identity when every context that derives it agrees, so its callers
 * fail a context without the platform primitive rather than silently
 * substituting a software digest. Pass the surface's own explanation.
 */
export function requireSubtleCrypto(reason: string): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error(reason);
  return subtle;
}
