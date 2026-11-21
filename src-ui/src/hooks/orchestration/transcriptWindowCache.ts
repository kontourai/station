import type { ConversationContextBoundaryTranscriptMarker } from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  ConversationHandoffProjection,
  OrchestrationConversationEventWindow,
  OrchestrationSequencedEvent,
} from '@kontourai/station-contracts/orchestration';

/**
 * Recently read transcript windows, so switching back to a conversation
 * paints the rows it last showed while a normal read revalidates them.
 *
 * Read-only paint state: nothing here grants a write. The conversation-open
 * read still owns whether the composer is writable.
 *
 * Bounded by entry count AND an approximate byte ceiling (serialized
 * length), least recently used first. An entry over the byte ceiling on its
 * own is refused rather than kept by evicting everything else.
 */
export const TRANSCRIPT_WINDOW_CACHE_MAX_ENTRIES = 12;
export const TRANSCRIPT_WINDOW_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export interface TranscriptWindowSnapshot {
  events: readonly OrchestrationSequencedEvent[];
  cursor?: string;
  watermark: number;
  sessionLineage?: NonNullable<
    OrchestrationConversationEventWindow['sessionLineage']
  >;
  handoffs: readonly ConversationHandoffProjection[];
  contextBoundaries: readonly ConversationContextBoundaryTranscriptMarker[];
  memoryContinuation?: OrchestrationConversationEventWindow['memoryContinuation'];
  partialTurnStartEventIds: readonly string[];
}

interface Entry {
  snapshot: TranscriptWindowSnapshot;
  bytes: number;
  savedAt: number;
}

// Map iteration order is insertion order: the first key is the least
// recently used one, because every read and write re-inserts its key.
const entries = new Map<string, Entry>();
let totalBytes = 0;
// Bumped by every clear. A read that started before a clear carries the old
// generation, and its late write is refused rather than repopulating a cache
// the clear just emptied.
let generation = 0;

export function transcriptWindowCacheGeneration(): number {
  return generation;
}

/**
 * The partition a window was read under: the verified app authority, the
 * target Station's authority (a remote connection's stable namespace, not
 * its per-lease runtime key, which changes on every re-lease), the API base
 * and request scope, and the conversation. No verified authority, no key:
 * nothing is cached or painted while the authority is unknown.
 */
export function transcriptWindowCacheKey(input: {
  namespace: string | null | undefined;
  stationNamespace?: string;
  apiBase: string;
  authorityKey?: string;
  conversationId: string;
}): string | undefined {
  if (!input.namespace) return undefined;
  return JSON.stringify([
    input.namespace,
    input.stationNamespace ?? null,
    input.apiBase,
    input.authorityKey ?? null,
    input.conversationId,
  ]);
}

function remove(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.bytes;
}

/** Forget one window: the server would not confirm it. */
export function evictTranscriptWindow(key: string | undefined): void {
  if (key) remove(key);
}

export function readTranscriptWindow(
  key: string | undefined,
): TranscriptWindowSnapshot | undefined {
  if (!key) return undefined;
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry.snapshot;
}

/** Milliseconds since `key` was last written, or undefined when absent. */
export function transcriptWindowAge(
  key: string | undefined,
  now = Date.now(),
): number | undefined {
  const entry = key ? entries.get(key) : undefined;
  return entry ? now - entry.savedAt : undefined;
}

/**
 * Returns false when refused: no key, a clear since `readGeneration` (when
 * given), or a snapshot that alone exceeds the byte ceiling.
 */
export function writeTranscriptWindow(
  key: string | undefined,
  snapshot: TranscriptWindowSnapshot,
  readGeneration?: number,
  now = Date.now(),
): boolean {
  if (!key) return false;
  if (readGeneration !== undefined && readGeneration !== generation)
    return false;
  remove(key);
  const bytes = JSON.stringify(snapshot).length;
  if (bytes > TRANSCRIPT_WINDOW_CACHE_MAX_BYTES) return false;
  entries.set(key, { snapshot, bytes, savedAt: now });
  totalBytes += bytes;
  for (const oldest of entries.keys()) {
    if (
      entries.size <= TRANSCRIPT_WINDOW_CACHE_MAX_ENTRIES &&
      totalBytes <= TRANSCRIPT_WINDOW_CACHE_MAX_BYTES
    )
      break;
    remove(oldest);
  }
  return true;
}

/** Drop every window: a connection, account or authority scope changed. */
export function clearTranscriptWindowCache(): void {
  entries.clear();
  totalBytes = 0;
  generation += 1;
}

export function transcriptWindowCacheKeys(): string[] {
  return [...entries.keys()];
}
