import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './InfoTip.css';

const TOOLTIP_WIDTH = 280;
const VIEWPORT_GUTTER = 12;

interface InfoTipPosition {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [position, setPosition] = useState<InfoTipPosition | null>(null);

  const cancelDismiss = () => clearTimeout(dismissTimer.current);
  const dismiss = useCallback(() => {
    clearTimeout(dismissTimer.current);
    pinned.current = false;
    setOpen(false);
  }, []);
  const leave = () => {
    cancelDismiss();
    dismissTimer.current = setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2),
      Math.max(
        VIEWPORT_GUTTER,
        window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_GUTTER,
      ),
    );
    const height = tooltipRef.current?.offsetHeight ?? 160;
    const placeAbove =
      window.innerHeight - rect.bottom < height + 8 && rect.top > height + 8;
    const next = {
      left,
      top: placeAbove
        ? Math.max(height + VIEWPORT_GUTTER, rect.top - 8)
        : Math.min(
            rect.bottom + 8,
            window.innerHeight - height - VIEWPORT_GUTTER,
          ),
      placement: placeAbove ? ('above' as const) : ('below' as const),
    };
    setPosition((current) =>
      current?.left === next.left &&
      current.top === next.top &&
      current.placement === next.placement
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    if (open && position?.placement) place();
  });

  useEffect(() => {
    if (!open) return;
    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        tooltipRef.current?.contains(target)
      ) {
        return;
      }
      dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
      triggerRef.current?.focus();
    };

    place();
    document.addEventListener('pointerdown', dismissOnPointerDown);
    document.addEventListener('keydown', dismissOnEscape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown);
      document.removeEventListener('keydown', dismissOnEscape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, dismiss, place]);

  return (
    <span className="info-tip">
      <button
        ref={triggerRef}
        type="button"
        className="info-tip__trigger"
        aria-label={`More about ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => {
          cancelDismiss();
          setOpen(true);
        }}
        onMouseLeave={leave}
        onClick={() => {
          cancelDismiss();
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
        onKeyDown={(event) => {
          const tooltip = tooltipRef.current;
          if (!tooltip) return;
          const direction =
            event.key === 'ArrowDown' || event.key === 'PageDown'
              ? 1
              : event.key === 'ArrowUp' || event.key === 'PageUp'
                ? -1
                : 0;
          if (!direction) return;
          event.preventDefault();
          tooltip.scrollTop +=
            direction *
            (event.key.startsWith('Page') ? tooltip.clientHeight : 40);
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={tooltipRef}
              id={id}
              role="tooltip"
              className={`info-tip__content info-tip__content--${position.placement}`}
              style={{ left: position.left, top: position.top }}
              onMouseEnter={cancelDismiss}
              onMouseLeave={leave}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
