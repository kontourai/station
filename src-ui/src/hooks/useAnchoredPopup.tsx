import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Places a composer popup (slash commands, `/model`, `@` files) in a
 * body-level portal against the composer capsule, above it unless there is
 * more room below. Rendering inside the composer instead lets any clipping
 * ancestor cut the list off. Without an anchor the content renders in place;
 * spread `popupStyle` onto the popup root.
 */
export function useAnchoredPopup(
  anchorRef: RefObject<HTMLElement | null> | undefined,
): {
  popupStyle: CSSProperties | undefined;
  renderPopup: (content: ReactNode) => ReactNode;
} {
  const [popupStyle, setPopupStyle] = useState<CSSProperties>();
  // A passive effect, not a layout one: the popups render before their anchor
  // textarea, so in the commit that mounts both, a layout effect here runs
  // before the anchor's ref is attached and would never place the popup.
  useEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const surface = anchor.closest('.chat-input__capsule') ?? anchor;
    const viewport = window.visualViewport;
    const place = () => {
      // A hidden composer must not leave its popup pinned to the top of the
      // page.
      if (surface.checkVisibility?.() === false) {
        setPopupStyle(undefined);
        return;
      }
      const rect = surface.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const above = Math.max(0, rect.top - top - 16);
      const below = Math.max(0, top + height - rect.bottom - 16);
      const placeAbove = above >= 160 || above >= below;
      const popupWidth = Math.min(rect.width, Math.max(0, width - 16));
      setPopupStyle({
        position: 'fixed',
        zIndex: 'calc(var(--layer-dock, 9200) + 1)',
        top: placeAbove ? rect.top - 8 : rect.bottom + 8,
        left: Math.max(
          left + 8,
          Math.min(rect.left, left + width - popupWidth - 8),
        ),
        width: popupWidth,
        right: 'auto',
        bottom: 'auto',
        marginBottom: 0,
        transform: placeAbove ? 'translateY(-100%)' : undefined,
        maxHeight: Math.min(300, placeAbove ? above : below),
      });
    };
    place();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(surface);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [anchorRef]);
  const renderPopup = (content: ReactNode) =>
    anchorRef
      ? popupStyle
        ? createPortal(content, document.body)
        : null
      : content;
  return { popupStyle, renderPopup };
}
