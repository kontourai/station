import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export interface VirtualTranscriptRow {
  readonly id: string;
  readonly kind: string;
}

interface TranscriptVirtualizerProps<Row extends VirtualTranscriptRow> {
  readonly rows: readonly Row[];
  readonly scrollElement: RefObject<HTMLElement | null>;
  readonly renderRow: (row: Row) => ReactNode;
  /** The surface has elected to keep the transcript at its newest row. */
  readonly followTail?: boolean;
  /** Monotonic scroll signal from the one owning transcript surface. */
  readonly anchorVersion?: number;
  /** Stable transcript-row key requested by a route or palette result. */
  readonly revealRowId?: string;
}

const ESTIMATED_ROW_HEIGHT: Record<string, number> = {
  'message:user': 88,
  'message:assistant': 176,
  'message:system': 64,
};

/**
 * Station's replaceable DOM virtualizer boundary. The scroll container stays
 * owned by the transcript surface; this adapter contributes only spacer and
 * positioned row mechanics.
 */
export function TranscriptVirtualizer<Row extends VirtualTranscriptRow>({
  rows,
  scrollElement,
  renderRow,
  followTail = false,
  anchorVersion = 0,
  revealRowId,
}: TranscriptVirtualizerProps<Row>) {
  const [scrollReady, setScrollReady] = useState(false);
  const virtualAnchorRef = useRef<
    { id: string; index: number; offset: number } | undefined
  >(undefined);
  const virtualizerOptions = {
    count: rows.length,
    getScrollElement: () => (scrollReady ? scrollElement.current : null),
    estimateSize: (index: number) =>
      ESTIMATED_ROW_HEIGHT[rows[index]?.kind] ?? 96,
    getItemKey: (index: number) => rows[index]?.id ?? index,
    overscan: 8,
    initialRect: { width: 1, height: 600 },
    initialOffset: 0,
    // Measurements can settle several frames after a prepend (markdown,
    // expanded tool details, fonts). Keep compensating every changed row
    // strictly before the retained keyed anchor; a fixed number of rAF
    // corrections cannot prove that the final ResizeObserver has fired.
    shouldAdjustScrollPositionOnItemSizeChange: (
      item: { index: number; start: number },
      _delta: number,
      instance: { getScrollOffset(): number },
    ) => {
      const anchor = virtualAnchorRef.current;
      if (followTail) return item.start < instance.getScrollOffset();
      return anchor ? item.index < anchor.index : false;
    },
  };
  const virtualizer = useVirtualizer(virtualizerOptions);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const previousRowsRef = useRef(rows);

  const captureVirtualAnchor = useCallback(() => {
    const element = scrollElement.current;
    if (element) {
      const elementTop = element.getBoundingClientRect().top;
      const visibleNode = [
        ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
      ].find((node) => node.getBoundingClientRect().bottom > elementTop);
      const visibleId = visibleNode?.dataset.transcriptRow;
      const visibleIndex = visibleId
        ? rowsRef.current.findIndex((row) => row.id === visibleId)
        : -1;
      if (visibleNode && visibleId && visibleIndex >= 0) {
        virtualAnchorRef.current = {
          id: visibleId,
          index: visibleIndex,
          offset: visibleNode.getBoundingClientRect().top - elementTop,
        };
        return;
      }
    }
    const offset =
      element?.scrollTop ?? virtualizerRef.current.scrollOffset ?? 0;
    const item = virtualizerRef.current.getVirtualItemForOffset(offset);
    const row = item ? rowsRef.current[item.index] : undefined;
    if (item && row) {
      virtualAnchorRef.current = {
        id: row.id,
        index: item.index,
        offset: offset - item.start,
      };
      return;
    }
    // During the first scroll before TanStack has measured a recycled range,
    // retain an estimated keyed anchor. The next measured pass corrects its
    // size through measureElement.
    let start = 0;
    for (const [index, candidate] of rowsRef.current.entries()) {
      const size = ESTIMATED_ROW_HEIGHT[candidate.kind] ?? 96;
      if (offset < start + size) {
        virtualAnchorRef.current = {
          id: candidate.id,
          index,
          offset: offset - start,
        };
        return;
      }
      start += size;
    }
  }, [scrollElement]);

  // The host ref is assigned during the same commit as this adapter. Ask the
  // virtualizer to measure after that commit so the first paint includes the
  // initial window rather than an empty spacer.
  useLayoutEffect(() => {
    setScrollReady(scrollElement.current !== null);
    virtualizer.measure();
  }, [scrollElement, virtualizer]);

  const revealedRowRef = useRef<string | undefined>(undefined);
  // A route anchor can point outside the rendered virtual window. Resolve its
  // row index from the bounded event window, then let the virtualizer own the
  // materialization and scroll correction instead of looking for a recycled
  // DOM node.
  useLayoutEffect(() => {
    if (!revealRowId || revealedRowRef.current === revealRowId) return;
    const index = rows.findIndex((row) => row.id === revealRowId);
    if (index < 0) return;
    virtualizerRef.current.scrollToIndex(index, { align: 'center' });
    revealedRowRef.current = revealRowId;
  }, [revealRowId, rows]);

  // Capture only on the owner-confirmed reader gesture. Measurement and
  // programmatic corrections also dispatch native scroll events; listening
  // to every scroll would overwrite the user's retained offset with an
  // intermediate measured position just before a prepend.
  useLayoutEffect(() => {
    void anchorVersion;
    captureVirtualAnchor();
  }, [anchorVersion, captureVirtualAnchor]);

  // Older window pages prepend before the current viewport. Restore the same
  // keyed virtual item plus its within-row offset before paint; measured row
  // corrections remain owned by TanStack's measureElement path.
  useLayoutEffect(() => {
    if (anchorVersion < 0) return;
    let measurementFrame: number | undefined;
    let correctionFrame: number | undefined;
    let stableFrameCount = 0;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    const previous = previousRowsRef.current;
    const anchor = virtualAnchorRef.current;
    if (previous !== rows) {
      const nextIndex = anchor
        ? rows.findIndex((row) => row.id === anchor.id)
        : rows.findIndex((row) => row.id === previous[0]?.id);
      const previousIndex = anchor?.index ?? 0;
      if (nextIndex >= 0 && nextIndex !== previousIndex) {
        if (anchor) {
          virtualAnchorRef.current = { ...anchor, index: nextIndex };
        }
        const element = scrollElement.current;
        const currentOffset = element?.scrollTop ?? 0;
        const mountedAnchor = element
          ? [
              ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
            ].find((node) => node.dataset.transcriptRow === anchor?.id)
          : undefined;
        const mountedOffset =
          element && mountedAnchor
            ? mountedAnchor.getBoundingClientRect().top -
              element.getBoundingClientRect().top
            : undefined;
        // Prefer the retained keyed node's real offset. The virtualizer can
        // already have compensated part of a prepend by this layout pass, so
        // blindly adding every estimate can double-adjust and clamp at tail.
        // The estimate path exists for the narrow recycled-node interval.
        if (mountedOffset !== undefined && anchor) {
          const restoreOffset = currentOffset + mountedOffset - anchor.offset;
          virtualizerRef.current.scrollToOffset(restoreOffset);
          if (element) element.scrollTop = restoreOffset;
        } else {
          // The retained row can be recycled out during the prepend commit.
          // Materialize that exact key first; the persistent correction below
          // then applies its within-row offset using measured geometry.
          virtualizerRef.current.scrollToIndex(nextIndex, { align: 'start' });
        }
        if (element && anchor) {
          const reconcileMeasuredAnchor = (): boolean => {
            const anchorNode = [
              ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
            ].find((node) => node.dataset.transcriptRow === anchor.id);
            if (!anchorNode) return false;
            const measuredOffset =
              anchorNode.getBoundingClientRect().top -
              element.getBoundingClientRect().top;
            const delta = measuredOffset - anchor.offset;
            if (Math.abs(delta) <= 0.5) return true;
            const correctedOffset = element.scrollTop + delta;
            virtualizerRef.current.scrollToOffset(correctedOffset);
            element.scrollTop = correctedOffset;
            return false;
          };
          const scheduleReconcile = () => {
            if (correctionFrame !== undefined)
              cancelAnimationFrame(correctionFrame);
            correctionFrame = requestAnimationFrame(reconcileMeasuredAnchor);
          };
          const observeMountedRows = () => {
            if (!resizeObserver) return;
            for (const node of element.querySelectorAll<HTMLElement>(
              '[data-transcript-row]',
            )) {
              resizeObserver.observe(node);
            }
          };
          // Unlike a fixed rAF count, this remains attached through the late
          // ResizeObserver deliveries that replace estimates with measured
          // markdown/tool row heights. Every delivery converges the same
          // keyed row back to its captured viewport offset.
          resizeObserver = new ResizeObserver(scheduleReconcile);
          observeMountedRows();
          mutationObserver = new MutationObserver(() => {
            observeMountedRows();
            scheduleReconcile();
          });
          mutationObserver.observe(element, { childList: true, subtree: true });
          const settleUntilStable = () => {
            stableFrameCount = reconcileMeasuredAnchor()
              ? stableFrameCount + 1
              : 0;
            // Keep the retained key active through recycled-range mounting
            // and a sustained run of stable measurement frames. Observers
            // below remain armed afterward for genuinely late content resize.
            if (stableFrameCount < 16) {
              measurementFrame = requestAnimationFrame(settleUntilStable);
            }
          };
          measurementFrame = requestAnimationFrame(settleUntilStable);
        }
      }
    }
    previousRowsRef.current = rows;
    return () => {
      if (measurementFrame !== undefined)
        cancelAnimationFrame(measurementFrame);
      if (correctionFrame !== undefined) cancelAnimationFrame(correctionFrame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [rows, anchorVersion, scrollElement]);

  // Estimates are corrected after rows enter the DOM. Scrolling to the final
  // keyed item on a new follow-tail request keeps that correction from leaving
  // the reader slightly above the latest message. The parent turns this off
  // before a reader examines earlier content.
  useLayoutEffect(() => {
    if (!scrollReady || !followTail || rows.length === 0) return;
    virtualizerRef.current.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [followTail, rows.length, scrollReady]);

  return (
    <div
      data-testid="virtualized-transcript-spacer"
      data-transcript-row-count={rows.length}
      style={{
        height: virtualizer.getTotalSize(),
        position: 'relative',
        flex: '0 0 auto',
      }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        return (
          <div
            data-index={item.index}
            data-transcript-row={row.id}
            key={item.key}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
