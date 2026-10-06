import { z } from 'zod';

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
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limit = count.positive();
const occupantSchema = z.object({
  method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
  routeCategory: z.enum([
    'orchestration',
    'sessions',
    'config',
    'plugins',
    'system',
    'tasks',
    'projects',
    'agents',
    'monitoring',
    'scheduler',
    'notifications',
    'connections',
    'events',
    'auth',
    'uploads',
    'files',
    'knowledge',
    'registry',
    'other',
  ]),
  ageMs: count,
  phase: z.enum([
    'awaiting-response',
    'receiving-body',
    'receiving-event-stream',
    'waiting-for-admission',
  ]),
  stream: z.boolean(),
  sameOrigin: z.boolean(),
});
const capacitySchema = z.object({
  pendingRequests: count,
  pendingLimit: limit,
  activeRequests: count,
  activeLimit: limit,
  originRequests: count,
  originRequestLimit: limit,
  originStreams: count,
  originStreamLimit: limit,
  retryAfterMs: limit,
  occupants: z.array(occupantSchema).max(32),
  queueHead: occupantSchema.nullable(),
});

export type NativeHttpCapacitySnapshot = z.infer<typeof capacitySchema>;

function readCapacity(value: unknown): NativeHttpCapacitySnapshot | undefined {
  const result = capacitySchema.safeParse(value);
  return result.success ? result.data : undefined;
}

interface NativeCommandErrorShape {
  code: string | undefined;
  message: string;
  capacity?: NativeHttpCapacitySnapshot;
}

export function readNativeCommandError(
  error: unknown,
): NativeCommandErrorShape {
  if (typeof error === 'string') {
    return { code: undefined, message: error };
  }
  if (error && typeof error === 'object') {
    const record = error as {
      code?: unknown;
      message?: unknown;
      capacity?: unknown;
    };
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message =
      typeof record.message === 'string'
        ? record.message
        : error instanceof Error
          ? error.message
          : String(error);
    const capacity =
      code === 'transport_capacity' ? readCapacity(record.capacity) : undefined;
    return { code, message, ...(capacity ? { capacity } : {}) };
  }
  return { code: undefined, message: String(error ?? '') };
}
