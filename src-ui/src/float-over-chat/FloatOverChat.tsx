import type { authenticatedFetch } from '@kontourai/station-sdk';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LazyBoundary } from '../components/LazyBoundary';
import type { ChatSession } from '../types';

/**
 * Float over chat (#90 D9), the part `ChatDockBody` loads: a zero-height
 * marker, and — once it is in the document and the chat has a Project — the
 * floater itself (`FloatOverChatHost`), in a chunk of its own.
 *
 * Two chunks rather than one because the entry bundle names every chunk a
 * lazy import it makes will need: pointing it at the floater directly listed
 * the floater's stylesheet and the live view it shares with the Browser pane
 * as well, on every cold load. This module needs nothing the entry does not
 * already hold.
 *
 * The marker's position IS the seam: `ChatDockBody` mounts this between the
 * transcript and the composer stack, so the marker's parent is the chat body
 * (the column the transcript and composer share, not the history sidebar
 * beside it) and everything below the marker is what the player must stay
 * off.
 */

export interface FloatOverChatProps {
  /**
   * The chat the floater belongs to. From it: the Project (nothing floats in
   * a chat without one), the conversation its floater and dismissals are
   * keyed by, and the thread ids a browser session opened FROM this chat
   * carries (the tab, its durable conversation, the execution session under
   * it) — only such a session auto-floats here.
   */
  session: Pick<
    ChatSession,
    'id' | 'conversationId' | 'currentSessionId' | 'projectSlug'
  >;
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: typeof authenticatedFetch;
}

const loadFloatOverChatHost = () =>
  import('./FloatOverChatHost').then(({ FloatOverChatHost }) => ({
    default: FloatOverChatHost,
  }));

export default function FloatOverChat({
  session,
  transport,
}: FloatOverChatProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => setAnchor(anchorRef.current), []);
  const { id, conversationId, currentSessionId, projectSlug } = session;
  const threadIds = useMemo(
    () =>
      [id, conversationId, currentSessionId].filter(
        (value): value is string => !!value,
      ),
    [id, conversationId, currentSessionId],
  );
  return (
    <>
      <div ref={anchorRef} className="float-over-chat__anchor" aria-hidden />
      {anchor && projectSlug ? (
        <LazyBoundary
          load={loadFloatOverChatHost}
          componentProps={{
            anchor,
            projectSlug,
            conversationKey: conversationId ?? id,
            tabId: id,
            threadIds,
            ...(transport ? { transport } : {}),
          }}
          pending={null}
          unavailable={() => null}
        />
      ) : null}
    </>
  );
}
