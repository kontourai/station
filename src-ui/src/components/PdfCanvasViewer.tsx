import './PdfCanvasViewer.css';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from './Button';
import { type OpenedPdf, openPdf } from './pdf/pdf-document';
import { Empty, SkeletonBlock } from './state';

interface PageSize {
  width: number;
  height: number;
}

type DocumentState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; firstPage: PageSize }
  | { status: 'failed'; reason: 'password' | 'unreadable' };

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
/** Horizontal breathing room between a fitted page and the viewport edges. */
const PAGE_GUTTER_PX = 16;
/**
 * Backing-store ceiling per page canvas. Mobile engines refuse (or silently
 * blank) canvases much past 16M pixels; past this the page is drawn at a
 * lower resolution and scaled up, which is soft but never blank.
 */
const MAX_CANVAS_PIXELS = 16_777_216;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function isPasswordError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'PasswordException'
  );
}

function isCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'RenderingCancelledException'
  );
}

/**
 * Whether this page is near enough to the viewport to hold a drawn canvas.
 * Pages further away keep their size but release their pixels, so a long
 * document costs a handful of canvases rather than one per page.
 */
function useNearViewport(
  target: RefObject<HTMLElement | null>,
  root: HTMLElement | null,
): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!element || !root) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setNear(entry.isIntersecting);
      },
      { root, rootMargin: '100% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, root]);
  return near;
}

function PdfPage({
  doc,
  pageNumber,
  pageCount,
  initialSize,
  fitWidth,
  zoom,
  root,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  pageCount: number;
  initialSize: PageSize;
  fitWidth: number;
  zoom: number;
  root: HTMLElement | null;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNearViewport(holderRef, root);
  const [size, setSize] = useState(initialSize);
  const [failed, setFailed] = useState(false);
  const scale = (fitWidth > 0 ? fitWidth / size.width : 1) * zoom;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      // Out of range: give the pixels back and keep the box.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    let cancelled = false;
    let page: PDFPageProxy | undefined;
    let task: RenderTask | undefined;
    doc
      .getPage(pageNumber)
      .then((loaded) => {
        if (cancelled) return;
        page = loaded;
        const natural = loaded.getViewport({ scale: 1 });
        if (natural.width !== size.width || natural.height !== size.height) {
          // Sized from page 1 until now; this re-renders at the right scale.
          setSize({ width: natural.width, height: natural.height });
          return;
        }
        // The ceiling bounds the final backing-store scale, zoom and device
        // pixels included: past it the page is drawn softer, never larger.
        const ratio = window.devicePixelRatio || 1;
        const output = Math.min(
          scale * ratio,
          Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height)),
        );
        const viewport = loaded.getViewport({ scale: output });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = loaded.render({ canvas, viewport });
        return task.promise;
      })
      .then(() => {
        if (!cancelled) setFailed(false);
      })
      .catch((error: unknown) => {
        if (!cancelled && !isCancelled(error)) setFailed(true);
      });
    return () => {
      cancelled = true;
      task?.cancel();
      page?.cleanup();
    };
  }, [doc, pageNumber, near, scale, size]);

  const label = `Page ${pageNumber} of ${pageCount}`;
  return (
    <div
      ref={holderRef}
      className="pdf-canvas-viewer__page"
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} />
      {failed && (
        <p className="pdf-canvas-viewer__page-error">
          Station could not draw page {pageNumber}.
        </p>
      )}
    </div>
  );
}

/**
 * A PDF drawn to canvas by pdf.js, for engines with no PDF viewer of their own
 * (Android WebView). Pages render lazily as they approach the viewport, fit
 * the dialog's width, and zoom in steps. There is no text layer: text cannot
 * be selected or searched here, and Download stays available beside it.
 */
export default function PdfCanvasViewer({ blob }: { blob: Blob }) {
  const [state, setState] = useState<DocumentState>({ status: 'loading' });
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [fitWidth, setFitWidth] = useState(0);
  const scrollAnchor = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let opened: OpenedPdf | undefined;
    setState({ status: 'loading' });
    setZoom(1);
    blob
      .arrayBuffer()
      .then((buffer) => {
        if (!active) return;
        opened = openPdf(new Uint8Array(buffer));
        return opened.promise.then(async (doc) => {
          const first = (await doc.getPage(1)).getViewport({ scale: 1 });
          if (active)
            setState({
              status: 'ready',
              doc,
              firstPage: { width: first.width, height: first.height },
            });
        });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            status: 'failed',
            reason: isPasswordError(error) ? 'password' : 'unreadable',
          });
      });
    return () => {
      active = false;
      opened?.destroy();
    };
  }, [blob]);

  useEffect(() => {
    if (!viewport) return;
    const measure = () =>
      setFitWidth(Math.max(0, viewport.clientWidth - PAGE_GUTTER_PX * 2));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  // Zooming keeps the reader at the same place in the document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores the anchor after each zoom's layout.
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    if (anchor === null || !viewport) return;
    scrollAnchor.current = null;
    viewport.scrollTop = anchor * viewport.scrollHeight;
  }, [zoom, viewport]);

  const changeZoom = (next: number) => {
    const target = clampZoom(next);
    if (target === zoom) return;
    if (viewport && viewport.scrollHeight > 0)
      scrollAnchor.current = viewport.scrollTop / viewport.scrollHeight;
    setZoom(target);
  };

  if (state.status === 'failed') {
    return state.reason === 'password' ? (
      <Empty
        label="This PDF is password-protected"
        description="Station can't unlock it here. Download it to open it in an app that can."
      />
    ) : (
      <Empty
        label="Preview unavailable"
        description="Station could not read this PDF. Download it to open it."
      />
    );
  }
  if (state.status === 'loading') {
    return <SkeletonBlock count={3} label="Loading PDF preview" />;
  }

  const pageCount = state.doc.numPages;
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
  return (
    <div className="pdf-canvas-viewer">
      <fieldset className="pdf-canvas-viewer__controls" aria-label="PDF zoom">
        <output aria-label="PDF page count">
          {pageCount === 1 ? '1 page' : `${pageCount} pages`}
        </output>
        <Button disabled={zoom === 1} onClick={() => changeZoom(1)}>
          Fit width
        </Button>
        <Button
          className="pdf-canvas-viewer__zoom-step"
          disabled={zoom <= ZOOM_MIN}
          onClick={() => changeZoom(zoom / ZOOM_STEP)}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <span aria-hidden="true">−</span>
        </Button>
        <output aria-label="PDF zoom level">{Math.round(zoom * 100)}%</output>
        <Button
          className="pdf-canvas-viewer__zoom-step"
          disabled={zoom >= ZOOM_MAX}
          onClick={() => changeZoom(zoom * ZOOM_STEP)}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <span aria-hidden="true">+</span>
        </Button>
      </fieldset>
      {/* A scrollable page region needs keyboard focus to scroll and zoom. */}
      <section
        ref={setViewport}
        className="pdf-canvas-viewer__viewport"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll this page region.
        tabIndex={0}
        aria-label="PDF pages"
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === '+' || event.key === '=')
            changeZoom(zoom * ZOOM_STEP);
          else if (event.key === '-') changeZoom(zoom / ZOOM_STEP);
          else if (event.key === '0') changeZoom(1);
          else return;
          event.preventDefault();
        }}
      >
        {pages.map((pageNumber) => (
          <PdfPage
            key={pageNumber}
            doc={state.doc}
            pageNumber={pageNumber}
            pageCount={pageCount}
            initialSize={state.firstPage}
            fitWidth={fitWidth}
            zoom={zoom}
            root={viewport}
          />
        ))}
      </section>
    </div>
  );
}
