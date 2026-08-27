import type { NativePlatformError } from './types';

export const MAX_NATIVE_SHARE_TEXT_BYTES = 256 * 1024;

export type NativeShareTextResult =
  | { status: 'ok'; text: string }
  | { status: 'empty' }
  | { status: 'error'; error: NativePlatformError };

/**
 * One validation rule for PWA and native share targets. Shared content is
 * untrusted and must be bounded before it reaches React state.
 */
export function validateNativeShareText(value: unknown): NativeShareTextResult {
  if (typeof value !== 'string' || value.length === 0) {
    return { status: 'empty' };
  }
  if (
    new TextEncoder().encode(value).byteLength > MAX_NATIVE_SHARE_TEXT_BYTES
  ) {
    return {
      status: 'error',
      error: {
        code: 'share-too-large',
        message: 'Shared text is too large for Station (256 KiB maximum).',
      },
    };
  }
  return { status: 'ok', text: value };
}
