/**
 * archive#1818 — a rejected Tauri `invoke` of a command returning
 * Rust's `NativeCommandError` (`src-desktop/src/lib.rs`) resolves the
 * rejection to the JSON-deserialized value directly: a plain object shaped
 * `{ code: string, message: string }`, NOT an `Error` instance. Every
 * caller on this file's native transports (`authenticatedTransport.ts`,
 * `pairingTransport.ts`) used to collapse that rejection with `String(error)`
 * before this fix — which stringifies a plain object to the useless
 * `"[object Object]"` and, before `NativeCommandError` existed at all, threw
 * away a plain-string Rust error's own text into a wrapper. Neither
 * preserved a `code` a caller could switch on
 * (`packages/connect/src/core/connectionFailureClassification.ts`'s
 * `classifyNativeTransportRefusal` reads `.code` off a thrown `Error`).
 *
 * This is the one seam both files funnel a raw `invoke` rejection through
 * before wrapping it back into a JS `Error` for callers. A command not yet
 * converted to `NativeCommandError` (or an older bundle) still rejects with
 * a bare string — that shape is preserved as `message` with `code`
 * `undefined`, exactly the "no code" case
 * `classifyNativeTransportRefusal` already treats conservatively.
 */
export interface NativeCommandErrorShape {
  code: string | undefined;
  message: string;
}

export function readNativeCommandError(
  error: unknown,
): NativeCommandErrorShape {
  if (typeof error === 'string') {
    return { code: undefined, message: error };
  }
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message =
      typeof record.message === 'string'
        ? record.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { code, message };
  }
  return { code: undefined, message: String(error ?? '') };
}
