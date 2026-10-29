import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';

/** Keep this owner mounted while closed so focus entry is an update, not a StrictMode mount replay. */
export function SidebarPopover({
  open,
  anchorRef,
  label,
  onClose,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const popupRef = useMenuFocus<HTMLDivElement>(open, onClose);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const popup = popupRef.current;
      if (!anchor || !popup) return;
      const rect = anchor.getBoundingClientRect();
      setPosition({
        left: Math.max(
          8,
          Math.min(rect.right + 8, window.innerWidth - popup.offsetWidth - 8),
        ),
        top: Math.max(
          8,
          Math.min(rect.top, window.innerHeight - popup.offsetHeight - 8),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, popupRef]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (popupRef.current?.contains(target) ||
          anchorRef.current?.contains(target))
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open, anchorRef, popupRef, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="sidebar__popover"
      ref={popupRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={position}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
