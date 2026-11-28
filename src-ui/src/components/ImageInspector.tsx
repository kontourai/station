import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from './Button';
import './ImageInspector.css';

interface Point {
  x: number;
  y: number;
}

/** Image scale is relative to native pixels: 1 is actual size, not fitted size. */
export function ImageInspector({
  src,
  name,
  errorMessage = 'This image could not be loaded. Close the preview and try again.',
  onNavigate,
  galleryHeader,
}: {
  src: string;
  name: string;
  errorMessage?: string;
  onNavigate?: (direction: -1 | 1) => void;
  galleryHeader?: ReactNode;
}) {
  const viewportRef = useRef<HTMLElement>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [manualScale, setManualScale] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomControlsId = useId();
  const zoomTrigger = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<Point | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const anchor = useRef<{ x: number; y: number; at: Point } | null>(null);
  const fit =
    natural.width && viewport.width && viewport.height
      ? Math.min(
          1,
          viewport.width / natural.width,
          viewport.height / natural.height,
        )
      : 1;
  const scale = manualScale ?? fit;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const minimum = Math.min(fit, 0.1);
  const ready = natural.width > 0 && viewport.width > 0 && !failed;

  const previousSrc = useRef(src);
  useLayoutEffect(() => {
    if (previousSrc.current === src) return;
    previousSrc.current = src;
    // Retain the viewport element and keyboard focus when gallery navigation
    // replaces the image, while discarding the previous image's geometry.
    setNatural({ width: 0, height: 0 });
    setManualScale(null);
    setFailed(false);
    pointers.current.clear();
    swipeStart.current = null;
    anchor.current = null;
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  }, [src]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () =>
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoom = useCallback(
    (requested: number, point?: Point) => {
      const el = viewportRef.current;
      if (!el || !natural.width || !natural.height) return;
      const previous = scaleRef.current;
      const next = Math.max(minimum, Math.min(8, requested));
      if (next === previous) {
        anchor.current = null;
        setManualScale(next);
        return;
      }
      const bounds = el.getBoundingClientRect();
      const at = point
        ? { x: point.x - bounds.left, y: point.y - bounds.top }
        : { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      // Account for the centering space when an axis fits inside the viewport.
      anchor.current = {
        x:
          (el.scrollLeft +
            at.x -
            Math.max(0, (el.clientWidth - natural.width * previous) / 2)) /
          previous,
        y:
          (el.scrollTop +
            at.y -
            Math.max(0, (el.clientHeight - natural.height * previous) / 2)) /
          previous,
        at,
      };
      scaleRef.current = next;
      setManualScale(next);
    },
    [minimum, natural],
  );

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const target = anchor.current;
    if (!el || !target) return;
    el.scrollLeft =
      target.x * scale +
      Math.max(0, (el.clientWidth - natural.width * scale) / 2) -
      target.at.x;
    el.scrollTop =
      target.y * scale +
      Math.max(0, (el.clientHeight - natural.height * scale) / 2) -
      target.at.y;
    anchor.current = null;
  }, [scale, natural]);

  const reset = () => {
    anchor.current = null;
    setManualScale(null);
    const el = viewportRef.current;
    if (el) {
      el.scrollLeft = 0;
      el.scrollTop = 0;
    }
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      // Normal scrolling pans; browser Ctrl/Meta zoom remains available.
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      zoom(scaleRef.current * (event.deltaY < 0 ? 1.25 : 0.8), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom]);

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const el = viewportRef.current;
    const previous = pointers.current.get(event.pointerId);
    if (!el || !previous) return;
    const next = { x: event.clientX, y: event.clientY };
    const other = [...pointers.current.entries()].find(
      ([id]) => id !== event.pointerId,
    )?.[1];
    pointers.current.set(event.pointerId, next);
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(next.x - other.x, next.y - other.y);
      if (before > 0 && after > 0) {
        zoom((scaleRef.current * after) / before, {
          x: (previous.x + other.x) / 2,
          y: (previous.y + other.y) / 2,
        });
        if (anchor.current) {
          anchor.current.at.x += (next.x - previous.x) / 2;
          anchor.current.at.y += (next.y - previous.y) / 2;
        }
      }
    } else {
      el.scrollLeft -= next.x - previous.x;
      el.scrollTop -= next.y - previous.y;
    }
  };

  const zoomControls = (
    <fieldset className="image-inspector__controls" aria-label="Image zoom">
      <Button
        variant={galleryHeader ? 'ghost' : undefined}
        disabled={!ready}
        onClick={reset}
      >
        Fit
      </Button>
      <Button
        variant={galleryHeader ? 'ghost' : undefined}
        disabled={!ready}
        onClick={() => zoom(1)}
      >
        Actual size
      </Button>
      <Button
        variant={galleryHeader ? 'ghost' : undefined}
        className="image-inspector__zoom-step"
        disabled={!ready || scale <= minimum}
        onClick={() => zoom(scale / 1.25)}
        aria-label="Zoom out"
        title="Zoom out"
      >
        <span aria-hidden="true">−</span>
      </Button>
      <output aria-label="Image zoom level">
        {ready ? `${Math.round(scale * 100)}%` : '—'}
      </output>
      <Button
        variant={galleryHeader ? 'ghost' : undefined}
        className="image-inspector__zoom-step"
        disabled={!ready || scale >= 8}
        onClick={() => zoom(scale * 1.25)}
        aria-label="Zoom in"
        title="Zoom in"
      >
        <span aria-hidden="true">+</span>
      </Button>
    </fieldset>
  );

  return (
    <section
      className={
        galleryHeader
          ? 'image-inspector image-inspector--gallery'
          : 'image-inspector'
      }
      aria-label="Image inspection"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && zoomOpen) {
          event.preventDefault();
          setZoomOpen(false);
          zoomTrigger.current?.focus();
        }
      }}
    >
      {galleryHeader ? (
        <div className="image-inspector__toolbar">
          {galleryHeader}
          <Button
            ref={zoomTrigger}
            variant="ghost"
            aria-label="Zoom controls"
            aria-expanded={zoomOpen}
            aria-controls={zoomControlsId}
            title="Zoom controls"
            onClick={() => setZoomOpen(!zoomOpen)}
          >
            <span aria-hidden="true">⋯</span>
          </Button>
          <div
            id={zoomControlsId}
            className="image-inspector__zoom-popover"
            hidden={!zoomOpen}
          >
            {zoomOpen && zoomControls}
          </div>
        </div>
      ) : (
        zoomControls
      )}
      {/* A scrollable image region needs keyboard focus for pan and zoom. */}
      <section
        ref={viewportRef}
        className="image-inspector__viewport"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users pan this scrollable image region.
        tabIndex={0}
        aria-label="Image viewport"
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey || !ready) return;
          const el = event.currentTarget;
          const pan =
            el.scrollWidth > el.clientWidth + 1 ||
            el.scrollHeight > el.clientHeight + 1;
          const directions: Record<string, Point> = {
            ArrowLeft: { x: -44, y: 0 },
            ArrowRight: { x: 44, y: 0 },
            ArrowUp: { x: 0, y: -44 },
            ArrowDown: { x: 0, y: 44 },
          };
          const direction = directions[event.key];
          if (direction && pan) {
            el.scrollLeft += direction.x;
            el.scrollTop += direction.y;
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            onNavigate?.(event.key === 'ArrowLeft' ? -1 : 1);
          } else if (event.key === '+' || event.key === '=') zoom(scale * 1.25);
          else if (event.key === '-') zoom(scale / 1.25);
          else if (event.key === 'Home') reset();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (!ready || event.button !== 0 || pointers.current.size >= 2)
            return;
          event.currentTarget.focus({ preventScroll: true });
          swipeStart.current =
            onNavigate &&
            pointers.current.size === 0 &&
            scaleRef.current <= fit &&
            event.pointerType === 'touch'
              ? { x: event.clientX, y: event.clientY }
              : null;
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          if (!pointers.current.delete(event.pointerId)) return;
          const start = swipeStart.current;
          swipeStart.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.4)
            onNavigate?.(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={(event) => {
          if (pointers.current.delete(event.pointerId))
            swipeStart.current = null;
        }}
        onLostPointerCapture={(event) => {
          if (pointers.current.delete(event.pointerId))
            swipeStart.current = null;
        }}
      >
        {failed ? (
          <p role="alert">{errorMessage}</p>
        ) : (
          <div
            className="image-inspector__canvas"
            style={{
              width: natural.width ? natural.width * scale : '100%',
              height: natural.height ? natural.height * scale : '100%',
            }}
          >
            <img
              src={src}
              alt={name}
              draggable={false}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
              style={{
                width: natural.width ? natural.width * scale : undefined,
                height: natural.height ? natural.height * scale : undefined,
              }}
            />
          </div>
        )}
      </section>
      {!galleryHeader && (
        <p className="image-inspector__hint">
          <span className="image-inspector__hint-mobile">
            Pinch to zoom. Drag to pan.
          </span>
          <span className="image-inspector__hint-desktop">
            Drag to pan. Alt+scroll to zoom. Home fits the image.
          </span>
        </p>
      )}
    </section>
  );
}
