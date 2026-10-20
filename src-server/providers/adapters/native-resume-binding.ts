import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function canonicalHome(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    return join(canonicalHome(dirname(absolute)), basename(absolute));
  }
}

/** No path, profile reference, or credential value leaves the adapter. */
export function nativeResumeBindingKey(
  engine: string,
  configurationHome: string,
  profileRef: string | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([engine, canonicalHome(configurationHome), profileRef]),
    )
    .digest('hex');
}

export function nativeSessionIdentityKey(
  engine: string,
  bindingKey: string,
  nativeId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([engine, bindingKey, nativeId]))
    .digest('hex');
}
