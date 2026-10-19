import { type RefObject, useLayoutEffect, useState } from 'react';
import { TRANSCRIPT_MIN_WIDTH } from '../chat/transcriptMeasure';

/**
 * The session context card's column, border included. One number for the
 * slot's inline width and for the fit below, so the room the card is judged
 * to need is exactly the room it takes.
 */
export const SESSION_CONTEXT_CARD_WIDTH = 280;

/**
 * Whether the card fits beside the transcript: the conversation surface keeps
 * the transcript's own floor (`TRANSCRIPT_MIN_WIDTH`, derived from the
 * message column's gutters, bubble width and padding) after giving the card
 * its column.
 *
 * `surfaceWidth` is the conversation surface as rendered. While the card is
 * shown the surface is already `SESSION_CONTEXT_CARD_WIDTH` narrower, so its
 * room is the surface plus the card's column; that makes the answer the same
 * on either side of showing the card, so showing it cannot flip it back.
 */
export function sessionContextCardFits(
  surfaceWidth: number,
  cardShown: boolean,
): boolean {
  const room = surfaceWidth + (cardShown ? SESSION_CONTEXT_CARD_WIDTH : 0);
  return room >= TRANSCRIPT_MIN_WIDTH + SESSION_CONTEXT_CARD_WIDTH;
}

/**
 * The dock's own width decides, not the viewport (`useIsMobile`): the same
 * window holds a 400px side dock and a full-width bottom dock. A measurement
 * rather than a CSS container query because two surfaces read the answer —
 * the card in the dock body, and the header items it replaces, which render
 * into the region bar's slots outside the body — and both must read the one
 * derivation so the card and the header never show the same fact twice or
 * neither.
 */
export function useSessionContextCardFits(
  surfaceRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) {
      setFits(false);
      return;
    }
    let shown = false;
    const measure = () => {
      shown = sessionContextCardFits(
        surface.getBoundingClientRect().width,
        shown,
      );
      setFits(shown);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [enabled, surfaceRef]);
  return enabled && fits;
}
