import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.min(
        Math.max(
          VIEWPORT_GUTTER,
          rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2,
        ),
        Math.max(
          VIEWPORT_GUTTER,
          window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_GUTTER,
        ),
      );
      const placeAbove =
        window.innerHeight - rect.bottom < 160 && rect.top > 160;
      const height = tooltipRef.current?.offsetHeight ?? 160;
      setPosition({
        left,
        top: placeAbove
          ? Math.max(height + VIEWPORT_GUTTER, rect.top - 8)
          : Math.min(
              rect.bottom + 8,
              window.innerHeight - height - VIEWPORT_GUTTER,
            ),
        placement: placeAbove ? 'above' : 'below',
      });
    };
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
      dismiss();
      triggerRef.current?.focus();
    };

    place();
    const frame = requestAnimationFrame(place);
    document.addEventListener('pointerdown', dismissOnPointerDown);
    document.addEventListener('keydown', dismissOnEscape);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismissOnPointerDown);
      document.removeEventListener('keydown', dismissOnEscape);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, dismiss]);

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
