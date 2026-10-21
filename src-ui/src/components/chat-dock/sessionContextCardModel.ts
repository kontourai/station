import { type RefObject, useLayoutEffect, useState } from 'react';
import { TRANSCRIPT_MIN_WIDTH } from '../chat/transcriptMeasure';

/**
 * The session context card's column, border included. One number for the
 * slot's inline width and for the fit below, so the room the card is judged
 * to need is exactly the room it takes.
 */
export const SESSION_CONTEXT_CARD_WIDTH = 280;

/**
 * Whether the card fits beside the transcript: the transcript keeps its own
 * floor (`TRANSCRIPT_MIN_WIDTH`, derived from the message column's gutters,
 * bubble width and padding) after giving the card its column.
 *
 * `transcriptWidth` is the transcript column as rendered: the conversation
 * surface less any column beside it in the surface, such as an open Chat
 * inventory aside (#3882). While the card is shown the column is already
 * `SESSION_CONTEXT_CARD_WIDTH` narrower, so its room is the column plus the
 * card's; that makes the answer the same on either side of showing the
 * card, so showing it cannot flip it back.
 */
export function sessionContextCardFits(
  transcriptWidth: number,
  cardShown: boolean,
): boolean {
  const room = transcriptWidth + (cardShown ? SESSION_CONTEXT_CARD_WIDTH : 0);
  return room >= TRANSCRIPT_MIN_WIDTH + SESSION_CONTEXT_CARD_WIDTH;
}

/**
 * The transcript's column inside the conversation surface (the dock's content
 * area), or the surface itself while something else fills it (the
 * conversation-open recovery notice, or an imported conversation).
 */
function transcriptColumn(surface: HTMLElement): HTMLElement {
  return (
    surface.querySelector<HTMLElement>(':scope > .chat-dock__content-area') ??
    surface
  );
}

/**
 * The dock's own width decides, not the viewport (`useIsMobile`): the same
 * window holds a 400px side dock and a full-width bottom dock. A measurement
 * rather than a CSS container query because two surfaces read the answer —
 * the card in the dock body, and the header items it replaces, which render
 * into the region bar's slots outside the body — and both must read the one
 * derivation so the card and the header never show the same fact twice or
 * neither.
 *
 * It measures the transcript column, not the whole surface: a Chat inventory
 * aside opening beside the transcript leaves the surface's width unchanged
 * but takes the transcript's room, and the card gives way to it (#3882).
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
    let column = transcriptColumn(surface);
    const measure = () => {
      shown = sessionContextCardFits(
        column.getBoundingClientRect().width,
        shown,
      );
      setFits(shown);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    if (column !== surface) observer.observe(column);
    // The column is replaced when the recovery notice or an imported
    // conversation comes and goes.
    const children =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            const next = transcriptColumn(surface);
            if (next === column) return;
            if (column !== surface) observer.unobserve(column);
            column = next;
            if (column !== surface) observer.observe(column);
            measure();
          });
    children?.observe(surface, { childList: true });
    return () => {
      observer.disconnect();
      children?.disconnect();
    };
  }, [enabled, surfaceRef]);
  return enabled && fits;
}
