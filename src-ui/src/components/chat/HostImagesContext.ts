import type { ChatHostImageMap } from '@kontourai/station-contracts/chat-host-images';
import { createContext, useContext } from 'react';

/**
 * chat-host-images: what an assistant row knows about the host images its
 * reply names — the turn's map from each path to the attachment Station kept
 * or to why it did not, and whether the row has settled (a streaming row has
 * no capture yet). `MessageBubble` and `StreamingMessage` provide it; a
 * document view or a shared answer gets `null` and renders as before.
 */
export interface HostImagesView {
  map: ChatHostImageMap;
  settled: boolean;
}

const NO_HOST_IMAGE_MAP: ChatHostImageMap = Object.freeze({
  images: Object.freeze({}),
  refused: Object.freeze({}),
}) as ChatHostImageMap;

/** The provider value for a streaming row. */
export const STREAMING_HOST_IMAGES: HostImagesView = Object.freeze({
  map: NO_HOST_IMAGE_MAP,
  settled: false,
});

const settledViews = new WeakMap<ChatHostImageMap, HostImagesView>();
const SETTLED_WITHOUT_IMAGES: HostImagesView = Object.freeze({
  map: NO_HOST_IMAGE_MAP,
  settled: true,
});

/** A stable provider value for a committed row (no re-render churn). */
export function settledHostImages(
  map: ChatHostImageMap | undefined,
): HostImagesView {
  if (!map) return SETTLED_WITHOUT_IMAGES;
  let view = settledViews.get(map);
  if (!view) {
    view = { map, settled: true };
    settledViews.set(map, view);
  }
  return view;
}

export const HostImagesContext = createContext<HostImagesView | null>(null);

export function useHostImages(): HostImagesView | null {
  return useContext(HostImagesContext);
}
