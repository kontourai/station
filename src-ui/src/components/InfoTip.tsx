import { useEffect, useId, useRef, useState } from 'react';
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
  const [position, setPosition] = useState<InfoTipPosition | null>(null);

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
      setPosition({
        left,
        top: placeAbove ? rect.top - 8 : rect.bottom + 8,
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
      setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    place();
    document.addEventListener('pointerdown', dismissOnPointerDown);
    document.addEventListener('keydown', dismissOnEscape);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown);
      document.removeEventListener('keydown', dismissOnEscape);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <span className="info-tip">
      <button
        ref={triggerRef}
        type="button"
        className="info-tip__trigger"
        aria-label={`More about ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={tooltipRef}
              id={id}
              role="tooltip"
              className={`info-tip__content info-tip__content--${position.placement}`}
              style={{ left: position.left, top: position.top }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
