import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import {
  transcriptWindowAge,
  transcriptWindowCacheKey,
} from './transcriptWindowCache';
import { prefetchTranscriptWindow } from './useSessionEventWindow';

/** How long a pointer or focus rests on a row before its window is read. */
export const TRANSCRIPT_PREFETCH_DWELL_MS = 150;
/** A cached window younger than this is warm enough to paint. */
export const TRANSCRIPT_PREFETCH_FRESH_MS = 30_000;

/**
 * The host Station a dock reads its own conversations from: the same
 * apiBase, request scope and verified authority its transcript readers use,
 * so a prefetch lands under the key a reader will look up. Absent (the
 * default) means no prefetch.
 */
export interface TranscriptPrefetchTarget {
  apiBase: string;
  requestScope?: ApiRequestScope;
  namespace: string | null;
}

const TranscriptPrefetchTargetContext =
  createContext<TranscriptPrefetchTarget | null>(null);

export function TranscriptPrefetchTargetProvider({
  value,
  children,
}: {
  value: TranscriptPrefetchTarget;
  children: ReactNode;
}) {
  return createElement(
    TranscriptPrefetchTargetContext.Provider,
    { value },
    children,
  );
}

// At most one prefetch in flight across every row; a newer one replaces it.
let inFlight: { key: string; controller: AbortController } | undefined;

function startPrefetch(
  target: TranscriptPrefetchTarget,
  conversationId: string,
) {
  const key = transcriptWindowCacheKey({
    namespace: target.namespace,
    apiBase: target.apiBase,
    ...(target.requestScope?.authorityKey
      ? { authorityKey: target.requestScope.authorityKey }
      : {}),
    conversationId,
  });
  if (!key || inFlight?.key === key) return;
  const age = transcriptWindowAge(key);
  if (age !== undefined && age < TRANSCRIPT_PREFETCH_FRESH_MS) return;
  inFlight?.controller.abort();
  const controller = new AbortController();
  const current = { key, controller };
  inFlight = current;
  void prefetchTranscriptWindow({
    cacheKey: key,
    apiBase: target.apiBase,
    conversationId,
    ...(target.requestScope ? { requestScope: target.requestScope } : {}),
    signal: controller.signal,
  })
    .catch(() => false)
    .finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
}

/**
 * Row handlers that warm a conversation's transcript window after a short
 * hover or keyboard-focus dwell. Touch and pen pointers never prefetch:
 * a tap is an open, not a hover. A remote Station's row passes no id.
 */
export function useTranscriptWindowPrefetch(conversationId?: string) {
  const target = useContext(TranscriptPrefetchTargetContext);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    if (!target || !conversationId) return;
    // A touch-only device focuses the row it is opening; nothing to warm.
    if (globalThis.matchMedia?.('(hover: none)').matches) return;
    // The person asked the browser to spend less data: warm nothing.
    if (
      (globalThis.navigator as { connection?: { saveData?: boolean } })
        ?.connection?.saveData === true
    )
      return;
    timer.current = setTimeout(
      () => startPrefetch(target, conversationId),
      TRANSCRIPT_PREFETCH_DWELL_MS,
    );
  }, [target, conversationId]);
  const disarm = useCallback(() => clearTimeout(timer.current), []);
  const onPointerEnter = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') return;
      arm();
    },
    [arm],
  );
  return {
    onPointerEnter,
    onPointerLeave: disarm,
    onFocus: arm,
    onBlur: disarm,
  };
}
