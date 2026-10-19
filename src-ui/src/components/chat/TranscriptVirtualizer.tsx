import {
  elementScroll,
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { markTranscriptPhase, traceKey } from './transcriptLayoutTrace';

interface VirtualTranscriptRow {
  readonly id: string;
  readonly kind: string;
}

interface TranscriptVirtualizerProps<Row extends VirtualTranscriptRow> {
  readonly rows: readonly Row[];
  readonly scrollElement: RefObject<HTMLElement | null>;
  readonly renderRow: (row: Row) => ReactNode;
  readonly onProgrammaticScroll?: (element: HTMLElement) => void;
  /** The surface has elected to keep the transcript at its newest row. */
  readonly followTail?: boolean;
  /**
   * Tail-growth signal that re-requests the end while following. Row count
   * alone cannot move it: a projected live turn grows its tail row's content
   * without adding rows (`suppressStreamingRow`, #2594).
   */
  readonly followTick?: number | string;
  /** Monotonic scroll signal from the one owning transcript surface. */
  readonly anchorVersion?: number;
  /** Stable transcript-row key requested by a route or palette result. */
  readonly revealRowId?: string;
  /** Owner-confirmed reader row and viewport offset to restore. */
  readonly restoreAnchor?: { key: string; offset: number };
  readonly restoreAnchorVersion?: number;
  /**
   * Read once, at mount: the reader's row and viewport offset when this
   * virtualizer takes over a transcript the reader is already in (the
   * surface crossing into virtualization as earlier history loads). Without
   * it the first range starts at offset 0, and attaching the scroll element
   * scrolled the reader to the top of the history.
   */
  readonly initialAnchor?: { key: string; offset: number } | null;
}

const ESTIMATED_ROW_HEIGHT: Record<string, number> = {
  'message:user': 88,
  'message:assistant': 176,
  'message:system': 64,
};

function estimatedRowHeight(row: VirtualTranscriptRow | undefined) {
  return (row && ESTIMATED_ROW_HEIGHT[row.kind]) ?? 96;
}

/** TanStack's own pre-measurement start for `index`: the sum of estimates. */
function estimatedStart(rows: readonly VirtualTranscriptRow[], index: number) {
  let start = 0;
  for (let position = 0; position < index; position += 1)
    start += estimatedRowHeight(rows[position]);
  return start;
}

/**
 * Station's replaceable DOM virtualizer boundary. The scroll container stays
 * owned by the transcript surface; this adapter contributes only spacer and
 * positioned row mechanics.
 */
export function TranscriptVirtualizer<Row extends VirtualTranscriptRow>({
  rows,
  scrollElement,
  renderRow,
  onProgrammaticScroll,
  followTail = false,
  followTick,
  anchorVersion = 0,
  revealRowId,
  restoreAnchor,
  restoreAnchorVersion,
  initialAnchor,
}: TranscriptVirtualizerProps<Row>) {
  const [scrollReady, setScrollReady] = useState(false);
  // The handed-over reader row, resolved against the rows this mount sees.
  const [mountAnchor] = useState(() => {
    if (!initialAnchor) return undefined;
    const index = rows.findIndex((row) => row.id === initialAnchor.key);
    return index < 0
      ? undefined
      : { id: initialAnchor.key, index, offset: initialAnchor.offset };
  });
  const spacerRef = useRef<HTMLDivElement>(null);
  // Mounting under an existing transcript, the rows it replaces still sit
  // where the spacer will: start from their offset, so the first range is
  // positioned where the effect below will confirm it.
  const [scrollMargin, setScrollMargin] = useState(() => {
    const container = scrollElement.current;
    const firstRow = container?.querySelector('[data-chat-message-key]');
    if (!container || !firstRow) return 0;
    return (
      firstRow.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop
    );
  });
  // The transcript can contain history controls before the virtual rows.
  // TanStack offsets include that prefix; row transforms remain spacer-relative.
  useLayoutEffect(() => {
    void rows;
    void scrollReady;
    const container = scrollElement.current;
    const spacer = spacerRef.current;
    if (!container || !spacer) return;
    setScrollMargin(
      spacer.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop,
    );
  }, [rows, scrollReady, scrollElement]);
  const virtualAnchorRef = useRef<
    { id: string; index: number; offset: number } | undefined
  >(undefined);
  // A handed-over anchor is restored like an owner's restore request (below)
  // and stands until the reader moves: the next anchor version.
  const [handoff, setHandoff] = useState(
    mountAnchor
      ? { key: mountAnchor.id, offset: mountAnchor.offset }
      : undefined,
  );
  const mountAnchorVersionRef = useRef(anchorVersion);
  useLayoutEffect(() => {
    if (handoff && anchorVersion !== mountAnchorVersionRef.current)
      setHandoff(undefined);
  }, [anchorVersion, handoff]);
  // Attaching the scroll element scrolls it to this offset (TanStack reads no
  // position before its first scroll event), so it must name where the
  // transcript already is: the handed-over row, the tail being followed, or
  // the element's own position. Evaluated once, on the first range.
  const initialOffset = () => {
    const element = scrollElement.current;
    if (!element) return 0;
    // In TanStack's own (estimated) coordinates, so the row it positions for
    // this offset is the row the reader was on, at their offset.
    if (mountAnchor)
      return Math.max(
        0,
        scrollMargin +
          estimatedStart(rows, mountAnchor.index) -
          mountAnchor.offset,
      );
    if (followTail)
      return Math.max(
        0,
        scrollMargin + estimatedStart(rows, rows.length) - element.clientHeight,
      );
    return element.scrollTop;
  };
  const scrollTo = useCallback(
    (
      offset: number,
      options: { adjustments?: number; behavior?: ScrollBehavior },
      instance: Virtualizer<HTMLElement, HTMLElement>,
    ) => {
      elementScroll(offset, options, instance);
      if (instance.scrollElement)
        onProgrammaticScroll?.(instance.scrollElement);
    },
    [onProgrammaticScroll],
  );
  const virtualizerOptions = {
    scrollToFn: scrollTo,
    count: rows.length,
    scrollMargin,
    // The element is attached as soon as it exists. On the transcript's first
    // mount it does not yet (the parent's ref attaches after this child's
    // layout effects); the `scrollReady` re-render below attaches it then.
    getScrollElement: () => scrollElement.current,
    estimateSize: (index: number) => estimatedRowHeight(rows[index]),
    getItemKey: (index: number) => rows[index]?.id ?? index,
    overscan: 8,
    initialRect: {
      width: scrollElement.current?.clientWidth || 1,
      height: scrollElement.current?.clientHeight || 600,
    },
    initialOffset,
  };
  const virtualizer = useVirtualizer(virtualizerOptions);
  // Measurements can settle several frames after a prepend (markdown,
  // expanded tool details, fonts). Keep compensating every changed row
  // strictly before the retained keyed anchor; a fixed number of rAF
  // corrections cannot prove that the final ResizeObserver has fired.
  // An INSTANCE property in @tanstack/virtual-core (3.17.11 installed), not an
  // option: passed among the options it was never read, and TanStack's
  // default (compensate every first-measured row above the fold) ran instead.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => {
    const anchor = virtualAnchorRef.current;
    // TanStack's own default rule (virtual-core 3.17.11): the fold is the
    // cached offset plus adjustments already queued in this batch; a first
    // measurement compensates any row starting above it, a re-measurement
    // only a row entirely above it and not while scrolling backward (a
    // streaming row spanning the fold grows below the reader).
    if (followTail) {
      const fold = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
      return instance.itemSizeCache.has(item.key)
        ? item.start + item.size <= fold &&
            instance.scrollDirection !== 'backward'
        : item.start < fold;
    }
    return anchor ? item.index < anchor.index : false;
  };

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const previousRowsRef = useRef(rows);
  // The rows on screen at mount are positioned from the handed-over anchor,
  // not chosen by the reader.
  const mountAnchorPendingRef = useRef(Boolean(mountAnchor));
  useLayoutEffect(() => {
    if (mountAnchor)
      markTranscriptPhase('virtualizer-mount-anchor', {
        key: traceKey(mountAnchor.id),
        index: mountAnchor.index,
      });
  }, [mountAnchor]);

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
      const size = estimatedRowHeight(candidate);
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

  // The parent host ref is attached after child layout effects. Wait until
  // the commit finishes before enabling the scroll/resize subscriptions;
  // otherwise the initial null ref permanently leaves the first range frozen.
  useEffect(() => {
    setScrollReady(scrollElement.current !== null);
    virtualizer.measure();
    markTranscriptPhase('virtualizer-scroll-ready', {
      ready: scrollElement.current !== null,
    });
  }, [scrollElement, virtualizer]);

  const revealedRowRef = useRef<string | undefined>(undefined);
  // A route anchor can point outside the rendered virtual window. Resolve its
  // row index from the bounded event window, then let the virtualizer own the
  // materialization and scroll correction instead of looking for a recycled
  // DOM node.
  useLayoutEffect(() => {
    // A cleared request forgets the last reveal, so asking for the same row
    // again (a second tap on the approval pill) scrolls to it again.
    if (!revealRowId) {
      revealedRowRef.current = undefined;
      return;
    }
    if (revealedRowRef.current === revealRowId) return;
    const index = rows.findIndex((row) => row.id === revealRowId);
    if (index < 0) return;
    virtualizerRef.current.scrollToIndex(index, { align: 'center' });
    markTranscriptPhase('virtualizer-scroll-to-index', {
      reason: 'reveal',
      index,
    });
    revealedRowRef.current = revealRowId;
  }, [revealRowId, rows]);

  const restoringHandoff = !restoreAnchor && handoff !== undefined;
  const restoreAnchorKey = (restoreAnchor ?? handoff)?.key;
  const restoreAnchorOffset = (restoreAnchor ?? handoff)?.offset;
  const restoreAnchorIndex = restoreAnchorKey
    ? rows.findIndex((row) => row.id === restoreAnchorKey)
    : -1;
  useLayoutEffect(() => {
    void restoreAnchorVersion;
    if (!restoreAnchorKey || restoreAnchorOffset === undefined) return;
    const index = restoreAnchorIndex;
    const element = scrollElement.current;
    if (index < 0 || !element) return;
    virtualAnchorRef.current = {
      id: restoreAnchorKey,
      index,
      offset: restoreAnchorOffset,
    };
    let correctionFrame: number | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    const reconcile = () => {
      const node = [
        ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
      ].find(
        (candidate) => candidate.dataset.transcriptRow === restoreAnchorKey,
      );
      if (!node) {
        virtualizerRef.current.scrollToIndex(index, { align: 'start' });
        return;
      }
      const delta =
        node.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        restoreAnchorOffset;
      if (Math.abs(delta) <= 0.5) return;
      const offset = element.scrollTop + delta;
      virtualizerRef.current.scrollToOffset(offset);
      element.scrollTop = offset;
      onProgrammaticScroll?.(element);
    };
    const schedule = () => {
      if (correctionFrame !== undefined) cancelAnimationFrame(correctionFrame);
      correctionFrame = requestAnimationFrame(reconcile);
    };
    const observeRows = () => {
      if (!resizeObserver) return;
      for (const node of element.querySelectorAll<HTMLElement>(
        '[data-transcript-row]',
      ))
        resizeObserver.observe(node);
    };
    resizeObserver = new ResizeObserver(schedule);
    mutationObserver = new MutationObserver(() => {
      observeRows();
      schedule();
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
    observeRows();
    // A handoff mounted its first range at the row already (`initialOffset`).
    if (restoringHandoff) reconcile();
    else virtualizerRef.current.scrollToIndex(index, { align: 'start' });
    schedule();
    return () => {
      if (correctionFrame !== undefined) cancelAnimationFrame(correctionFrame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [
    onProgrammaticScroll,
    restoreAnchorIndex,
    restoreAnchorKey,
    restoreAnchorOffset,
    restoreAnchorVersion,
    restoringHandoff,
    scrollElement,
  ]);

  // Capture only on the owner-confirmed reader gesture. Measurement and
  // programmatic corrections also dispatch native scroll events; listening
  // to every scroll would overwrite the user's retained offset with an
  // intermediate measured position just before a prepend.
  useLayoutEffect(() => {
    void anchorVersion;
    if (mountAnchorPendingRef.current) {
      mountAnchorPendingRef.current = false;
      return;
    }
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
          if (element) {
            element.scrollTop = restoreOffset;
            onProgrammaticScroll?.(element);
          }
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
            onProgrammaticScroll?.(element);
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
  }, [rows, anchorVersion, scrollElement, onProgrammaticScroll]);

  // Estimates are corrected after rows enter the DOM. Scrolling to the final
  // keyed item on a new follow-tail request keeps that correction from leaving
  // the reader slightly above the latest message. The parent turns this off
  // before a reader examines earlier content.
  useLayoutEffect(() => {
    void followTick;
    if (!scrollReady || !followTail || rows.length === 0) return;
    virtualizerRef.current.scrollToIndex(rows.length - 1, { align: 'end' });
    markTranscriptPhase('virtualizer-scroll-to-index', {
      reason: 'follow-tail',
      index: rows.length - 1,
    });
  }, [followTail, rows.length, scrollReady, followTick]);

  return (
    <div
      ref={spacerRef}
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
              transform: `translateY(${item.start - scrollMargin}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
