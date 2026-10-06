import { createContext, useContext } from 'react';
import type { LayoutChatPlacement } from './project-layout-kind';

/**
 * The current route's Chat placement (`resolveLayoutChatPlacement`), provided
 * by App from the layout it is rendering. Readers outside the layout — the
 * region shells, the toolbar's Chat chord, `useShowSurface` — use it to know
 * that the Coding layout's centre owns Chat, so they suspend the ambient
 * `chat` surface and route "show Chat" to the centre instead of the dock.
 *
 * `none` outside App (isolated tests, the model-less mount): Chat is wherever
 * the region model placed it.
 */
export const LayoutChatPlacementContext =
  createContext<LayoutChatPlacement>('none');

export function useLayoutChatPlacement(): LayoutChatPlacement {
  return useContext(LayoutChatPlacementContext);
}

/**
 * What the Coding layout's centre suspends while it owns Chat. One constant
 * so the suspension's identity — a memo input of every reader below it — is
 * stable wherever it is applied (the region shells and the toolbar).
 */
export const CENTER_OWNED_SURFACES: readonly string[] = ['chat'];

/**
 * "Show the Chat page and focus its composer" — the request the toolbar's Chat
 * chord and `showSurface('chat')` make while the Coding centre owns Chat. The
 * mounted Coding workbench answers it. A request with no workbench mounted
 * returns false so the caller can fall back to its ordinary behaviour.
 */
type CenterChatRequestListener = () => void;
const centerChatRequestListeners = new Set<CenterChatRequestListener>();

export function requestCenterChatPage(): boolean {
  if (centerChatRequestListeners.size === 0) return false;
  for (const listener of [...centerChatRequestListeners]) listener();
  return true;
}

export function subscribeCenterChatPageRequests(
  listener: CenterChatRequestListener,
): () => void {
  centerChatRequestListeners.add(listener);
  return () => {
    centerChatRequestListeners.delete(listener);
  };
}

/**
 * "Show Chat" for a writer outside the region model — the command palette,
 * a turn notification, a share or a new session. While the Coding centre owns
 * Chat that is its Chat page; opening the dock there would persist a visible
 * Chat region that renders nothing on the route (the region shells suspend
 * it). Anywhere else it is the dock, as before.
 */
export function showChatPageOrDock(openDock: () => void): void {
  if (!requestCenterChatPage()) openDock();
}
